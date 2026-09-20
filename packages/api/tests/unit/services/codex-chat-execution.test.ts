import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { ChatExecutionService } from '../../../src/services/ChatExecutionService.js';
import { CodexRpcError } from '../../../src/services/CodexService/index.js';

const ORIGINAL_PRESETS = process.env.CODEX_PRESETS_JSON;

function makeHarness(
  chatOverrides: Record<string, unknown> = {},
  codexCwdValidator: (cwd: string, userId: string) => Promise<string> = async (cwd) => cwd,
  stopOnPc = mock(async () => ({ stopped: true, reason: 'stopped' }))
) {
  const bufferMessage = mock(async () => {});
  const chat = {
    id: 'chat-1',
    provider: 'codex',
    type: 'claude_code',
    title: 'Codex chat',
    status: 'completed',
    model: 'supersol',
    permissions: 'ask_each_time',
    agent_setup_id: 'freestyle',
    repo_path: '/repo',
    session_id: null,
    fork_source_session_id: null,
    ...chatOverrides,
  };
  const updateCodexForkSession = mock(async () => true);
  const chatService = {
    getChatOrigin: async () => ({ origin: 'sqlite', provider: 'codex' }),
    getChat: async () => chat,
    bufferMessage,
    saveChat: mock(async () => true),
    updateCodexForkSession,
  } as any;
  const updateChatSession = mock(async () => true);
  const dbAdapter = { updateChatSession, updateCodexForkSession } as any;
  const startCodexSession = mock(async () => ({
    chatId: 'chat-1',
    userId: 'alice@example.com',
    threadId: 'thread-1',
    cwd: '/repo',
    state: 'idle',
    updatedAt: Date.now(),
  }));
  const resumeCodexSession = mock(startCodexSession);
  const forkCodexSession = mock(startCodexSession);
  const addMessageToSession = mock(async () => ({ id: 'turn-1', status: 'inProgress' }));
  const stopSession = mock(async () => true);
  const resolvePermissionRequest = mock(() => true);
  const resolveUserInputRequest = mock(() => true);
  const getSession = mock(() => undefined);
  const releasePower = mock(() => {});
  const acquirePower = mock(() => releasePower);
  const codexService = {
    getSession,
    startCodexSession,
    resumeCodexSession,
    forkCodexSession,
    addMessageToSession,
    stopSession,
    resolvePermissionRequest,
    resolveUserInputRequest,
  } as any;
  const emitted: Array<{ event: string; data: any }> = [];
  const emitter = {
    emit: mock((event: string, data: any) => emitted.push({ event, data })),
    broadcastRuntimeStateToUser: mock(() => {}),
  } as any;
  const context = {
    chatId: 'chat-1',
    userId: 'alice@example.com',
    username: 'alice',
    authToken: 'token',
    emitter,
  } as any;
  const service = new ChatExecutionService(
    chatService,
    {} as any,
    {} as any,
    { isDuplicate: () => false, addHash: () => {} } as any,
    undefined,
    undefined,
    dbAdapter,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { stop: stopOnPc } as any,
    undefined,
    codexService,
    codexCwdValidator,
    { acquire: acquirePower } as any
  );
  return {
    service,
    context,
    emitted,
    bufferMessage,
    updateChatSession,
    updateCodexForkSession,
    startCodexSession,
    resumeCodexSession,
    forkCodexSession,
    addMessageToSession,
    stopSession,
    resolvePermissionRequest,
    resolveUserInputRequest,
    getSession,
    acquirePower,
    releasePower,
    stopOnPc,
    saveChat: chatService.saveChat,
  };
}

beforeEach(() => {
  process.env.CODEX_PRESETS_JSON = JSON.stringify({
    supersol: {
      model: 'gpt-5.6-sol',
      modelProvider: 'cliproxy',
      sandbox: 'danger-full-access',
      effort: 'ultra',
      config: { model_context_window: 1_050_000 },
    },
  });
});

afterEach(() => {
  if (ORIGINAL_PRESETS === undefined) delete process.env.CODEX_PRESETS_JSON;
  else process.env.CODEX_PRESETS_JSON = ORIGINAL_PRESETS;
});

