/**
 * The interactive Service Dashboard (Ink) — the CLI control plane for the
 * background daemon (portable.dev#12, PRD §3.3).
 *
 * A manual `portable` run in front of an installed/running daemon opens THIS
 * instead of taking the runtime over (PRD §11): a live, read-and-act view of the
 * REAL service. It NEVER starts a second api/tunnel — it only reads the daemon
 * over loopback (via {@link ServiceController}) and drives lifecycle actions
 * through the platform managers (PRD §13).
 *
 * ⚠️ Single Ink instance, re-rendered in place (same invariant as
 * {@link startLauncherUi}). ALL state lives in the {@link startServiceDashboard}
 * closure; {@link ServiceDashboardView} is a controlled component that renders the
 * current props and forwards keypresses to the closure's state machine, so the
 * hook order is stable across every mode. Written with `React.createElement`
 * (aliased `h`) — the launcher tsconfig has no `jsx` setting.
 */
import { Box, render, Text, useInput, type Instance } from 'ink';
import { createElement as h } from 'react';

import {
  BottomBar,
  Hr,
  Spinner,
  TopStatusBar,
  useTerminalSize,
  VerticalRule,
} from './terminalChrome.js';
import { formatRelativeTime } from './timeFormat.js';

import type {
  ServiceActionResult,
  ServiceController,
  ServiceSnapshot,
} from './ServiceController.js';

/** The overlay/mode the dashboard is in. */
export type DashboardMode = 'dashboard' | 'confirm-uninstall' | 'qr' | 'debug';

/** A fresh pairing view produced on demand (PRD §8) — wired by the dashboard host. */
export interface DashboardPairingView {
  /** The pre-rendered terminal-QR string. */
  qr: string;
  /** ISO expiry of the freshly-minted token. */
  expiresAt?: string;
  /** The ephemeral loopback fallback URL, if it came up. */
  loopbackUrl?: string;
}

/** The action ids the numbered dashboard keys map to. */
export type DashboardActionId =
  | 'qr'
  | 'start'
  | 'stop'
  | 'restart'
  | 'debug'
  | 'install'
  | 'uninstall'
  | 'back';

/** One numbered dashboard action (+ whether it is currently enabled). */
export interface DashboardAction {
  id: DashboardActionId;
  key: string;
  label: string;
  enabled: boolean;
}

/**
 * The contextual action list (PRD §3.3). Actions are enabled based on the live
 * snapshot: Start needs an installed-but-not-running service; Stop/Restart need a
 * running one; Uninstall/Debug need an install; everything is disabled while an
 * action is in flight (`busy`). Pure — unit-tested without Ink.
 */
export function buildDashboardActions(
  snapshot: ServiceSnapshot | null,
  busy: boolean
): DashboardAction[] {
  const installed = snapshot?.installed ?? false;
  const healthy = snapshot?.runtimeHealthy ?? false;
  // "Running" is authoritative on the live health probe, with the supervisor's
  // active flag as a fallback (Windows can't report active — health decides).
  const running = healthy || snapshot?.supervisorActive === true;
  const idle = !busy;
  return [
    { id: 'qr', key: '1', label: 'Show / refresh QR', enabled: idle },
    { id: 'start', key: '2', label: 'Start', enabled: idle && installed && !running },
    { id: 'stop', key: '3', label: 'Stop', enabled: idle && running },
    { id: 'restart', key: '4', label: 'Restart', enabled: idle && running },
    { id: 'debug', key: '5', label: 'Debug logs', enabled: idle && installed },
    ...(installed
      ? []
      : [
          {
            id: 'install',
            key: '6',
            label: 'Install service',
            enabled: idle,
          } satisfies DashboardAction,
        ]),
    { id: 'uninstall', key: '7', label: 'Uninstall', enabled: idle && installed },
    { id: 'back', key: 'b', label: 'Back', enabled: idle },
  ];
}

