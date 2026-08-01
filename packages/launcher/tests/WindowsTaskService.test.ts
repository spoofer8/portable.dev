/**
 * WindowsTaskService tests — the Windows background-service manager (`portable
 * service …`), implemented as a Scheduled Task registered from generated XML
 * (schtasks.exe can only express restart-on-failure via XML). Every effect
 * (schtasks runs, XML file writes, the runtime tree-kill) is an injected seam.
 */
import { describe, expect, it } from 'bun:test';

import {
  WINDOWS_TASK_NAME,
  WindowsTaskServiceManager,
  renderTaskXml,
  type WindowsTaskServiceDeps,
} from '../src/WindowsTaskService.js';

import type { ServiceExecSpec } from '../src/ServiceManager.js';

const EXEC: ServiceExecSpec = {
  command: 'C:\\Users\\u\\.bun\\bin\\bun.exe',
  args: ['C:\\Users\\u\\.bun\\install\\global\\cli.js', 'connect', '--service'],
  workingDirectory: 'C:\\Users\\u',
};

function harness(
  opts: { commandResults?: Record<string, { code: number; stdout?: string; stderr?: string }> } = {}
) {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const log: string[] = [];
  const ensuredDirs: string[] = [];
  let stops = 0;

  const deps: WindowsTaskServiceDeps = {
    exec: EXEC,
    userId: 'PC\\u',
    xmlPath: 'C:\\data\\portable-task.xml',
    daemonLogPath: 'C:\\data\\logs\\portable-daemon.log',
    ensureDir: (dir) => {
      ensuredDirs.push(dir);
    },
    runCommand: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      commands.push(key);
      const result = opts.commandResults?.[key];
      return {
        code: result?.code ?? 0,
        stdout: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
      };
    },
    writeFile: (p, content) => {
      files.set(p, content);
    },
    stopRunningInstance: async () => {
      stops++;
    },
    probeHealth: async () => true,
    log: (line) => log.push(line),
  };
  return { deps, commands, files, log, ensuredDirs, getStops: () => stops };
}

