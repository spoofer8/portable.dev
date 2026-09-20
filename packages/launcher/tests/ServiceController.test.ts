/**
 * ServiceController tests (PRD §4/§6/§12.1) — the reusable control plane. Every
 * external effect (manager, /api/health, the cross-process stores, the manifest
 * writer) is an injected seam so no real service/network/fs is touched.
 */
import { describe, expect, it } from 'bun:test';

import { type ApiHealthBody } from '../src/ApiProcess.js';
import { type DaemonRuntimeState } from '../src/DaemonRuntimeStateStore.js';
import {
  LauncherServiceController,
  type ServiceControllerDeps,
  type SnapshotDevice,
} from '../src/ServiceController.js';
import { type ServiceManager, type ServiceStatus } from '../src/ServiceManager.js';

function fakeManager(
  status: ServiceStatus = { installed: true, enabled: true, active: true, runtimeHealthy: true },
  overrides: Partial<Record<keyof ServiceManager, () => Promise<void>>> = {}
) {
  const calls: string[] = [];
  const rec = (name: string) => async () => {
    calls.push(name);
  };
  const manager: ServiceManager = {
    install: overrides.install ?? rec('install'),
    installDefinition: overrides.installDefinition ?? rec('installDefinition'),
    uninstall: overrides.uninstall ?? rec('uninstall'),
    start: overrides.start ?? rec('start'),
    stop: overrides.stop ?? rec('stop'),
    status: async () => {
      calls.push('status');
      return status;
    },
  };
  return { manager, calls };
}

const HEALTHY_BODY: ApiHealthBody = { status: 'ok', uptime: 16_320 };

const RUNTIME: DaemonRuntimeState = {
  schemaVersion: 1,
  mode: 'service',
  phase: 'healthy',
  pid: 4242,
  startedAt: '2026-07-23T06:00:00.000Z',
  updatedAt: '2026-07-23T10:00:00.000Z',
  endpoint: 'https://relay.example/t/pc_abc',
  apiHealthy: true,
  tunnelProvider: 'cloudflare',
  tunnelHealthy: true,
  publicTunnelUrl: 'https://foo.trycloudflare.com',
  relayRegistered: true,
  lastRegisteredAt: '2026-07-23T06:00:05.000Z',
};

const DEVICES: SnapshotDevice[] = [
  { name: 'Apple iPhone 15', appVersion: '3.5.2', connectedAt: '2026-07-23T09:59:00.000Z' },
];

function baseDeps(over: Partial<ServiceControllerDeps> = {}): ServiceControllerDeps {
  const { manager } = fakeManager();
  return {
    manager,
    dataDir: '/tmp/ignored',
    fetchHealth: async () => HEALTHY_BODY,
    waitForHealthy: async () => true,
    waitForStopped: async () => true,
    readDevicePresence: () => DEVICES,
    readLastConnectedAt: () => '2026-07-23T09:59:00.000Z',
    readRuntimeState: () => RUNTIME,
    readManifest: () => null,
    isProcessAlive: () => true,
    persistManifest: () => {},
    clearInstallArtifacts: () => {},
    captureCodexEnvironment: () => {},
    clearCodexEnvironment: () => {},
    ...over,
  };
}