/** The headline health badge derived from the snapshot (PRD §3.3 `● HEALTHY`). */
export function deriveServiceHealth(snapshot: ServiceSnapshot | null): {
  label: string;
  color: string;
} {
  if (!snapshot || !snapshot.installed) return { label: 'NOT INSTALLED', color: 'gray' };
  if (snapshot.runtimeHealthy) {
    if (snapshot.phase === 'degraded') return { label: 'DEGRADED', color: 'yellow' };
    return { label: 'HEALTHY', color: 'green' };
  }
  // Supervisor thinks it is active but the api is not answering yet → starting.
  if (snapshot.supervisorActive === true) return { label: 'STARTING', color: 'yellow' };
  return { label: 'STOPPED', color: 'red' };
}

/** Humanize an uptime in seconds ("4h 32m", "3d 5h", "45s"). */
export function formatUptime(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** yes / no / n/a rendering for a tri-state boolean. */
function triState(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return 'n/a';
  return v ? 'Enabled' : 'Disabled';
}

/** One "Label   value" row in the details column. */
function detailRow(label: string, value: string, color = 'white'): ReturnType<typeof h> {
  return h(
    Box,
    { key: label, width: '100%' },
    h(Box, { width: 20 }, h(Text, { color: 'gray' }, label)),
    h(Text, { color }, value)
  );
}

/** The render state of the dashboard body (no input handling). */
export interface ServiceDashboardBodyProps {
  label: string;
  mode: DashboardMode;
  snapshot: ServiceSnapshot | null;
  busy: boolean;
  notice?: string;
  error?: string;
  /** The fresh pairing view when `mode === 'qr'`. */
  pairing?: DashboardPairingView | null;
  /** Recent + live debug log lines when `mode === 'debug'`. */
  debugLines?: string[];
  /** Whether the debug follow is live. */
  debugFollowing?: boolean;
  /** Diagnostics header shown above the debug log (config/log paths). */
  debugMeta?: string[];
  /** The highlighted action index (↑/↓ move it; Enter runs it). */
  selectedIndex?: number;
}

/** {@link ServiceDashboardBodyProps} + the keypress forwarder (standalone `ServiceDashboardView`). */
export interface ServiceDashboardViewProps extends ServiceDashboardBodyProps {
  /** Forward every keypress to the host's state machine. */
  onKey: (input: string, key: DashboardKey) => void;
}

/**
 * The dashboard screen — a PURE render controlled by props (no input handling).
 * `ServiceDashboardView` (standalone) wraps this with its own `useInput`; the
 * connected menu embeds THIS body directly and routes keys through its own single
 * `useInput` (PRD §3.2) — so the Services view is navigable inside the same menu.
 */
export function ServiceDashboardBody(props: ServiceDashboardBodyProps): ReturnType<typeof h> {
  const { rows, columns } = useTerminalSize();

  if (props.mode === 'qr') return h(QrOverlay, props);
  if (props.mode === 'debug') return h(DebugOverlay, props);
  if (props.mode === 'confirm-uninstall') return h(ConfirmUninstall, props);

  const s = props.snapshot;
  const health = deriveServiceHealth(s);
  const actions = buildDashboardActions(s, props.busy);
  const selectedIndex = props.selectedIndex ?? 0;
  const hrWidth = Math.max(0, columns - 2);
  const phoneConnected = (s?.devices.length ?? 0) > 0;

  // One action row in the LEFT menu — cursor + [key] + label (dimmed when disabled).
  const actionRow = (a: DashboardAction, i: number): ReturnType<typeof h> => {
    const isSel = i === selectedIndex;
    return h(
      Text,
      { key: a.id },
      h(Text, { color: isSel ? 'cyan' : 'black' }, isSel ? '› ' : '  '),
      h(Text, { color: a.enabled ? 'cyan' : 'gray', bold: true }, `[${a.key}] `),
      h(
        Text,
        { color: !a.enabled ? 'gray' : isSel ? 'whiteBright' : 'white', bold: isSel },
        a.label
      )
    );
  };

  const supervisor =
    s?.supervisorActive === null || s?.supervisorActive === undefined
      ? 'n/a'
      : s.supervisorActive
        ? 'Active'
        : 'Inactive';
  const relay = s?.relay
    ? s.relay.registered === true
      ? 'Registered'
      : s.relay.registered === false
        ? 'Not registered'
        : 'Unknown'
    : undefined;
  const tunnel = s?.tunnel
    ? `${s.tunnel.healthy === false ? 'Unhealthy' : s.tunnel.healthy === true ? 'Healthy' : 'Unknown'} · ${s.tunnel.provider}`
    : undefined;

  // The RIGHT column: the same status column the CLI home uses for chats.
  const statusRows: Array<ReturnType<typeof h> | null> = [
    detailRow('Installation', s?.installed ? 'Installed' : 'Not installed'),
    detailRow('Start automatically', triState(s?.enabled)),
    detailRow('Supervisor', supervisor),
    detailRow(
      'Runtime API',
      s?.runtimeHealthy ? `Healthy · uptime ${formatUptime(s.uptimeSeconds)}` : 'Not responding',
      s?.runtimeHealthy ? 'green' : 'red'
    ),
    relay ? detailRow('Relay', relay) : null,
    tunnel ? detailRow('Tunnel', tunnel) : null,
    detailRow(
      'Mobile devices',
      s && s.devices.length > 0 ? `${s.devices.length} connected` : 'None connected'
    ),
    detailRow('Last connection', formatRelativeTime(s?.lastConnectedAt)),
    s?.stale
      ? h(
          Text,
          { key: 'stale', color: 'yellow' },
          '  ⚠ details may be stale (daemon not responding)'
        )
      : null,
  ];

  // Same chrome as the CLI home: top bar, two columns split by a vertical rule
  // (LEFT = the service menu, RIGHT = the service status), bottom hint bar.
  return h(
    Box,
    { flexDirection: 'column', width: '100%', height: rows - 1, paddingX: 1 },
    TopStatusBar({ phoneConnected, label: props.label, phoneName: s?.devices?.[0]?.name }),
    h(Hr, { width: hrWidth }),
    h(
      Box,
      { width: '100%', flexGrow: 1, marginY: 1, flexDirection: 'row' },
      // LEFT — the service action menu (arrow-selectable).
      h(
        Box,
        { flexDirection: 'column', width: 34 },
        h(Text, { bold: true, color: 'cyan' }, 'Service'),
        h(Box, { height: 1 }),
        h(
          Box,
          { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
          ...actions.map(actionRow)
        )
      ),
      h(VerticalRule),
      // RIGHT — the service status (replaces the chats column of the home screen).
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1 },
        h(
          Box,
          { width: '100%', justifyContent: 'space-between' },
          h(Text, { bold: true, color: 'gray' }, 'Status'),
          h(Text, { bold: true, color: health.color }, `● ${health.label}`)
        ),
        h(Box, { height: 1 }),
        ...statusRows,
        h(Box, { height: 1 }),
        props.busy
          ? h(Box, {}, h(Spinner), h(Text, { color: 'gray' }, '  Working…'))
          : props.error
            ? h(Text, { color: 'red' }, `✖ ${props.error}`)
            : props.notice
              ? h(Text, { color: 'green' }, `✓ ${props.notice}`)
              : null
      )
    ),
    h(Hr, { width: hrWidth }),
    BottomBar({ left: '↑/↓ select   Enter run   b back', right: 'Ctrl-C  quit' })
  );
}