describe('renderTaskXml', () => {
  it('renders a logon-triggered task with restart-on-failure and no time limit', () => {
    const xml = renderTaskXml({ exec: EXEC, userId: 'PC\\u' });
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>PC\\u</UserId>');
    // Auto-restart on crash; never killed for running long.
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<Count>999</Count>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    // Laptop-friendly: don't refuse to run on battery.
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  });

  it('wraps the exec in a hidden powershell so no console window appears', () => {
    const xml = renderTaskXml({ exec: EXEC, userId: 'PC\\u' });
    expect(xml).toContain('<Command>powershell.exe</Command>');
    expect(xml).toContain('-WindowStyle Hidden');
    // The wrapped command line carries the bun binary + cli entry (XML-escaped,
    // PowerShell-single-quoted).
    expect(xml).toContain('bun.exe');
    expect(xml).toContain('cli.js');
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\u</WorkingDirectory>');
  });

  it('escapes single quotes in paths for the powershell command line', () => {
    const xml = renderTaskXml({
      exec: { ...EXEC, command: "C:\\Users\\o'brien\\bun.exe" },
      userId: 'PC\\u',
    });
    // PowerShell layer doubles the quote; the XML layer then escapes each one.
    expect(xml).toContain('o&apos;&apos;brien');
  });

  it('applies the captured operator env as $env: assignments in the wrapper', () => {
    // A logon task gets the registry env, not the shell profile's — the baked
    // PATH keeps bun/ngrok resolvable exactly like the interactive install shell.
    const xml = renderTaskXml({
      exec: {
        ...EXEC,
        env: {
          PATH: 'C:\\Users\\u\\.bun\\bin;C:\\Windows\\system32',
          PORTABLE_DATA_DIR: 'C:\\Users\\u\\.portable',
        },
      },
      userId: 'PC\\u',
    });
    expect(xml).toContain(
      '$env:PATH = &apos;C:\\Users\\u\\.bun\\bin;C:\\Windows\\system32&apos;; '
    );
    // A daemon-side re-resolve of the data dir would orphan every pairing.
    expect(xml).toContain('$env:PORTABLE_DATA_DIR = &apos;C:\\Users\\u\\.portable&apos;; ');
  });

  it('strips double quotes from captured env values (they corrupt the argv layer)', () => {
    // A quoted PATH entry embeds a raw `"` that would toggle the outer command's
    // quoting — strip it (quotes are ignored in PATH resolution anyway).
    const xml = renderTaskXml({
      exec: { ...EXEC, env: { PATH: '"C:\\Program Files\\pg\\bin";C:\\Users\\u\\.bun\\bin' } },
      userId: 'PC\\u',
    });
    expect(xml).toContain(
      '$env:PATH = &apos;C:\\Program Files\\pg\\bin;C:\\Users\\u\\.bun\\bin&apos;; '
    );
    // The ONLY double quotes are the outer -Command wrapper pair — the env value's
    // quotes were stripped, not embedded (which would toggle the argv quoting).
    expect(xml.match(/&quot;/g)?.length).toBe(2);
  });

  it('appends the daemon stdout/stderr to the log file when logPath is given', () => {
    const xml = renderTaskXml({
      exec: EXEC,
      userId: 'PC\\u',
      logPath: 'C:\\data\\logs\\portable-daemon.log',
    });
    // "2>&1 | Out-File …" XML-escaped ("2&gt;&amp;1") — early-boot errors of the
    // hidden task would otherwise vanish (parity with launchd's StandardOutPath).
    expect(xml).toContain('2&gt;&amp;1 | Out-File -Append -Encoding utf8 -FilePath');
    expect(xml).toContain('portable-daemon.log');
  });

  it('propagates bun exit code past Out-File so a crash is not recorded as success', () => {
    const xml = renderTaskXml({
      exec: EXEC,
      userId: 'PC\\u',
      logPath: 'C:\\data\\logs\\portable-daemon.log',
    });
    // Out-File is a cmdlet (exits 0); without this the daemon's crash exit is lost.
    expect(xml).toContain('; exit $LASTEXITCODE');
  });

  it('forces UTF-8 output encoding so bun output is not OEM-mojibake in the log', () => {
    const xml = renderTaskXml({
      exec: EXEC,
      userId: 'PC\\u',
      logPath: 'C:\\data\\logs\\portable-daemon.log',
    });
    expect(xml).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;');
  });

  it('self-heals the log dir on every start (Out-File dies on a missing parent)', () => {
    const xml = renderTaskXml({
      exec: EXEC,
      userId: 'PC\\u',
      logPath: 'C:\\data\\logs\\portable-daemon.log',
    });
    // New-Item -Force on the parent dir, XML-escaped, before the redirect opens it.
    expect(xml).toContain('New-Item -ItemType Directory -Force -Path &apos;C:\\data\\logs&apos;');
  });

  it('adds no preamble/redirect/exit when logPath is omitted', () => {
    const xml = renderTaskXml({ exec: EXEC, userId: 'PC\\u' });
    expect(xml).not.toContain('Out-File');
    expect(xml).not.toContain('exit $LASTEXITCODE');
    expect(xml).not.toContain('OutputEncoding');
  });
});

