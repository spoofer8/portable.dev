/**
 * ServiceDashboardUi tests (PRD §3.3, §12.4) — the interactive Service Dashboard.
 * Pure helpers (contextual actions, health badge, uptime) plus the mount state
 * machine driven through the `onKey` prop captured off the rendered element (no
 * real TTY). Verifies actions route to the controller, uninstall confirms,
 * in-flight actions block input, and errors surface WITHOUT unmounting Ink.
 */
import { describe, expect, it } from 'bun:test';

import type { Instance } from 'ink';

import {
  buildDashboardActions,
  createDashboardMachine,
  deriveServiceHealth,
  formatUptime,
  startServiceDashboard,
  type DashboardPairingSession,
  type ServiceDashboardViewProps,
} from '../src/ServiceDashboardUi.js';
import type {
  ServiceActionResult,
  ServiceController,
  ServiceSnapshot,
} from '../src/ServiceController.js';

const HEALTHY: ServiceSnapshot = {
  installed: true,
  enabled: true,
  supervisorActive: true,
  runtimeHealthy: true,
  uptimeSeconds: 16_320,
  phase: 'healthy',
  devices: [],
  stale: false,
};
const STOPPED: ServiceSnapshot = {
  installed: true,
  enabled: true,
  supervisorActive: false,
  runtimeHealthy: false,
  devices: [],
  stale: false,
};

describe('buildDashboardActions (contextual, PRD §3.3)', () => {
  it('running service: Start disabled, Stop/Restart enabled', () => {
    const byId = Object.fromEntries(buildDashboardActions(HEALTHY, false).map((a) => [a.id, a]));
    expect(byId.start.enabled).toBe(false);
    expect(byId.stop.enabled).toBe(true);
    expect(byId.restart.enabled).toBe(true);
    expect(byId.uninstall.enabled).toBe(true);
  });

  it('installed but stopped: Start enabled, Stop/Restart disabled', () => {
    const byId = Object.fromEntries(buildDashboardActions(STOPPED, false).map((a) => [a.id, a]));
    expect(byId.start.enabled).toBe(true);
    expect(byId.stop.enabled).toBe(false);
    expect(byId.restart.enabled).toBe(false);
  });

  it('already installed: Install action is hidden', () => {
    for (const snapshot of [HEALTHY, STOPPED]) {
      expect(buildDashboardActions(snapshot, false).some((a) => a.id === 'install')).toBe(false);
    }
  });

  it('not installed: Uninstall/Debug disabled, Install enabled', () => {
    const notInstalled: ServiceSnapshot = { ...STOPPED, installed: false };
    const byId = Object.fromEntries(
      buildDashboardActions(notInstalled, false).map((a) => [a.id, a])
    );
    expect(byId.install.enabled).toBe(true);
    expect(byId.uninstall.enabled).toBe(false);
    expect(byId.debug.enabled).toBe(false);
    expect(byId.start.enabled).toBe(false);
  });

  it('an in-flight action disables everything (PRD §3.3)', () => {
    for (const a of buildDashboardActions(HEALTHY, true)) expect(a.enabled).toBe(false);
  });
});

describe('deriveServiceHealth', () => {
  it('maps snapshot states to badges', () => {
    expect(deriveServiceHealth(HEALTHY)).toEqual({ label: 'HEALTHY', color: 'green' });
    expect(deriveServiceHealth({ ...HEALTHY, phase: 'degraded' })).toEqual({
      label: 'DEGRADED',
      color: 'yellow',
    });
    expect(deriveServiceHealth({ ...STOPPED, supervisorActive: true })).toEqual({
      label: 'STARTING',
      color: 'yellow',
    });
    expect(deriveServiceHealth(STOPPED)).toEqual({ label: 'STOPPED', color: 'red' });
    expect(deriveServiceHealth(null)).toEqual({ label: 'NOT INSTALLED', color: 'gray' });
    expect(deriveServiceHealth({ ...STOPPED, installed: false })).toEqual({
      label: 'NOT INSTALLED',
      color: 'gray',
    });
  });
});

describe('formatUptime', () => {
  it('humanizes seconds', () => {
    expect(formatUptime(undefined)).toBe('—');
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(120)).toBe('2m');
    expect(formatUptime(16_320)).toBe('4h 32m');
    expect(formatUptime(90_000)).toBe('1d 1h');
  });
});