/**
 * Standalone dashboard component — wraps {@link ServiceDashboardBody} with its OWN
 * `useInput` (used by {@link startServiceDashboard}). The connected menu does NOT
 * use this; it renders {@link ServiceDashboardBody} directly and forwards keys
 * through its own single `useInput` (no nested input handlers).
 */
export function ServiceDashboardView(props: ServiceDashboardViewProps): ReturnType<typeof h> {
  useInput((input, key) => {
    props.onKey(input, {
      escape: !!key.escape,
      return: !!key.return,
      ctrl: !!key.ctrl,
      upArrow: !!key.upArrow,
      downArrow: !!key.downArrow,
    });
  });
  return h(ServiceDashboardBody, props);
}

/** The "Show / refresh pairing QR" overlay (PRD §8 fresh pairing). */
function QrOverlay(props: ServiceDashboardBodyProps): ReturnType<typeof h> {
  const p = props.pairing;
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { bold: true, color: 'cyan' }, 'Pair a device'),
    h(Text, {}, ''),
    props.busy && !p
      ? h(Box, {}, h(Spinner), h(Text, { color: 'gray' }, '  Minting a fresh pairing code…'))
      : p
        ? h(
            Box,
            { flexDirection: 'column' },
            h(Text, {}, p.qr),
            h(Text, {}, ''),
            h(
              Text,
              {},
              'Scan in the Portable app ',
              h(Text, { color: 'gray' }, '(Account → Connect a PC)')
            ),
            p.expiresAt
              ? h(Text, { color: 'gray' }, `This code expires ${formatRelativeTime(p.expiresAt)}.`)
              : null,
            p.loopbackUrl
              ? h(
                  Text,
                  { color: 'gray' },
                  "Can't scan? Open ",
                  h(Text, { color: 'cyan' }, p.loopbackUrl),
                  ' in a browser.'
                )
              : null
          )
        : h(Text, { color: 'yellow' }, props.error ?? 'Pairing code unavailable.'),
    h(Text, {}, ''),
    h(
      Text,
      { color: 'gray' },
      'Press ',
      h(Text, { color: 'cyan', bold: true }, 'r'),
      ' to refresh · ',
      h(Text, { color: 'cyan', bold: true }, 'b'),
      ' to go back'
    )
  );
}