describe('WindowsTaskServiceManager', () => {
  it('install writes the XML, registers the task, and runs it', async () => {
    const h = harness();
    await new WindowsTaskServiceManager(h.deps).install();

    expect(h.files.get('C:\\data\\portable-task.xml')).toContain('<LogonTrigger>');
    // Out-File won't create the log dir the wrapper redirects into — install must.
    expect(h.ensuredDirs).toEqual(['C:\\data\\logs']);
    expect(h.commands).toEqual([
      `schtasks /Create /TN ${WINDOWS_TASK_NAME} /XML C:\\data\\portable-task.xml /F`,
      `schtasks /Run /TN ${WINDOWS_TASK_NAME}`,
    ]);
  });

  it('installDefinition writes the XML + registers the task WITHOUT running it', async () => {
    const h = harness();
    await new WindowsTaskServiceManager(h.deps).installDefinition();

    expect(h.files.get('C:\\data\\portable-task.xml')).toContain('<LogonTrigger>');
    expect(h.ensuredDirs).toEqual(['C:\\data\\logs']);
    // /Create only — no /Run (the interactive handoff starts it after the manual
    // runtime frees the port); a LogonTrigger task still starts at next logon.
    expect(h.commands).toEqual([
      `schtasks /Create /TN ${WINDOWS_TASK_NAME} /XML C:\\data\\portable-task.xml /F`,
    ]);
  });

  it('install surfaces a schtasks failure', async () => {
    const h = harness({
      commandResults: {
        [`schtasks /Create /TN ${WINDOWS_TASK_NAME} /XML C:\\data\\portable-task.xml /F`]: {
          code: 1,
          stderr: 'ERROR: Access is denied.',
        },
      },
    });
    await expect(new WindowsTaskServiceManager(h.deps).install()).rejects.toThrow(
      /Access is denied/
    );
  });

  it('start re-enables the task and runs it', async () => {
    const h = harness();
    await new WindowsTaskServiceManager(h.deps).start();
    expect(h.commands).toEqual([
      `schtasks /Change /TN ${WINDOWS_TASK_NAME} /ENABLE`,
      `schtasks /Run /TN ${WINDOWS_TASK_NAME}`,
    ]);
  });

  it('stop disables the task (so restart-on-failure cannot revive it), ends it, and kills the runtime', async () => {
    const h = harness();
    await new WindowsTaskServiceManager(h.deps).stop();
    expect(h.commands).toEqual([
      `schtasks /Change /TN ${WINDOWS_TASK_NAME} /DISABLE`,
      `schtasks /End /TN ${WINDOWS_TASK_NAME}`,
    ]);
    // schtasks /End only terminates the task's root process (the powershell
    // wrapper) — the bun runtime must be tree-killed explicitly.
    expect(h.getStops()).toBe(1);
  });

  it('uninstall stops then deletes the task', async () => {
    const h = harness();
    await new WindowsTaskServiceManager(h.deps).uninstall();
    expect(h.commands).toEqual([
      `schtasks /Change /TN ${WINDOWS_TASK_NAME} /DISABLE`,
      `schtasks /End /TN ${WINDOWS_TASK_NAME}`,
      `schtasks /Delete /TN ${WINDOWS_TASK_NAME} /F`,
    ]);
    expect(h.getStops()).toBe(1);
  });

  it('status reads the registered task XML (locale-safe) + the runtime health probe', async () => {
    const h = harness({
      commandResults: {
        [`schtasks /Query /TN ${WINDOWS_TASK_NAME} /XML`]: { code: 0, stdout: '<Task>…</Task>' },
      },
    });
    const status = await new WindowsTaskServiceManager(h.deps).status();
    expect(status).toEqual({ installed: true, enabled: true, active: null, runtimeHealthy: true });
  });

  it('status reports disabled from the task XML and a missing install from the query failure', async () => {
    const disabled = harness({
      commandResults: {
        [`schtasks /Query /TN ${WINDOWS_TASK_NAME} /XML`]: {
          code: 0,
          stdout: '<Task><Settings><Enabled>false</Enabled></Settings></Task>',
        },
      },
    });
    expect((await new WindowsTaskServiceManager(disabled.deps).status()).enabled).toBe(false);

    const missing = harness({
      commandResults: {
        [`schtasks /Query /TN ${WINDOWS_TASK_NAME} /XML`]: { code: 1, stderr: 'ERROR: not found' },
      },
    });
    missing.deps.probeHealth = async () => false;
    expect(await new WindowsTaskServiceManager(missing.deps).status()).toEqual({
      installed: false,
      enabled: false,
      active: null,
      runtimeHealthy: false,
    });
  });
});