// ── mount state machine ──────────────────────────────────────────────────────

/** A fake Ink instance that also exposes the latest element's props (for onKey). */
function fakeInk() {
  const calls = { render: 0, rerender: 0, unmount: 0 };
  let last: { props: ServiceDashboardViewProps } | null = null;
  const renderImpl = ((el: { props: ServiceDashboardViewProps }) => {
    calls.render++;
    last = el;
    return {
      rerender: (e: { props: ServiceDashboardViewProps }) => {
        calls.rerender++;
        last = e;
      },
      unmount: () => {
        calls.unmount++;
      },
    } as unknown as Instance;
  }) as unknown as typeof import('ink').render;
  return { calls, renderImpl, props: () => last!.props };
}

function fakeController(
  snapshot: ServiceSnapshot,
  overrides: Partial<Record<keyof ServiceController, () => Promise<ServiceActionResult>>> = {}
) {
  const calls: string[] = [];
  const ok = (message: string) => async (): Promise<ServiceActionResult> => {
    calls.push(message);
    return { ok: true, message, snapshot };
  };
  const controller: ServiceController = {
    getSnapshot: async () => {
      calls.push('getSnapshot');
      return snapshot;
    },
    install: overrides.install ?? ok('install'),
    uninstall: overrides.uninstall ?? ok('uninstall'),
    start: overrides.start ?? ok('start'),
    stop: overrides.stop ?? ok('stop'),
    restart: overrides.restart ?? ok('restart'),
  };
  return { controller, calls };
}

const NO_KEY = { escape: false, return: false, ctrl: false };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('startServiceDashboard state machine', () => {
  it('renders once and starts the service when Start is pressed on a stopped daemon', async () => {
    const ink = fakeInk();
    const { controller, calls } = fakeController(STOPPED);
    const handle = await startServiceDashboard({
      controller,
      label: 'mini',
      onExit: () => {},
      pollMs: 100_000,
      renderImpl: ink.renderImpl,
    });
    await tick();
    expect(ink.calls.render).toBe(1);

    ink.props().onKey('2', NO_KEY); // Start
    await tick();
    expect(calls).toContain('start');
    handle.stop();
    expect(ink.calls.unmount).toBe(1);
  });

  it('ignores Start on a running daemon (disabled) but runs Stop', async () => {
    const ink = fakeInk();
    const { controller, calls } = fakeController(HEALTHY);
    await startServiceDashboard({
      controller,
      label: 'mini',
      onExit: () => {},
      pollMs: 100_000,
      renderImpl: ink.renderImpl,
    });
    await tick();
    ink.props().onKey('2', NO_KEY); // Start — disabled while running
    await tick();
    expect(calls).not.toContain('start');
    ink.props().onKey('3', NO_KEY); // Stop
    await tick();
    expect(calls).toContain('stop');
  });

  it('uninstall requires a confirmation (7 → y)', async () => {
    const ink = fakeInk();
    const { controller, calls } = fakeController(HEALTHY);
    await startServiceDashboard({
      controller,
      label: 'mini',
      onExit: () => {},
      pollMs: 100_000,
      renderImpl: ink.renderImpl,
    });
    await tick();
    ink.props().onKey('7', NO_KEY); // Uninstall
    await tick();
    expect(ink.props().mode).toBe('confirm-uninstall');
    expect(calls).not.toContain('uninstall'); // not yet — awaiting confirmation
    ink.props().onKey('y', NO_KEY);
    await tick();
    expect(calls).toContain('uninstall');
    expect(ink.props().mode).toBe('dashboard');
  });

  it('Back / Ctrl-C exits via onExit', async () => {
    const ink = fakeInk();
    const { controller } = fakeController(HEALTHY);
    let exited = 0;
    await startServiceDashboard({
      controller,
      label: 'mini',
      onExit: () => exited++,
      pollMs: 100_000,
      renderImpl: ink.renderImpl,
    });
    await tick();
    ink.props().onKey('b', NO_KEY);
    expect(exited).toBe(1);
  });

  it('opens a fresh QR via the pairing session when healthy', async () => {
    const ink = fakeInk();
    const { controller } = fakeController(HEALTHY);
    let refreshed = 0;
    const pairing: DashboardPairingSession = {
      refresh: async () => {
        refreshed++;
        return { qr: 'QR-DATA', expiresAt: '2026-07-26T10:00:00.000Z' };
      },
      close: async () => {},
    };
    await startServiceDashboard({
      controller,
      label: 'mini',
      onExit: () => {},
      pollMs: 100_000,
      renderImpl: ink.renderImpl,
      pairing,
    });
    await tick();
    ink.props().onKey('1', NO_KEY); // Show / refresh QR
    await tick();
    expect(ink.props().mode).toBe('qr');
    expect(refreshed).toBe(1);
    expect(ink.props().pairing?.qr).toBe('QR-DATA');
  });

  it('refuses to pair when the runtime is not healthy (informs instead)', async () => {
    const ink = fakeInk();
    const { controller } = fakeController(STOPPED);
    await startServiceDashboard({
      controller,
      label: 'mini',
      onExit: () => {},
      pollMs: 100_000,
      renderImpl: ink.renderImpl,
      pairing: { refresh: async () => ({ qr: 'x' }), close: async () => {} },
    });
    await tick();
    ink.props().onKey('1', NO_KEY);
    await tick();
    expect(ink.props().mode).toBe('dashboard');
    expect(ink.props().error).toContain('Start the service');
  });

  it('surfaces an action error inline WITHOUT unmounting Ink (PRD §12.4)', async () => {
    const ink = fakeInk();
    const { controller } = fakeController(STOPPED, {
      start: async () => ({ ok: false, message: 'Start failed: boom', error: 'boom' }),
    });
    const handle = await startServiceDashboard({
      controller,
      label: 'mini',
      onExit: () => {},
      pollMs: 100_000,
      renderImpl: ink.renderImpl,
    });
    await tick();
    ink.props().onKey('2', NO_KEY); // Start → fails
    await tick();
    expect(ink.props().error).toBe('boom');
    expect(ink.calls.unmount).toBe(0); // UI stayed mounted
    handle.stop();
  });
});

