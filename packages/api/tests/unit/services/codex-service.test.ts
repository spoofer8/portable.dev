import { describe, expect, test } from 'bun:test';

import { CodexService } from '../../../src/services/CodexService/index.js';
import type {
  CodexProcessTransport,
  CodexTransportHandlers,
} from '../../../src/services/CodexService/CodexAppServerClient.js';

class FakeTransport implements CodexProcessTransport {
  handlers: CodexTransportHandlers | null = null;
  writes: Array<Record<string, any>> = [];
  stops = 0;

  start(handlers: CodexTransportHandlers): void {
    this.handlers = handlers;
  }

  write(line: string): void {
    this.writes.push(JSON.parse(line));
  }

  stop(): void {
    this.stops += 1;
  }

  receive(message: unknown): void {
    this.handlers?.onLine(JSON.stringify(message));
  }

  exit(code: number | null = 1): void {
    this.handlers?.onExit(code, null);
  }

  take(method: string): Record<string, any> {
    const index = this.writes.findIndex((message) => message.method === method);
    expect(index).toBeGreaterThanOrEqual(0);
    return this.writes.splice(index, 1)[0]!;
  }

  reply(request: Record<string, any>, result: unknown): void {
    this.receive({ id: request.id, result });
  }
}

const waitForRequest = async (transport: FakeTransport, method: string) => {
  for (
    let attempt = 0;
    attempt < 20 && !transport.writes.some((message) => message.method === method);
    attempt += 1
  ) {
    await Promise.resolve();
  }
  return transport.take(method);
};

const startService = async (
  callbacks: ConstructorParameters<typeof CodexService>[0] = {}
): Promise<{ service: CodexService; transport: FakeTransport }> => {
  const transport = new FakeTransport();
  const service = new CodexService({ ...callbacks, transportFactory: () => transport });
  const initialized = service.initialize();
  await Promise.resolve();
  const request = transport.take('initialize');
  transport.reply(request, {
    userAgent: 'codex/0.154.0',
    codexHome: '/Users/test/.codex',
    platformFamily: 'unix',
    platformOs: 'macos',
  });
  await initialized;
  expect(transport.take('initialized')).toBeDefined();
  return { service, transport };
};