describe('ChatExecutionService Codex routing', () => {
  it('holds power around direct executeMessage calls used by PortableSDK', async () => {
    const harness = makeHarness();

    await harness.service.executeMessage(harness.context, { content: 'Run the tests' }, {});

    expect(harness.acquirePower).toHaveBeenCalledWith('agent:execution:chat-1');
    expect(harness.acquirePower).toHaveBeenCalledWith('agent:codex:chat-1');
    expect(harness.releasePower).toHaveBeenCalledTimes(1);

    await harness.service.handleCodexStatus({
      chatId: 'chat-1',
      userId: 'alice@example.com',
      threadId: 'thread-1',
      state: 'idle',
    });

    expect(harness.releasePower).toHaveBeenCalledTimes(2);
  });

  it('releases direct-call power when execution fails', async () => {
    const harness = makeHarness({}, async () => {
      throw new Error('invalid working directory');
    });

    await expect(
      harness.service.executeMessage(harness.context, { content: 'Run the tests' }, {})
    ).rejects.toThrow('invalid working directory');

    expect(harness.releasePower).toHaveBeenCalledTimes(1);
  });

  it('starts a Codex thread with the selected preset and persists its thread id', async () => {
    const harness = makeHarness();

    await harness.service.executeMessage(
      harness.context,
      { content: 'Run the tests' },
      { model: 'supersol', permissions: 'ask_each_time' }
    );

    expect(harness.startCodexSession).toHaveBeenCalledWith(
      'chat-1',
      {
        cwd: '/repo',
        model: 'gpt-5.6-sol',
        modelProvider: 'cliproxy',
        sandbox: 'workspace-write',
        effort: 'ultra',
        config: { model_context_window: 1_050_000 },
        approvalPolicy: 'on-request',
      },
      'alice@example.com'
    );
    expect(harness.updateChatSession).toHaveBeenCalledWith(
      'chat-1',
      'alice@example.com',
      'thread-1',
      '',
      'token'
    );
    expect(harness.addMessageToSession).toHaveBeenCalledWith('chat-1', 'Run the tests', {
      cwd: '/repo',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      approvalPolicy: 'on-request',
    });
  });

  it('uses full filesystem access only after bypass permissions are selected', async () => {
    const harness = makeHarness({ permissions: 'bypass_permissions' });

    await harness.service.executeMessage(
      harness.context,
      { content: 'Run the tests' },
      { model: 'supersol', permissions: 'bypass_permissions' }
    );

    expect(harness.startCodexSession).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ sandbox: 'danger-full-access', approvalPolicy: 'never' }),
      'alice@example.com'
    );
  });

  it('revalidates the canonical working directory immediately before starting Codex', async () => {
    const harness = makeHarness({}, async () => {
      throw new Error('Codex working directory is outside the configured workspace');
    });

    await expect(
      harness.service.executeMessage(harness.context, { content: 'Run the tests' }, {})
    ).rejects.toThrow('outside the configured workspace');
    expect(harness.startCodexSession).not.toHaveBeenCalled();
  });

  it('resumes persisted Codex threads and forks claimed discovered threads', async () => {
    const resume = makeHarness({ session_id: 'thread-existing' });
    await resume.service.executeMessage(resume.context, { content: 'Resume' }, {});
    expect(resume.resumeCodexSession).toHaveBeenCalledWith(
      'chat-1',
      'thread-existing',
      expect.any(Object),
      'alice@example.com'
    );

    const fork = makeHarness({ fork_source_session_id: 'thread-source' });
    await fork.service.executeMessage(fork.context, { content: 'Fork' }, {});
    expect(fork.forkCodexSession).toHaveBeenCalledWith(
      'chat-1',
      'thread-source',
      expect.any(Object),
      'alice@example.com'
    );
  });

  it('re-stops and retries once when a confirmed interactive handoff races an active writer', async () => {
    const harness = makeHarness({ session_id: 'thread-existing' });
    harness.resumeCodexSession
      .mockRejectedValueOnce(
        new CodexRpcError('thread thread-existing already has an active writer', -32600)
      )
      .mockResolvedValueOnce({
        chatId: 'chat-1',
        userId: 'alice@example.com',
        threadId: 'thread-existing',
        cwd: '/repo',
        state: 'idle',
        updatedAt: Date.now(),
      });

    await harness.service.executeMessage(
      harness.context,
      { content: 'Resume after handoff' },
      { codexHandoffConfirmed: true }
    );

    expect(harness.stopOnPc).toHaveBeenCalledTimes(1);
    expect(harness.stopOnPc).toHaveBeenCalledWith('codex:thread-existing', 'end');
    expect(harness.resumeCodexSession).toHaveBeenCalledTimes(2);
    expect(harness.addMessageToSession).toHaveBeenCalledTimes(1);
  });

  it('forks without stopping when headless execution finds an active external writer', async () => {
    const harness = makeHarness({ session_id: 'thread-existing' });
    harness.resumeCodexSession.mockRejectedValue(
      new CodexRpcError('thread thread-existing already has an active writer', -32600)
    );

    await harness.service.executeMessage(harness.context, { content: 'Headless resume' }, {});

    expect(harness.stopOnPc).not.toHaveBeenCalled();
    expect(harness.resumeCodexSession).toHaveBeenCalledTimes(1);
    expect(harness.forkCodexSession).toHaveBeenCalledWith(
      'chat-1',
      'thread-existing',
      expect.any(Object),
      'alice@example.com'
    );
    expect(harness.updateCodexForkSession).toHaveBeenCalledWith(
      'chat-1',
      'alice@example.com',
      'thread-1',
      'thread-existing',
      'token'
    );
    expect(harness.saveChat).not.toHaveBeenCalled();
    expect(harness.updateChatSession).not.toHaveBeenCalled();
    expect(harness.addMessageToSession).toHaveBeenCalledWith(
      'chat-1',
      'Headless resume',
      expect.any(Object)
    );
  });

  it('does not retry unrelated Codex RPC failures after interactive handoff', async () => {
    const harness = makeHarness({ session_id: 'thread-existing' });
    harness.resumeCodexSession.mockRejectedValue(new CodexRpcError('invalid params', -32600));

    await expect(
      harness.service.executeMessage(
        harness.context,
        { content: 'Resume after handoff' },
        { codexHandoffConfirmed: true }
      )
    ).rejects.toThrow('invalid params');

    expect(harness.stopOnPc).not.toHaveBeenCalled();
    expect(harness.resumeCodexSession).toHaveBeenCalledTimes(1);
  });

  it('forks under the same chat id when the post-handoff retry still finds an active writer', async () => {
    const harness = makeHarness({ session_id: 'thread-existing' });
    const conflict = new CodexRpcError(
      'thread thread-existing already has an active writer',
      -32600
    );
    harness.resumeCodexSession.mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict);

    await harness.service.executeMessage(
      harness.context,
      { content: 'First attempt' },
      { codexHandoffConfirmed: true }
    );

    expect(harness.resumeCodexSession).toHaveBeenCalledTimes(2);
    expect(harness.stopOnPc).toHaveBeenCalledTimes(1);
    expect(harness.forkCodexSession).toHaveBeenCalledWith(
      'chat-1',
      'thread-existing',
      expect.any(Object),
      'alice@example.com'
    );
    expect(harness.updateCodexForkSession).toHaveBeenCalledWith(
      'chat-1',
      'alice@example.com',
      'thread-1',
      'thread-existing',
      'token'
    );
    expect(harness.saveChat).not.toHaveBeenCalled();
    expect(harness.updateChatSession).not.toHaveBeenCalled();
    expect(harness.addMessageToSession).toHaveBeenCalledWith(
      'chat-1',
      'First attempt',
      expect.any(Object)
    );
  });

  it('broadcasts and persists streams, status, and approval state on the Claude protocol', async () => {
    const harness = makeHarness();
    await harness.service.executeMessage(harness.context, { content: 'Run' }, {});

    await harness.service.handleCodexStream({
      chatId: 'chat-1',
      userId: 'alice@example.com',
      threadId: 'thread-1',
      turnId: 'turn-1',
      operation: 'append',
      block: {
        type: 'tool_use',
        blockId: 'item-1',
        id: 'item-1',
        toolName: 'Bash',
        input: { command: 'bun test' },
        timestamp: 1,
      },
    });
    await harness.service.handleCodexStream({
      chatId: 'chat-1',
      userId: 'alice@example.com',
      threadId: 'thread-1',
      turnId: 'turn-1',
      operation: 'replace',
      block: {
        type: 'tool_use',
        blockId: 'item-1',
        id: 'item-1',
        toolName: 'Bash',
        input: { command: 'bun test --coverage' },
        timestamp: 2,
      },
    });
    await harness.service.handleCodexApproval({
      approvalToken: 'opaque-token',
      generation: 1,
      requestId: 7,
      kind: 'command',
      chatId: 'chat-1',
      userId: 'alice@example.com',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'bun test' },
    });
    await harness.service.handleCodexStatus({
      chatId: 'chat-1',
      userId: 'alice@example.com',
      threadId: 'thread-1',
      state: 'idle',
    });

    expect(harness.emitted).toContainEqual({
      event: 'tool_permission_required',
      data: expect.objectContaining({
        chat_id: 'chat-1',
        request_id: 'opaque-token',
        tool_name: 'Bash',
        provider: 'codex',
      }),
    });
    expect(harness.emitted).toContainEqual({
      event: 'claude:status',
      data: { chatId: 'chat-1', provider: 'codex', status: 'idle' },
    });
    expect(harness.bufferMessage).toHaveBeenCalledWith(
      'alice@example.com',
      'chat-1',
      'assistant',
      {
        blocks: [
          expect.objectContaining({
            id: 'item-1',
            needsPermission: true,
            permissionRequestId: 'opaque-token',
            input: { command: 'bun test --coverage' },
          }),
        ],
      },
      'token'
    );
  });

  it('routes interrupts and permission decisions to Codex', async () => {
    const harness = makeHarness();
    harness.getSession.mockImplementation(() => ({
      chatId: 'chat-1',
      userId: 'alice@example.com',
      threadId: 'thread-1',
      state: 'running',
      updatedAt: 1,
    }));

    expect(
      await harness.service.handleClaudeInterrupt(harness.context, { chatId: 'chat-1' })
    ).toEqual({ success: true });
    expect(harness.stopSession).toHaveBeenCalledWith('chat-1');

    expect(
      await harness.service.handlePermissionResponse(harness.context, {
        chatId: 'chat-1',
        requestId: 'opaque-token',
        approved: true,
      })
    ).toMatchObject({ success: true });
    expect(harness.resolvePermissionRequest).toHaveBeenCalledWith(
      'opaque-token',
      'accept',
      'chat-1',
      'alice@example.com'
    );
  });

  it('routes Codex request-user-input prompts through the existing question UI', async () => {
    const harness = makeHarness();
    await harness.service.executeMessage(harness.context, { content: 'Ask me' }, {});

    await harness.service.handleCodexApproval({
      approvalToken: 'question-token',
      generation: 1,
      requestId: 'question-1',
      kind: 'userInput',
      chatId: 'chat-1',
      userId: 'alice@example.com',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'framework',
            header: 'Framework',
            question: 'Which framework?',
            options: [{ label: 'React', description: 'Use React' }],
          },
        ],
      },
    });

    expect(harness.emitted).toContainEqual({
      event: 'ask_user_question',
      data: expect.objectContaining({
        chat_id: 'chat-1',
        request_id: 'question-token',
        provider: 'codex',
      }),
    });

    await expect(
      harness.service.handleAnswerUserQuestion(harness.context, {
        chat_id: 'chat-1',
        request_id: 'question-token',
        answers: { '0': ['React'] },
      })
    ).resolves.toEqual({ success: true });
    expect(harness.resolveUserInputRequest).toHaveBeenCalledWith(
      'question-token',
      { '0': ['React'] },
      'chat-1',
      'alice@example.com'
    );
  });
});
