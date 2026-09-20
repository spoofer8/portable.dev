import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import {
  CodexAppServerClient,
  StdioCodexTransport,
  type CodexProcessTransport,
  type CodexTransportHandlers,
} from '../../../src/services/CodexService/CodexAppServerClient.js';

class FakeTransport implements CodexProcessTransport {
  handlers: CodexTransportHandlers | null = null;
  writes: string[] = [];
  starts = 0;
  stops = 0;

  async start(handlers: CodexTransportHandlers): Promise<void> {
    this.starts += 1;
    this.handlers = handlers;
  }

  write(line: string): void {
    this.writes.push(line);
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  read(index = this.writes.length - 1): Record<string, unknown> {
    return JSON.parse(this.writes[index]!) as Record<string, unknown>;
  }

  receive(message: unknown): void {
    this.handlers?.onLine(JSON.stringify(message));
  }

  receiveLine(line: string): void {
    this.handlers?.onLine(line);
  }

  exit(code: number | null = 1): void {
    this.handlers?.onExit(code, null);
  }

  fail(error: Error): void {
    this.handlers?.onError(error);
  }
}

const waitForWrites = async (transport: FakeTransport, count: number) => {
  for (let attempt = 0; attempt < 20 && transport.writes.length < count; attempt += 1) {
    await Promise.resolve();
  }
  expect(transport.writes.length).toBeGreaterThanOrEqual(count);
};

const initialize = async (client: CodexAppServerClient, transport: FakeTransport) => {
  const pending = client.initialize();
  await waitForWrites(transport, 1);
  expect(transport.read()).toMatchObject({ method: 'initialize' });
  const id = transport.read().id;
  transport.receive({ id, result: { userAgent: 'codex/0.154.0', platformFamily: 'unix' } });
  await pending;
};

describe('CodexAppServerClient', () => {
  test('performs the required initialize handshake once before requests', async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient({ transportFactory: () => transport });

    await initialize(client, transport);

    expect(transport.writes.map((line) => JSON.parse(line))).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'portable', title: 'Portable', version: '3.5.4' },
          capabilities: { experimentalApi: false },
        },
      },
      { method: 'initialized', params: {} },
    ]);

    const request = client.request('thread/read', { threadId: 'thread-1' });
    await Promise.resolve();
    const sent = transport.read();
    transport.receive({ id: sent.id, result: { thread: { id: 'thread-1' } } });
    expect(await request).toEqual({ thread: { id: 'thread-1' } });
    expect(transport.starts).toBe(1);
  });

  test('routes notifications and server approval requests independently', async () => {
    const transport = new FakeTransport();
    const notifications: unknown[] = [];
    const requests: unknown[] = [];
    const client = new CodexAppServerClient({
      transportFactory: () => transport,
      onNotification: (notification) => notifications.push(notification),
      onServerRequest: (request, generation) => requests.push({ request, generation }),
    });
    await initialize(client, transport);

    transport.receive({ method: 'turn/started', params: { threadId: 'thread-1' } });
    transport.receive({
      id: 'approval-1',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
    });

    expect(notifications).toEqual([{ method: 'turn/started', params: { threadId: 'thread-1' } }]);
    expect(requests).toEqual([
      {
        generation: 1,
        request: {
          id: 'approval-1',
          method: 'item/fileChange/requestApproval',
          params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
        },
      },
    ]);

    client.respond('approval-1', { decision: 'accept' });
    expect(transport.read()).toEqual({ id: 'approval-1', result: { decision: 'accept' } });
  });

  test('rejects in-flight work on exit and starts a fresh initialized process on the next call', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const client = new CodexAppServerClient({ transportFactory: () => transports.shift()! });
    await initialize(client, first);

    const inFlight = client.request('thread/read', { threadId: 'lost' });
    await Promise.resolve();
    first.exit(9);
    await expect(inFlight).rejects.toThrow('Codex app-server exited');

    const next = client.request('thread/read', { threadId: 'next' });
    await Promise.resolve();
    expect(second.read()).toMatchObject({ method: 'initialize' });
    second.receive({ id: second.read().id, result: { userAgent: 'codex/0.154.0' } });
    await waitForWrites(second, 2);
    expect(second.read()).toEqual({ method: 'initialized', params: {} });
    await waitForWrites(second, 3);
    const sent = second.read();
    expect(sent).toMatchObject({ method: 'thread/read', params: { threadId: 'next' } });
    second.receive({ id: sent.id, result: { thread: { id: 'next' } } });
    expect(await next).toEqual({ thread: { id: 'next' } });
  });

  test('restart stops the process, rejects pending requests, and initializes a replacement', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const client = new CodexAppServerClient({ transportFactory: () => transports.shift()! });
    await initialize(client, first);
    const pending = client.request('thread/list', {});
    await Promise.resolve();

    const restarting = client.restart();
    await expect(pending).rejects.toThrow('restarted');
    expect(first.stops).toBe(1);
    await waitForWrites(second, 1);
    expect(second.read()).toMatchObject({ method: 'initialize' });
    second.receive({ id: second.read().id, result: { userAgent: 'codex/0.154.0' } });
    await restarting;
    expect(second.read()).toEqual({ method: 'initialized', params: {} });
  });

  test('tears down a timed-out initialization before retrying with a fresh transport', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const client = new CodexAppServerClient({
      requestTimeoutMs: 5,
      transportFactory: () => transports.shift()!,
    });

    await expect(client.initialize()).rejects.toThrow('initialize');
    expect(first.stops).toBe(1);

    const retry = client.initialize();
    await waitForWrites(second, 1);
    second.receive({ id: second.read().id, result: { userAgent: 'codex/0.154.0' } });
    await retry;
    expect(second.starts).toBe(1);
  });

  test('tears down an RPC-rejected initialization before retrying', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const client = new CodexAppServerClient({ transportFactory: () => transports.shift()! });

    const failed = client.initialize();
    await waitForWrites(first, 1);
    first.receive({ id: first.read().id, error: { code: -32600, message: 'bad initialize' } });
    await expect(failed).rejects.toThrow('bad initialize');
    expect(first.stops).toBe(1);

    const retry = client.initialize();
    await waitForWrites(second, 1);
    second.receive({ id: second.read().id, result: { userAgent: 'codex/0.154.0' } });
    await retry;
    expect(second.starts).toBe(1);
  });

  test('reports malformed protocol data without exposing the raw line', async () => {
    const transport = new FakeTransport();
    const calls: unknown[][] = [];
    const client = new CodexAppServerClient({
      transportFactory: () => transport,
      onProtocolError: (...args) => calls.push(args),
    });
    await initialize(client, transport);

    transport.receiveLine('{"accessToken":"super-secret"');
    transport.receiveLine('"another-secret"');
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toHaveLength(1);
    expect(String(calls)).not.toContain('super-secret');
    expect(String(calls)).not.toContain('another-secret');
  });

  test('routes stdin EPIPE through the transport error handler', () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    const errors: Error[] = [];
    const transport = new StdioCodexTransport({}, () => child as any);
    transport.start({
      onLine: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      onError: (error) => errors.push(error),
    });

    child.stdin.emit('error', new Error('write EPIPE'));
    expect(errors.map((error) => error.message)).toEqual(['write EPIPE']);
  });

  test('starts the app-server with immediate thread unloading by default', () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    const spawns: Array<{ command: string; args: string[] }> = [];
    const transport = new StdioCodexTransport({}, (command, args) => {
      spawns.push({ command, args });
      return child as any;
    });

    transport.start({
      onLine: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      onError: () => undefined,
    });

    expect(spawns).toEqual([
      {
        command: 'codex',
        args: ['app-server', '--stdio', '-c', 'thread_unload_delay_secs=0'],
      },
    ]);
  });

  test('reports a stdin failure and following process exit only once', async () => {
    const transport = new FakeTransport();
    const failures: Error[] = [];
    const client = new CodexAppServerClient({
      transportFactory: () => transport,
      onExit: (error) => failures.push(error),
    });
    await initialize(client, transport);
    const pending = client.request('thread/list', {});

    transport.fail(new Error('write EPIPE'));
    transport.exit(1);

    await expect(pending).rejects.toThrow('EPIPE');
    expect(failures.map((error) => error.message)).toEqual(['write EPIPE']);
    expect(transport.stops).toBe(1);
  });
});