describe('getSnapshot', () => {
  it('aggregates manager + live health + runtime state into a full healthy snapshot', async () => {
    const snap = await new LauncherServiceController(baseDeps()).getSnapshot();
    expect(snap).toEqual({
      installed: true,
      enabled: true,
      supervisorActive: true,
      runtimeHealthy: true,
      pid: 4242,
      uptimeSeconds: 16_320,
      phase: 'healthy',
      tunnel: { provider: 'cloudflare', healthy: true, publicUrl: 'https://foo.trycloudflare.com' },
      relay: {
        endpoint: 'https://relay.example/t/pc_abc',
        registered: true,
        lastRegisteredAt: '2026-07-23T06:00:05.000Z',
      },
      devices: DEVICES,
      lastConnectedAt: '2026-07-23T09:59:00.000Z',
      lastError: undefined,
      updatedAt: '2026-07-23T10:00:00.000Z',
      stale: false,
    });
  });

  it('distinguishes installed-but-not-running (enabled/active true, runtime not healthy)', async () => {
    const { manager } = fakeManager({
      installed: true,
      enabled: true,
      active: false,
      runtimeHealthy: false,
    });
    const snap = await new LauncherServiceController(
      baseDeps({
        manager,
        fetchHealth: async () => null, // api not answering
        readRuntimeState: () => null,
      })
    ).getSnapshot();
    expect(snap.installed).toBe(true);
    expect(snap.enabled).toBe(true);
    expect(snap.supervisorActive).toBe(false);
    expect(snap.runtimeHealthy).toBe(false);
    expect(snap.devices).toEqual([]);
    expect(snap.uptimeSeconds).toBeUndefined();
    expect(snap.stale).toBe(false); // no runtime file → nothing to be stale
  });

  it('marks a runtime-state file stale (and drops devices + healthy bits) when the api is down', async () => {
    const snap = await new LauncherServiceController(
      baseDeps({
        fetchHealth: async () => null, // NOT healthy despite the file claiming healthy
        isProcessAlive: () => false, // and the recorded pid is gone
      })
    ).getSnapshot();
    expect(snap.stale).toBe(true);
    expect(snap.runtimeHealthy).toBe(false);
    expect(snap.devices).toEqual([]);
    expect(snap.pid).toBeUndefined();
    expect(snap.phase).toBeUndefined();
    // Tunnel/relay are surfaced but their "healthy"/"registered" bits are not trusted.
    expect(snap.tunnel?.healthy).toBeNull();
    expect(snap.relay?.registered).toBeNull();
  });

  it('falls back to the manifest for the relay endpoint + tunnel provider when no runtime file', async () => {
    const snap = await new LauncherServiceController(
      baseDeps({
        readRuntimeState: () => null,
        readManifest: () => ({
          schemaVersion: 1,
          installedAt: '2026-07-23T06:00:00.000Z',
          cliVersion: '3.5.2',
          platform: 'darwin',
          workingDirectory: '/Users/u/app',
          dataDir: '/Users/u/.portable',
          pcId: 'pc_abc',
          pcLabel: 'mini',
          relayBaseUrl: 'https://relay.example',
          apiPort: 4300,
          tunnelProvider: 'ngrok',
          forwardedFlags: ['--ngrok'],
        }),
      })
    ).getSnapshot();
    expect(snap.relay?.endpoint).toBe('https://relay.example/t/pc_abc');
    expect(snap.tunnel?.provider).toBe('ngrok');
  });
});

