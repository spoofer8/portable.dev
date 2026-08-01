/**
 * Tiny time formatters shared by the terminal UIs. Kept in its OWN module (no
 * imports) so both `TerminalUi.ts` and `ServiceDashboardUi.ts` can use them
 * WITHOUT importing each other — the Service dashboard body is embedded inside the
 * connected menu, so a TerminalUi ↔ ServiceDashboardUi value-import cycle would
 * otherwise form.
 */

/** Humanize an ISO timestamp into a short relative string ("3m ago", "2d ago"). */
export function formatRelativeTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const sec = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return 'Yesterday';
  if (day < 30) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}