/** The interactive debug/log overlay (PRD §9). */
function DebugOverlay(props: ServiceDashboardBodyProps): ReturnType<typeof h> {
  const { rows, columns } = useTerminalSize();
  const lines = props.debugLines ?? [];
  const meta = props.debugMeta ?? [];
  const bodyRows = Math.max(4, rows - 12);
  const window = lines.slice(-bodyRows);
  return h(
    Box,
    { flexDirection: 'column', width: '100%', height: rows - 1, paddingX: 1 },
    h(Text, { bold: true, color: 'cyan' }, 'Service diagnostics'),
    h(Text, {}, ''),
    ...meta.map((m, i) => h(Text, { key: `meta-${i}`, color: 'gray' }, m)),
    h(Text, { color: 'gray' }, '─'.repeat(Math.max(0, columns - 2))),
    ...(window.length === 0
      ? [h(Text, { key: 'empty', color: 'gray' }, 'No log lines yet…')]
      : window.map((line, i) => h(Text, { key: `l-${i}` }, line))),
    h(Text, {}, ''),
    h(
      Text,
      { color: 'gray' },
      props.debugFollowing ? '● following · ' : '○ paused · ',
      h(Text, { color: 'cyan', bold: true }, 'f'),
      ' follow · ',
      h(Text, { color: 'cyan', bold: true }, 'r'),
      ' refresh · ',
      h(Text, { color: 'cyan', bold: true }, 'b'),
      ' back'
    )
  );
}

/** The uninstall confirmation gate (PRD §3.3 "Uninstall requires confirmation"). */
function ConfirmUninstall(props: ServiceDashboardBodyProps): ReturnType<typeof h> {
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'red', paddingX: 1 },
    h(Text, { bold: true, color: 'red' }, 'Uninstall the Portable service?'),
    h(Text, {}, ''),
    h(Text, { color: 'gray' }, 'This stops the daemon and removes its auto-start definition. Your'),
    h(Text, { color: 'gray' }, 'credentials, repos, and pairing are NOT deleted.'),
    h(Text, {}, ''),
    props.busy
      ? h(Box, {}, h(Spinner), h(Text, { color: 'gray' }, '  Uninstalling…'))
      : h(
          Text,
          {},
          h(Text, { color: 'red', bold: true }, 'y'),
          h(Text, { color: 'gray' }, ' to confirm · '),
          h(Text, { color: 'cyan', bold: true }, 'n'),
          h(Text, { color: 'gray' }, ' to cancel')
        )
  );
}

