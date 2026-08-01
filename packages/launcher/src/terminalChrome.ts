/**
 * Shared terminal-UI chrome (Ink) — the frame every launcher screen reuses: the
 * top status bar, the bottom hint bar, section rules, a clock, a spinner, and the
 * reactive terminal size. Kept in its OWN module (imports only ink + react) so
 * BOTH `TerminalUi.ts` (the connected menu) and `ServiceDashboardUi.ts` (the
 * service dashboard, embedded INTO that menu) render the identical chrome without
 * importing each other — a value-import cycle would otherwise form.
 *
 * Written with `React.createElement` (aliased `h`) — the launcher tsconfig has no
 * `jsx` setting.
 */
import { Box, Text, useStdout } from 'ink';
import { createElement as h, useEffect, useState } from 'react';

/**
 * Reactive terminal size — re-renders the screen on resize so the layout always
 * fills the current terminal (we treat the whole terminal as our canvas).
 */
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 30,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
    stdout.on('resize', onResize);
    onResize();
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

/** A horizontal rule (section divider) of the given column width. */
export function Hr(props: { width: number; color?: string }): ReturnType<typeof h> {
  return h(Text, { color: props.color ?? 'gray' }, '─'.repeat(Math.max(0, props.width)));
}

/** A live HH:MM clock (top-bar, right side). */
export function Clock(): ReturnType<typeof h> {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    if (typeof (t as { unref?: () => void }).unref === 'function')
      (t as { unref: () => void }).unref();
    return () => clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return h(Text, { color: 'gray' }, `${hh}:${mm}`);
}

/** Truncate a string to `n` cols with an ellipsis. */
export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

/** The top status bar (PORTABLE · ● label →→ <phone> · ● CONNECTED HH:MM) — shared by screens. */
export function TopStatusBar(props: {
  phoneConnected: boolean;
  label: string;
  phoneName?: string;
}): ReturnType<typeof h> {
  const phoneColor = props.phoneConnected ? 'green' : 'red';
  // The make/model the phone self-reports (expo-device); else a plain "phone".
  const phoneName = props.phoneName?.trim() || 'phone';
  return h(
    Box,
    { width: '100%', justifyContent: 'space-between' },
    h(Text, { bold: true, color: 'whiteBright' }, 'PORTABLE'),
    // center — <PC name> →→ <phone>. The first arrow is always green (the desktop is
    // always there); the second arrow + phone name are red until a phone connects.
    h(
      Box,
      {},
      h(Text, { color: 'green' }, '● '),
      h(Text, { bold: true, color: 'green' }, props.label),
      h(Text, {}, ' '),
      h(Text, { bold: true, color: 'green' }, '→'),
      h(Text, { bold: true, color: phoneColor }, '→'),
      h(Text, {}, ' '),
      h(Text, { bold: true, color: phoneColor }, phoneName)
    ),
    // right — connection badge + clock
    h(
      Box,
      {},
      h(Text, { color: phoneColor }, `● ${props.phoneConnected ? 'CONNECTED' : 'Disconnected'}`),
      h(Text, {}, '   '),
      h(Clock)
    )
  );
}

/** The bottom context-hint bar (left hints, right quit) — shared by screens. */
export function BottomBar(props: { left: string; right: string }): ReturnType<typeof h> {
  return h(
    Box,
    { width: '100%', justifyContent: 'space-between' },
    h(Text, { color: 'gray' }, props.left),
    h(Text, { color: 'gray' }, props.right)
  );
}

/** A vertical rule that stretches to the body height (splits two-column layouts). */
export function VerticalRule(): ReturnType<typeof h> {
  return h(Box, {
    borderStyle: 'single',
    borderColor: 'gray',
    borderLeft: true,
    borderTop: false,
    borderRight: false,
    borderBottom: false,
    marginX: 2,
  });
}

/** A braille dot spinner that animates on its own timer (Ink re-renders on tick). */
export function Spinner(): ReturnType<typeof h> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    if (typeof (t as { unref?: () => void }).unref === 'function')
      (t as { unref: () => void }).unref();
    return () => clearInterval(t);
  }, []);
  return h(Text, { color: 'cyan' }, frames[frame % frames.length]);
}
