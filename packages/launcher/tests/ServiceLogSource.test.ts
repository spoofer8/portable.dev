/**
 * ServiceLogSource tests (PRD §9) — the shared log layer behind `service debug`
 * and the dashboard Debug screen. Verifies the per-platform single source,
 * recent-tail reads, and a follow subscription that releases on stop().
 */
import { describe, expect, it } from 'bun:test';

import { ServiceLogSource } from '../src/ServiceLogSource.js';
import type { followLogs } from '../src/ServiceCommands.js';

const NEWEST_API = '/data/logs/api-2026-01-02T00-00-00-000Z.log';
const DAEMON_LOG = '/data/logs/portable-daemon.log';

function make(
  platform: NodeJS.Platform,
  over: Partial<ConstructorParameters<typeof ServiceLogSource>[0]> = {}
) {
  return new ServiceLogSource({
    platform,
    daemonLogPath: DAEMON_LOG,
    logsDir: '/data/logs',
    latestApiLogPathImpl: () => NEWEST_API,
    tailFileImpl: (p, n) => [`${p}#${n}-1`, `${p}#${n}-2`],
    ...over,
  });
}

describe('ServiceLogSource.meta', () => {
  it('points at the journal + api log on Linux', () => {
    const meta = make('linux').meta();
    expect(meta.join('\n')).toContain('journalctl --user -u portable.service');
    expect(meta.join('\n')).toContain(NEWEST_API);
  });

  it('points at the daemon log + api log on macOS/Windows', () => {
    const meta = make('darwin').meta();
    expect(meta.join('\n')).toContain(DAEMON_LOG);
    expect(meta.join('\n')).toContain(NEWEST_API);
  });
});

describe('ServiceLogSource.readRecent', () => {
  it('reads the newest api log on Linux', async () => {
    expect(await make('linux').readRecent(2)).toEqual([`${NEWEST_API}#2-1`, `${NEWEST_API}#2-2`]);
  });

  it('reads the daemon log on macOS/Windows', async () => {
    expect(await make('win32').readRecent(2)).toEqual([`${DAEMON_LOG}#2-1`, `${DAEMON_LOG}#2-2`]);
  });
});

describe('ServiceLogSource.follow', () => {
  it('follows the single platform source and releases on stop()', () => {
    let captured: Parameters<typeof followLogs>[0] | null = null;
    const followImpl = (async (opts) => {
      captured = opts;
    }) as typeof followLogs;

    const received: string[] = [];
    const sub = make('darwin', { followImpl }).follow((l) => received.push(l));
    expect(captured).not.toBeNull();
    expect(captured!.resolvePaths()).toEqual([DAEMON_LOG]);
    expect(captured!.shouldContinue!()).toBe(true);

    // Lines forwarded while live.
    captured!.out('hello');
    expect(received).toEqual(['hello']);

    // stop() releases the loop and suppresses further lines.
    sub.stop();
    expect(captured!.shouldContinue!()).toBe(false);
    captured!.out('after-stop');
    expect(received).toEqual(['hello']);
  });

  it('follows the newest api log on Linux', () => {
    let captured: Parameters<typeof followLogs>[0] | null = null;
    const followImpl = (async (opts) => {
      captured = opts;
    }) as typeof followLogs;
    make('linux', { followImpl }).follow(() => {});
    expect(captured!.resolvePaths()).toEqual([NEWEST_API]);
  });
});