/** A fresh, on-demand pairing session driving the QR overlay (PRD §8). */
export interface DashboardPairingSession {
  /** Mint a NEW token + render a fresh QR (and start the ephemeral loopback page). */
  refresh(): Promise<DashboardPairingView>;
  /** Tear down the ephemeral loopback page on leaving the QR screen. */
  close(): Promise<void>;
}

/** The log source feeding the debug overlay (PRD §9). */
export interface DashboardDebugSource {
  /** The most recent `limit` lines across the relevant logs. */
  readRecent(limit: number): Promise<string[]>;
  /** Follow appended lines live; the returned handle stops the subscription. */
  follow(onLine: (line: string) => void): { stop(): void };
  /** Diagnostic header lines (supervisor/config/log paths). */
  meta(): string[];
}

export interface StartServiceDashboardOptions {
  controller: ServiceController;
  /** Human PC label shown in the header. */
  label: string;
  /** Called when the user leaves the dashboard ([b] / Ctrl-C) — resolves the CLI wait. */
  onExit: () => void;
  /** Fresh-pairing session (PRD §8). When absent, [1] shows a "not available" notice. */
  pairing?: DashboardPairingSession;
  /** Debug log source (PRD §9). When absent, [5] shows a "not available" notice. */
  debug?: DashboardDebugSource;
  /** Snapshot poll interval (defaults to 2000ms). */
  pollMs?: number;
  /** Ink render seam (tests inject a fake returning an {@link Instance}). */
  renderImpl?: typeof render;
}

