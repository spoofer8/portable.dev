/**
 * ServiceDashboardRunner tests (PRD §3.1, §11) — the routing that opens the
 * dashboard when a service is installed, and the assembly/teardown of the
 * dashboard run. Every effect (manager, dashboard mount, pairing) is seamed.
 */
import { describe, expect, it } from 'bun:test';

import {
  isServiceInstalled,
  runServiceDashboard,
  runServiceDashboardIfInstalled,
  type ServiceDashboardRunnerDeps,
} from '../src/ServiceDashboardRunner.js';
import type { ServiceController } from '../src/ServiceController.js';
import type {
  DashboardDebugSource,
  DashboardPairingSession,
  startServiceDashboard,
} from '../src/ServiceDashboardUi.js';
import type { ServiceManager, ServiceStatus } from '../src/ServiceManager.js';

function fakeManager(status: ServiceStatus): ServiceManager {
  return {
    install: async () => {},
    uninstall: async () => {},
    start: async () => {},
    stop: async () => {},
    status: async () => status,
  };
}
const HEALTHY: ServiceStatus = {
  installed: true,
  enabled: true,
  active: true,
  runtimeHealthy: true,
};
const ABSENT: ServiceStatus = {
  installed: false,
  enabled: false,
  active: false,
  runtimeHealthy: false,
};

const NOOP_PAIRING: DashboardPairingSession = {
  refresh: async () => ({ qr: '' }),
  close: async () => {},
};
const NOOP_DEBUG: DashboardDebugSource = {
  readRecent: async () => [],
  follow: () => ({ stop() {} }),
  meta: () => [],
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('isServiceInstalled', () => {
  it('is true when installed or active, false otherwise', async () => {
    expect(
      await isServiceInstalled(['service'], {
        platform: 'darwin',
        makeManager: () => fakeManager(HEALTHY),
      })
    ).toBe(true);
    expect(
      await isServiceInstalled(['service'], {
        platform: 'darwin',
        makeManager: () => fakeManager(ABSENT),
      })
    ).toBe(false);
  });

  it('is false on an unsupported platform', async () => {
    expect(await isServiceInstalled(['service'], { platform: 'freebsd' })).toBe(false);
  });

  it('fails open (false) when status() throws (e.g. systemd-less WSL)', async () => {
    expect(
      await isServiceInstalled(['service'], {
        platform: 'linux',
        makeManager: () => ({
          ...fakeManager(ABSENT),
          status: async () => {
            throw new Error('systemctl: not found');
          },
        }),
      })
    ).toBe(false);
  });
});

describe('runServiceDashboardIfInstalled', () => {
  it('does NOT open the dashboard when nothing is installed', async () => {
    let mounted = 0;
    const startDashboard = (async () => {
      mounted++;
      return { stop() {} };
    }) as unknown as typeof startServiceDashboard;
    const res = await runServiceDashboardIfInstalled(['connect'], {
      platform: 'darwin',
      makeManager: () => fakeManager(ABSENT),
      startDashboard,
    });
    expect(res.handled).toBe(false);
    expect(mounted).toBe(0);
  });

  it('opens the dashboard when a service is installed, and tears it down on exit', async () => {
    let stopped = 0;
    let closed = 0;
    let captured: Parameters<typeof startServiceDashboard>[0] | null = null;
    const startDashboard = (async (opts: Parameters<typeof startServiceDashboard>[0]) => {
      captured = opts;
      return { stop: () => stopped++ };
    }) as unknown as typeof startServiceDashboard;
    const deps: ServiceDashboardRunnerDeps = {
      platform: 'darwin',
      makeManager: () => fakeManager(HEALTHY),
      isInteractive: () => true,
      makeController: () => ({}) as ServiceController,
      pairing: { refresh: async () => ({ qr: '' }), close: async () => void closed++ },
      debug: NOOP_DEBUG,
      startDashboard,
    };
    const p = runServiceDashboardIfInstalled(['connect'], deps);
    await tick();
    expect(captured).not.toBeNull();
    captured!.onExit(); // user leaves the dashboard
    const res = await p;
    expect(res.handled).toBe(true);
    expect(res.code).toBe(0);
    expect(stopped).toBe(1);
    expect(closed).toBeGreaterThanOrEqual(1);
  });
});

describe('runServiceDashboard non-interactive fallback', () => {
  it('degrades to the scriptable status dump when there is no TTY', async () => {
    let mounted = 0;
    const startDashboard = (async () => {
      mounted++;
      return { stop() {} };
    }) as unknown as typeof startServiceDashboard;
    const lines: string[] = [];
    const code = await runServiceDashboard(['service'], {
      platform: 'linux',
      isInteractive: () => false,
      makeManager: () => fakeManager(HEALTHY),
      out: (l) => lines.push(l),
      startDashboard,
      pairing: NOOP_PAIRING,
      debug: NOOP_DEBUG,
    });
    expect(mounted).toBe(0); // Ink dashboard NOT mounted
    expect(code).toBe(0); // healthy → status exit 0
    expect(lines.join('\n')).toContain('installed');
  });
});