describe('CodexService thread lifecycle', () => {
  test('lists every interactive and non-interactive local thread by default', async () => {
    const { service, transport } = await startService();
    const listing = service.listThreads({ limit: 25 });
    const request = transport.take('thread/list');
    expect(request.params).toEqual({
      limit: 25,
      sourceKinds: [
        'cli',
        'vscode',
        'exec',
        'appServer',
        'subAgent',
        'subAgentReview',
        'subAgentCompact',
        'subAgentThreadSpawn',
        'subAgentOther',
        'unknown',
      ],
    });
    transport.reply(request, { data: [{ id: 'thread-1' }], nextCursor: null });
    expect(await listing).toEqual({ data: [{ id: 'thread-1' }], nextCursor: null });
  });

  test('starts, reads, resumes, and safely forks threads while retaining the raw thread id', async () => {
    const { service, transport } = await startService();

    const starting = service.startCodexSession('chat-1', {
      cwd: '/Users/test/projects/app',
      model: 'gpt-5.6-terra',
      effort: 'high',
    });
    const start = transport.take('thread/start');
    expect(start.params).toMatchObject({
      cwd: '/Users/test/projects/app',
      model: 'gpt-5.6-terra',
      config: { model_reasoning_effort: 'high' },
    });
    expect(start.params.effort).toBeUndefined();
    transport.reply(start, {
      thread: { id: 'thread-1', cwd: '/Users/test/projects/app', status: { type: 'idle' } },
    });
    expect(await starting).toMatchObject({ chatId: 'chat-1', threadId: 'thread-1', state: 'idle' });
    expect(service.getSession('chat-1')?.threadId).toBe('thread-1');

    const reading = service.readThread('thread-1', true);
    const read = transport.take('thread/read');
    expect(read.params).toEqual({ threadId: 'thread-1', includeTurns: true });
    transport.reply(read, { thread: { id: 'thread-1', turns: [] } });
    expect((await reading).thread.id).toBe('thread-1');

    const resuming = service.resumeCodexSession('chat-2', 'thread-2');
    const resume = transport.take('thread/resume');
    transport.reply(resume, { thread: { id: 'thread-2', cwd: '/repo' } });
    expect(await resuming).toMatchObject({ chatId: 'chat-2', threadId: 'thread-2' });

    const forking = service.forkCodexSession('chat-3', 'thread-2');
    const fork = transport.take('thread/fork');
    expect(fork.params).toEqual({ threadId: 'thread-2' });
    transport.reply(fork, { thread: { id: 'thread-3', cwd: '/repo', forkedFromId: 'thread-2' } });
    expect(await forking).toMatchObject({ chatId: 'chat-3', threadId: 'thread-3' });
  });

  test('carries the owning user through session listings and callbacks', async () => {
    const statuses: unknown[] = [];
    const { service, transport } = await startService({
      onStatus: (event) => statuses.push(event),
    });
    const starting = service.startCodexSession('chat-1', { cwd: '/repo' }, 'user-1');
    transport.reply(transport.take('thread/start'), { thread: { id: 'thread-1', cwd: '/repo' } });
    await starting;

    const turning = service.addMessageToSession('chat-1', 'Hello');
    transport.reply(transport.take('turn/start'), {
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });
    await turning;

    expect(service.getSessionInfos('user-1')).toEqual([
      expect.objectContaining({ chatId: 'chat-1', threadId: 'thread-1', userId: 'user-1' }),
    ]);
    expect(service.getSessionInfos('other-user')).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ chatId: 'chat-1', userId: 'user-1' });
  });

  test('archives a raw thread and removes its local session binding', async () => {
    const { service, transport } = await startService();
    const starting = service.startCodexSession('chat-1', { cwd: '/repo' });
    transport.reply(transport.take('thread/start'), { thread: { id: 'thread-1', cwd: '/repo' } });
    await starting;

    const archiving = service.archiveThread('thread-1');
    const archive = transport.take('thread/archive');
    expect(archive.params).toEqual({ threadId: 'thread-1' });
    transport.reply(archive, {});
    await archiving;
    expect(service.getSession('chat-1')).toBeUndefined();
  });

  test('unarchives a raw thread through the app-server', async () => {
    const { service, transport } = await startService();
    const unarchiving = service.unarchiveThread('thread-1');
    const request = transport.take('thread/unarchive');
    expect(request.params).toEqual({ threadId: 'thread-1' });
    transport.reply(request, {});
    await unarchiving;
  });

  test('keeps a closed thread resumable and restarts the supervised server cleanly', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const service = new CodexService({ transportFactory: () => transports.shift()! });
    const initializing = service.initialize();
    await Promise.resolve();
    first.reply(first.take('initialize'), { userAgent: 'codex/0.154.0' });
    await initializing;
    first.take('initialized');

    const starting = service.startCodexSession('chat-1', { cwd: '/repo' });
    first.reply(first.take('thread/start'), { thread: { id: 'thread-1', cwd: '/repo' } });
    await starting;
    first.receive({ method: 'thread/closed', params: { threadId: 'thread-1' } });
    expect(service.getSession('chat-1')?.state).toBe('stopped');
    expect(service.canResumeSession('chat-1')).toBe(true);

    const restarting = service.restart();
    second.reply(await waitForRequest(second, 'initialize'), { userAgent: 'codex/0.154.0' });
    await restarting;
    expect(first.stops).toBe(1);
    expect(service.canResumeSession('chat-1')).toBe(true);
  });
});