/** A running dashboard — `stop()` unmounts + tears down its timers/subscriptions. */
export interface ServiceDashboardHandle {
  stop(): void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A key event forwarded to the machine (subset of Ink's key flags the dashboard needs). */
export interface DashboardKey {
  escape: boolean;
  return: boolean;
  ctrl: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

/** The render state exposed by a {@link DashboardMachine}. */
export interface DashboardMachineState {
  mode: DashboardMode;
  snapshot: ServiceSnapshot | null;
  busy: boolean;
  notice?: string;
  error?: string;
  pairing: DashboardPairingView | null;
  debugLines: string[];
  debugMeta: string[];
  debugFollowing: boolean;
  /** Index of the highlighted action (↑/↓ move it; Enter runs it). */
  selectedIndex: number;
}

/** A framework-agnostic dashboard state machine (drives both hosts; testable without Ink). */
export interface DashboardMachine {
  getState(): DashboardMachineState;
  onKey(input: string, key: DashboardKey): void;
  /** Begin the initial snapshot load + steady poll (idempotent). */
  start(): void;
  /** Tear down timers/subscriptions (idempotent). */
  stop(): void;
}

export interface DashboardMachineDeps {
  controller: ServiceController;
  pairing?: DashboardPairingSession;
  debug?: DashboardDebugSource;
  /** Called when the user leaves the dashboard ([b] / Ctrl-C). */
  onExit: () => void;
  /** Called on every state change so the host can re-render. */
  onChange: () => void;
  /** Snapshot poll interval (defaults to 2000ms). */
  pollMs?: number;
}

/**
 * The dashboard's state machine, decoupled from Ink so it drives BOTH the
 * standalone {@link startServiceDashboard} AND the connected menu's embedded "[4]
 * Services" sub-view (PRD §3.2, same Ink instance), and is unit-tested by driving
 * {@link DashboardMachine.onKey} + inspecting {@link DashboardMachine.getState}.
 * Actions block new input while in flight (§3.3); errors surface via state, never
 * by tearing the UI down (§12.4).
 */
export function createDashboardMachine(deps: DashboardMachineDeps): DashboardMachine {
  const { controller, onExit, onChange } = deps;
  const pairingSession = deps.pairing;
  const debugSource = deps.debug;
  const pollMs = deps.pollMs ?? 2000;

  let mode: DashboardMode = 'dashboard';
  let snapshot: ServiceSnapshot | null = null;
  let busy = false;
  let notice: string | undefined;
  let error: string | undefined;
  let pairingView: DashboardPairingView | null = null;
  let debugLines: string[] = [];
  let debugMeta: string[] = [];
  let debugFollowing = false;
  let debugSub: { stop(): void } | null = null;
  let stopped = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let selectedIndex = 0;

  const refreshSnapshot = async () => {
    if (stopped) return;
    try {
      const s = await controller.getSnapshot();
      if (!stopped) {
        snapshot = s;
        onChange();
      }
    } catch {
      // A transient snapshot read failure must not tear the UI down.
    }
  };

  const runAction = async (fn: () => Promise<ServiceActionResult>) => {
    if (busy) return;
    busy = true;
    notice = undefined;
    error = undefined;
    onChange();
    try {
      const res = await fn();
      notice = res.ok ? res.message : undefined;
      error = res.ok ? undefined : (res.error ?? res.message);
      if (res.snapshot) snapshot = res.snapshot;
    } catch (err) {
      error = errMsg(err);
    } finally {
      busy = false;
      onChange();
    }
  };

  const openOrRefreshQr = async () => {
    if (!pairingSession) return;
    busy = true;
    error = undefined;
    onChange();
    try {
      pairingView = await pairingSession.refresh();
      error = undefined;
    } catch (err) {
      error = errMsg(err);
    } finally {
      busy = false;
      onChange();
    }
  };

  const openQr = () => {
    // PRD §3.3: pairing needs a healthy runtime — inform instead of minting.
    if (!snapshot?.runtimeHealthy) {
      error = 'Start the service before pairing a device.';
      notice = undefined;
      onChange();
      return;
    }
    if (!pairingSession) {
      error = 'Fresh pairing is not available in this build.';
      onChange();
      return;
    }
    mode = 'qr';
    pairingView = null;
    void openOrRefreshQr();
  };

  const closeQr = async () => {
    mode = 'dashboard';
    pairingView = null;
    onChange();
    try {
      await pairingSession?.close();
    } catch {
      // best-effort teardown of the ephemeral page
    }
  };

  const stopFollow = () => {
    debugSub?.stop();
    debugSub = null;
    debugFollowing = false;
  };

  const startFollow = () => {
    if (!debugSource || debugSub) return;
    debugFollowing = true;
    debugSub = debugSource.follow((line) => {
      if (stopped || mode !== 'debug') return;
      debugLines = [...debugLines, line].slice(-1000);
      onChange();
    });
  };

  const loadDebugRecent = async () => {
    if (!debugSource) return;
    try {
      debugLines = await debugSource.readRecent(200);
    } catch (err) {
      error = errMsg(err);
    }
    onChange();
  };

  const openDebug = () => {
    if (!debugSource) {
      error = 'The debug view is not available in this build.';
      onChange();
      return;
    }
    mode = 'debug';
    debugLines = [];
    debugMeta = debugSource.meta();
    onChange();
    void loadDebugRecent().then(() => {
      if (!stopped && mode === 'debug') startFollow();
    });
  };

  const closeDebug = () => {
    stopFollow();
    mode = 'dashboard';
    onChange();
  };

  function stop(): void {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    stopFollow();
    void pairingSession?.close().catch(() => {});
  }

  const exit = () => {
    stop();
    onExit();
  };

  /** Run the action with the given id (shared by number keys + Enter-on-selection). */
  function runActionById(id: DashboardActionId): void {
    switch (id) {
      case 'qr':
        openQr();
        break;
      case 'start':
        void runAction(() => controller.start());
        break;
      case 'stop':
        void runAction(() => controller.stop());
        break;
      case 'restart':
        void runAction(() => controller.restart());
        break;
      case 'install':
        void runAction(() => controller.install());
        break;
      case 'uninstall':
        mode = 'confirm-uninstall';
        notice = undefined;
        error = undefined;
        onChange();
        break;
      case 'debug':
        openDebug();
        break;
      case 'back':
        exit();
        break;
    }
  }

  function onKey(input: string, key: DashboardKey): void {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (mode === 'confirm-uninstall') {
      if (busy) return;
      if (input === 'y' || key.return) {
        void (async () => {
          await runAction(() => controller.uninstall());
          if (!stopped) {
            mode = 'dashboard';
            onChange();
          }
        })();
      } else if (input === 'n' || input === 'b' || key.escape) {
        mode = 'dashboard';
        onChange();
      }
      return;
    }
    if (mode === 'qr') {
      if (busy) return;
      if (input === 'r') void openOrRefreshQr();
      else if (input === 'b' || key.escape) void closeQr();
      return;
    }
    if (mode === 'debug') {
      if (input === 'f') {
        if (debugFollowing) stopFollow();
        else startFollow();
        onChange();
      } else if (input === 'r') void loadDebugRecent();
      else if (input === 'b' || key.escape) closeDebug();
      return;
    }
    // mode === 'dashboard' — arrow-select + Enter, plus the direct number keys.
    if (busy) return; // in-flight action blocks new operations (§3.3)
    const actions = buildDashboardActions(snapshot, busy);
    if (key.upArrow) {
      selectedIndex = (selectedIndex - 1 + actions.length) % actions.length;
      onChange();
      return;
    }
    if (key.downArrow) {
      selectedIndex = (selectedIndex + 1) % actions.length;
      onChange();
      return;
    }
    if (input === 'b' || key.escape) {
      exit();
      return;
    }
    if (key.return) {
      const sel = actions[selectedIndex];
      if (sel && sel.enabled) runActionById(sel.id);
      return;
    }
    const byKey = actions.find((a) => a.key === input);
    if (byKey) {
      selectedIndex = actions.indexOf(byKey);
      if (byKey.enabled) runActionById(byKey.id);
      onChange();
    }
  }

  function start(): void {
    if (stopped || pollTimer) return;
    void refreshSnapshot();
    pollTimer = setInterval(() => {
      if (!stopped && mode === 'dashboard' && !busy) void refreshSnapshot();
    }, pollMs);
    if (typeof (pollTimer as { unref?: () => void }).unref === 'function') {
      (pollTimer as { unref: () => void }).unref();
    }
  }

  return {
    getState: () => ({
      mode,
      snapshot,
      busy,
      notice,
      error,
      pairing: pairingView,
      debugLines,
      debugMeta,
      debugFollowing,
      selectedIndex,
    }),
    onKey,
    start,
    stop,
  };
}

/**
 * Mount the standalone Service Dashboard (a single Ink instance) driven by a
 * {@link createDashboardMachine}. Used by `portable`/`portable service` when a
 * service is installed and there is no interactive runtime to host the menu.
 * Errors surface inline WITHOUT unmounting Ink (PRD §12.4).
 */
export async function startServiceDashboard(
  options: StartServiceDashboardOptions
): Promise<ServiceDashboardHandle> {
  const { controller, label, onExit } = options;
  const renderImpl = options.renderImpl ?? render;

  let instance: Instance | null = null;
  const build = (): ReturnType<typeof h> =>
    h(ServiceDashboardView, { label, ...machine.getState(), onKey: machine.onKey });
  const machine = createDashboardMachine({
    controller,
    pairing: options.pairing,
    debug: options.debug,
    pollMs: options.pollMs,
    onExit,
    onChange: () => {
      if (!instance) return;
      try {
        instance.rerender(build());
      } catch {
        // non-interactive / torn down — ignore.
      }
    },
  });

  instance = renderImpl(build());
  machine.start();

  return {
    stop: () => {
      machine.stop();
      if (instance) {
        try {
          instance.unmount();
        } catch {
          // already unmounted / non-TTY — ignore.
        }
        instance = null;
      }
    },
  };
}