describe('lifecycle actions await the real transition (§12.1)', () => {
  it('start reports ok only when the api actually becomes healthy', async () => {
    const ok = await new LauncherServiceController(
      baseDeps({ waitForHealthy: async () => true })
    ).start();
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain('started');

    const notYet = await new LauncherServiceController(
      baseDeps({ waitForHealthy: async () => false })
    ).start();
    expect(notYet.ok).toBe(false);
    expect(notYet.message).toContain('not become healthy');
  });

  it('stop reports ok only when the api actually stops answering', async () => {
    const stopped = await new LauncherServiceController(
      baseDeps({ waitForStopped: async () => true })
    ).stop();
    expect(stopped.ok).toBe(true);

    const stuck = await new LauncherServiceController(
      baseDeps({ waitForStopped: async () => false })
    ).stop();
    expect(stuck.ok).toBe(false);
    expect(stuck.message).toContain('still answering');
  });

  it('restart runs stop then start (no singleton contention)', async () => {
    const { manager, calls } = fakeManager();
    const res = await new LauncherServiceController(
      baseDeps({
        manager,
        captureCodexEnvironment: () => calls.push('captureCodexEnvironment'),
      })
    ).restart();
    expect(res.ok).toBe(true);
    // stop before start; the trailing 'status' is getSnapshot building the result.
    expect(calls.filter((c) => c !== 'status')).toEqual([
      'captureCodexEnvironment',
      'stop',
      'start',
    ]);
  });

  it('install(start:false) registers WITHOUT starting (the handoff) and persists the manifest', async () => {
    const { manager, calls } = fakeManager();
    let persisted = 0;
    const res = await new LauncherServiceController(
      baseDeps({ manager, persistManifest: () => persisted++ })
    ).install({ start: false });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('not started');
    expect(calls).toContain('installDefinition');
    expect(calls).not.toContain('install');
    expect(persisted).toBe(1);
  });

  it('install(default) fuses install + start and waits for health', async () => {
    const { manager, calls } = fakeManager();
    const res = await new LauncherServiceController(
      baseDeps({ manager, waitForHealthy: async () => true })
    ).install();
    expect(res.ok).toBe(true);
    expect(calls).toContain('install');
    expect(calls).not.toContain('installDefinition');
  });

  it('install WITH a handoff runs installDefinition → handoff → start (§10), never the fused install', async () => {
    const order: string[] = [];
    const manager: ServiceManager = {
      install: async () => void order.push('install'),
      installDefinition: async () => void order.push('installDefinition'),
      uninstall: async () => {},
      start: async () => void order.push('start'),
      stop: async () => {},
      status: async () => ({ installed: true, enabled: true, active: true, runtimeHealthy: true }),
    };
    const res = await new LauncherServiceController(
      baseDeps({
        manager,
        waitForHealthy: async () => true,
        captureCodexEnvironment: () => void order.push('captureCodexEnvironment'),
        handoff: async () => void order.push('handoff'),
      })
    ).install();
    expect(res.ok).toBe(true);
    // The port is freed (handoff) AFTER the definition is registered but BEFORE the
    // daemon starts — and the fused `install()` is never used.
    expect(order).toEqual(['captureCodexEnvironment', 'installDefinition', 'handoff', 'start']);
    expect(order).not.toContain('install');
  });

  it('start WITH a handoff frees the port first, then starts (§10)', async () => {
    const order: string[] = [];
    const manager: ServiceManager = {
      install: async () => {},
      installDefinition: async () => {},
      uninstall: async () => {},
      start: async () => void order.push('start'),
      stop: async () => {},
      status: async () => ({
        installed: true,
        enabled: true,
        active: false,
        runtimeHealthy: false,
      }),
    };
    await new LauncherServiceController(
      baseDeps({
        manager,
        waitForHealthy: async () => true,
        captureCodexEnvironment: () => void order.push('captureCodexEnvironment'),
        handoff: async () => void order.push('handoff'),
      })
    ).start();
    expect(order).toEqual(['captureCodexEnvironment', 'handoff', 'start']);
  });

  it('uninstall clears the install artifacts', async () => {
    let cleared = 0;
    let codexCleared = 0;
    const res = await new LauncherServiceController(
      baseDeps({
        clearInstallArtifacts: () => cleared++,
        clearCodexEnvironment: () => codexCleared++,
      })
    ).uninstall();
    expect(res.ok).toBe(true);
    expect(cleared).toBe(1);
    expect(codexCleared).toBe(1);
  });

  it('reports a partial uninstall failure when the encrypted Codex snapshot cannot be deleted', async () => {
    let artifactsCleared = 0;
    const res = await new LauncherServiceController(
      baseDeps({
        clearCodexEnvironment: () => {
          throw new Error('secret store unavailable');
        },
        clearInstallArtifacts: () => artifactsCleared++,
      })
    ).uninstall();

    expect(res.ok).toBe(false);
    expect(res.message).toContain('service was removed');
    expect(res.message).toContain('Codex environment snapshot');
    expect(artifactsCleared).toBe(1);
  });

  it('surfaces a manager failure as a structured result (ok:false + error)', async () => {
    const { manager } = fakeManager(undefined, {
      start: async () => {
        throw new Error('systemctl --user start failed: unit not found');
      },
    });
    const res = await new LauncherServiceController(baseDeps({ manager })).start();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unit not found');
    expect(res.message).toContain('Start failed');
  });
});