describe('CodexService turn lifecycle', () => {
  test('starts a turn, streams compatible blocks, handles approval, and returns to idle', async () => {
    const streams: unknown[] = [];
    const statuses: unknown[] = [];
    const approvals: any[] = [];
    const { service, transport } = await startService({
      onStream: (event) => streams.push(event),
      onStatus: (event) => statuses.push(event),
      onApproval: (request) => approvals.push(request),
    });
    const starting = service.startCodexSession('chat-1', { cwd: '/repo' });
    transport.reply(transport.take('thread/start'), { thread: { id: 'thread-1', cwd: '/repo' } });
    await starting;

    const turning = service.addMessageToSession('chat-1', 'Run the tests');
    const turnStart = transport.take('turn/start');
    expect(turnStart.params).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Run the tests', text_elements: [] }],
    });
    transport.reply(turnStart, { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
    await turning;
    expect(service.isSessionRunning('chat-1')).toBe(true);

    transport.receive({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-text', delta: 'Working' },
    });
    transport.receive({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-text', delta: ' now' },
    });
    transport.receive({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'commandExecution', id: 'item-cmd', command: 'bun test', cwd: '/repo' },
      },
    });
    transport.receive({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-cmd', command: 'bun test' },
    });

    expect(streams).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        operation: 'append',
        block: expect.objectContaining({ type: 'text', blockId: 'item-text', content: 'Working' }),
      }),
      expect.objectContaining({
        chatId: 'chat-1',
        operation: 'replace',
        block: expect.objectContaining({
          type: 'text',
          blockId: 'item-text',
          content: 'Working now',
        }),
      }),
      expect.objectContaining({
        chatId: 'chat-1',
        block: expect.objectContaining({
          type: 'tool_use',
          id: 'item-cmd',
          toolName: 'Bash',
          input: { command: 'bun test', cwd: '/repo' },
        }),
      }),
    ]);
    expect(approvals).toEqual([
      expect.objectContaining({
        requestId: 'approval-1',
        approvalToken: expect.any(String),
        generation: 1,
        kind: 'command',
        chatId: 'chat-1',
        threadId: 'thread-1',
      }),
    ]);
    expect(service.getSession('chat-1')?.state).toBe('waiting');
    const approvalToken = approvals[0].approvalToken;
    expect(service.resolvePermissionRequest(approvalToken, 'accept', 'another-chat')).toBe(false);
    expect(service.resolvePermissionRequest(approvalToken, 'accept', 'chat-1')).toBe(true);
    expect(transport.writes.pop()).toEqual({ id: 'approval-1', result: { decision: 'accept' } });

    transport.receive({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', items: [] },
      },
    });
    expect(service.getSession('chat-1')).toMatchObject({ state: 'idle', activeTurnId: undefined });
    expect(statuses.at(-1)).toMatchObject({ chatId: 'chat-1', state: 'idle' });
  });

  test('maps Portable question indexes back to Codex question ids', async () => {
    const approvals: any[] = [];
    const { service, transport } = await startService({
      onApproval: (approval) => approvals.push(approval),
    });
    const starting = service.startCodexSession('chat-1', { cwd: '/repo' });
    transport.reply(transport.take('thread/start'), { thread: { id: 'thread-1', cwd: '/repo' } });
    await starting;

    transport.receive({
      id: 'question-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [{ id: 'framework', header: 'Framework', question: 'Which framework?' }],
      },
    });

    expect(
      service.resolveUserInputRequest(approvals[0].approvalToken, { '0': ['React'] }, 'chat-1')
    ).toBe(true);
    expect(transport.writes.pop()).toEqual({
      id: 'question-1',
      result: { answers: { framework: { answers: ['React'] } } },
    });
  });

  test('responds to permission-profile requests with the installed schema shape', async () => {
    const approvals: any[] = [];
    const { service, transport } = await startService({
      onApproval: (approval) => approvals.push(approval),
    });
    const starting = service.startCodexSession('chat-1', {}, 'user-1');
    transport.reply(transport.take('thread/start'), { thread: { id: 'thread-1' } });
    await starting;
    const requested = {
      network: { enabled: true },
      fileSystem: { read: ['/tmp/input'], write: ['/tmp/output'] },
    };

    transport.receive({
      id: 41,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        permissions: requested,
      },
    });
    expect(
      service.resolvePermissionsRequest(
        approvals.at(-1).approvalToken,
        'acceptForSession',
        'chat-1',
        'user-1'
      )
    ).toBe(true);
    expect(transport.writes.pop()).toEqual({
      id: 41,
      result: { permissions: requested, scope: 'session' },
    });

    transport.receive({
      id: 42,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-2',
        permissions: requested,
      },
    });
    expect(
      service.resolvePermissionRequest(
        approvals.at(-1).approvalToken,
        'decline',
        'chat-1',
        'user-1'
      )
    ).toBe(true);
    expect(transport.writes.pop()).toEqual({
      id: 42,
      result: { permissions: {}, scope: 'turn' },
    });

    transport.receive({
      id: 43,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-3',
        permissions: requested,
      },
    });
    expect(
      service.resolvePermissionsRequest(
        approvals.at(-1).approvalToken,
        'cancel',
        'chat-1',
        'user-1'
      )
    ).toBe(true);
    expect(transport.writes.pop()).toEqual({
      id: 43,
      result: { permissions: {}, scope: 'turn' },
    });
  });

  test('normalizes web search and dynamic tools into generic tool blocks', async () => {
    const streams: any[] = [];
    const { service, transport } = await startService({
      onStream: (event) => streams.push(event),
    });
    const starting = service.startCodexSession('chat-1');
    transport.reply(transport.take('thread/start'), { thread: { id: 'thread-1' } });
    await starting;

    transport.receive({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'webSearch',
          id: 'search-1',
          query: 'Codex app-server',
          action: { type: 'search', query: 'Codex app-server', queries: null },
          results: null,
        },
      },
    });
    transport.receive({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'webSearch',
          id: 'search-1',
          query: 'Codex app-server',
          action: { type: 'search', query: 'Codex app-server', queries: null },
          results: [{ title: 'App Server' }],
        },
      },
    });
    transport.receive({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'dynamicToolCall',
          id: 'dynamic-1',
          namespace: 'browser',
          tool: 'search',
          arguments: { query: 'portable' },
          status: 'inProgress',
        },
      },
    });
    transport.receive({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'dynamicToolCall',
          id: 'dynamic-1',
          namespace: 'browser',
          tool: 'search',
          arguments: { query: 'portable' },
          status: 'completed',
          contentItems: [{ type: 'inputText', text: 'Found it' }],
          success: true,
        },
      },
    });

    expect(streams.map((event) => event.block)).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        id: 'search-1',
        toolName: 'WebSearch',
        input: expect.objectContaining({ query: 'Codex app-server' }),
      }),
      expect.objectContaining({
        type: 'tool_result',
        id: 'search-1',
        content: expect.objectContaining({ results: [{ title: 'App Server' }] }),
        is_error: false,
      }),
      expect.objectContaining({
        type: 'tool_use',
        id: 'dynamic-1',
        toolName: 'browser__search',
        input: { query: 'portable' },
      }),
      expect.objectContaining({
        type: 'tool_result',
        id: 'dynamic-1',
        content: expect.objectContaining({
          contentItems: [{ type: 'inputText', text: 'Found it' }],
        }),
        is_error: false,
      }),
    ]);
  });

  test('interrupts the active turn and reports whether a turn existed', async () => {
    const { service, transport } = await startService();
    const starting = service.startCodexSession('chat-1');
    transport.reply(transport.take('thread/start'), { thread: { id: 'thread-1' } });
    await starting;
    expect(await service.stopSession('chat-1')).toBe(false);

    const turning = service.addMessageToSession('chat-1', 'Wait');
    transport.reply(transport.take('turn/start'), {
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });
    await turning;
    const stopping = service.stopSession('chat-1');
    const interrupt = transport.take('turn/interrupt');
    expect(interrupt.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    transport.reply(interrupt, {});
    expect(await stopping).toBe(true);
  });

  test('rejects stale approval tokens after a process restart even when the wire id is reused', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const approvals: any[] = [];
    const service = new CodexService({
      transportFactory: () => transports.shift()!,
      onApproval: (approval) => approvals.push(approval),
    });
    const initializing = service.initialize();
    first.reply(await waitForRequest(first, 'initialize'), { userAgent: 'codex/0.154.0' });
    await initializing;
    first.take('initialized');
    const starting = service.startCodexSession('chat-1', {}, 'user-1');
    first.reply(first.take('thread/start'), { thread: { id: 'thread-1' } });
    await starting;

    first.receive({
      id: '7',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-old' },
    });
    const oldToken = approvals.at(-1).approvalToken;
    first.exit(9);

    const reinitializing = service.initialize();
    second.reply(await waitForRequest(second, 'initialize'), { userAgent: 'codex/0.154.0' });
    await reinitializing;
    second.take('initialized');
    second.receive({
      id: '7',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'item-new' },
    });
    const newToken = approvals.at(-1).approvalToken;

    expect(service.resolvePermissionRequest(oldToken, 'accept', 'chat-1', 'user-1')).toBe(false);
    expect(service.resolvePermissionRequest(newToken, 'accept', 'chat-1', 'wrong-user')).toBe(
      false
    );
    expect(service.resolvePermissionRequest(newToken, 'accept', 'chat-1', 'user-1')).toBe(true);
    expect(second.writes.pop()).toEqual({ id: '7', result: { decision: 'accept' } });
  });
});