// createDashboardMachine is the framework-agnostic unit the connected menu embeds
// (PRD §3.2) — test it directly, no Ink, by driving onKey + inspecting getState.
describe('createDashboardMachine (the embeddable unit)', () => {
  it('drives lifecycle actions and reflects them in getState()', async () => {
    const { controller, calls } = fakeController(STOPPED);
    let changes = 0;
    const machine = createDashboardMachine({
      controller,
      onExit: () => {},
      onChange: () => changes++,
      pollMs: 100_000,
    });
    machine.start();
    await tick();
    expect(machine.getState().snapshot?.installed).toBe(true); // initial snapshot loaded
    expect(changes).toBeGreaterThan(0);

    machine.onKey('2', NO_KEY); // Start (enabled on a stopped daemon)
    await tick();
    expect(calls).toContain('start');

    machine.onKey('7', NO_KEY); // Uninstall → confirm gate
    expect(machine.getState().mode).toBe('confirm-uninstall');
    machine.onKey('n', NO_KEY); // cancel
    expect(machine.getState().mode).toBe('dashboard');

    machine.stop();
  });

  it('↑/↓ move the selection and Enter runs the highlighted action', async () => {
    const { controller, calls } = fakeController(STOPPED);
    const machine = createDashboardMachine({
      controller,
      onExit: () => {},
      onChange: () => {},
      pollMs: 100_000,
    });
    machine.start();
    await tick();
    expect(machine.getState().selectedIndex).toBe(0); // [1] Show/refresh QR
    machine.onKey('', { ...NO_KEY, downArrow: true }); // → [2] Start
    expect(machine.getState().selectedIndex).toBe(1);
    machine.onKey('', { ...NO_KEY, return: true }); // Enter on Start (enabled for a stopped daemon)
    await tick();
    expect(calls).toContain('start');
    machine.onKey('', { ...NO_KEY, upArrow: true }); // back to [1]
    expect(machine.getState().selectedIndex).toBe(0);
    machine.stop();
  });

  it('calls onExit when the user backs out', () => {
    const { controller } = fakeController(HEALTHY);
    let exited = 0;
    const machine = createDashboardMachine({
      controller,
      onExit: () => exited++,
      onChange: () => {},
      pollMs: 100_000,
    });
    machine.onKey('b', NO_KEY);
    expect(exited).toBe(1);
  });
});
