import { describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';

import { PowerAssertionService } from '../../../src/services/PowerAssertionService.js';

class FakeProcess extends EventEmitter {
  killed = false;
}

interface ScheduledTimer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

const createHarness = (platform: NodeJS.Platform = 'darwin') => {
  const children: FakeProcess[] = [];
  const spawn = mock(() => {
    const child = new FakeProcess();
    children.push(child);
    return child;
  });
  const kill = mock((child: FakeProcess) => {
    child.killed = true;
  });
  const timers: ScheduledTimer[] = [];
  const setTimeout = mock((callback: () => void, delayMs: number) => {
    const timer = { callback, delayMs, cleared: false };
    timers.push(timer);
    return timer;
  });
  const clearTimeout = mock((timer: ScheduledTimer) => {
    timer.cleared = true;
  });

  const service = new PowerAssertionService({
    platform,
    pid: 4242,
    idleGraceMs: 30_000,
    restartBaseDelayMs: 100,
    restartMaxDelayMs: 400,
    spawn,
    kill,
    setTimeout,
    clearTimeout,
  });

  return { service, spawn, kill, timers, children };
};

describe('PowerAssertionService', () => {
  it('starts one macOS idle-sleep assertion when the first lease is acquired', () => {
    const { service, spawn } = createHarness();

    service.acquire('socket:one');
    service.acquire('socket:two');

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-i', '-w', '4242']);
  });

  it('reference-counts repeated leases by reason and releases after the idle grace', () => {
    const { service, kill, timers, children } = createHarness();

    service.acquire('agent:chat-1');
    service.acquire('agent:chat-1');
    service.acquire('socket:one');

    service.release('agent:chat-1');
    service.release('socket:one');
    expect(timers).toHaveLength(0);

    service.release('agent:chat-1');
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(30_000);
    expect(kill).not.toHaveBeenCalled();

    timers[0]?.callback();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(children[0]);
  });

  it('cancels a pending idle release when activity resumes', () => {
    const { service, spawn, kill, timers } = createHarness();

    const release = service.acquire('socket:one');
    release();
    service.acquire('socket:two');

    expect(timers[0]?.cleared).toBe(true);
    timers[0]?.callback();
    expect(kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('returns an idempotent lease disposer', () => {
    const { service, timers } = createHarness();

    const release = service.acquire('socket:one');
    release();
    release();

    expect(timers).toHaveLength(1);
  });

  it('does not spawn caffeinate on non-macOS hosts', () => {
    const { service, spawn, timers } = createHarness('linux');

    const release = service.acquire('socket:one');
    release();

    expect(spawn).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it('releases immediately and clears pending timers during shutdown', () => {
    const { service, kill, timers, children } = createHarness();

    const release = service.acquire('socket:one');
    release();
    service.shutdown();

    expect(timers[0]?.cleared).toBe(true);
    expect(kill).toHaveBeenCalledWith(children[0]);
  });

  it('restarts an assertion with bounded exponential backoff while leases remain', () => {
    const { service, spawn, timers, children } = createHarness();

    service.acquire('socket:one');
    children[0]?.emit('exit', 1);
    expect(timers[0]?.delayMs).toBe(100);

    timers[0]?.callback();
    children[1]?.emit('exit', 1);
    expect(timers[1]?.delayMs).toBe(200);

    timers[1]?.callback();
    children[2]?.emit('exit', 1);
    expect(timers[2]?.delayMs).toBe(400);

    timers[2]?.callback();
    children[3]?.emit('exit', 1);
    expect(timers[3]?.delayMs).toBe(400);

    timers[3]?.callback();
    expect(spawn).toHaveBeenCalledTimes(5);
  });

  it('cancels a pending restart when the final lease is released', () => {
    const { service, spawn, timers, children } = createHarness();

    const release = service.acquire('socket:one');
    children[0]?.emit('error', new Error('caffeinate failed'));
    release();

    expect(timers[0]?.cleared).toBe(true);
    timers[0]?.callback();

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
