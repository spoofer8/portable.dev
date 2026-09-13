import { randomUUID } from 'crypto';

import { CodexAppServerClient, type CodexAppServerClientOptions } from './CodexAppServerClient.js';

import type {
  CodexApprovalDecision,
  CodexApprovalPolicy,
  CodexApprovalRequest,
  CodexContentBlock,
  CodexGrantedPermissionProfile,
  CodexPermissionDecision,
  CodexSession,
  CodexSessionState,
  CodexStatusEvent,
  CodexStreamEvent,
  CodexSandboxMode,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
  CodexUserInput,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  ThreadListParams,
  ThreadListResponse,
  ThreadOperationResponse,
  ThreadSourceKind,
  ThreadStartOptions,
  TurnStartOptions,
  TurnStartResponse,
} from './types.js';

export type {
  CodexApprovalDecision,
  CodexApprovalPolicy,
  CodexApprovalRequest,
  CodexContentBlock,
  CodexGrantedPermissionProfile,
  CodexPermissionDecision,
  CodexSession,
  CodexSessionState,
  CodexStatusEvent,
  CodexStreamEvent,
  CodexSandboxMode,
  CodexThread,
  CodexTurn,
  CodexUserInput,
  ThreadListParams,
  ThreadListResponse,
  ThreadOperationResponse,
  ThreadSourceKind,
  ThreadStartOptions,
  TurnStartOptions,
  TurnStartResponse,
} from './types.js';
export {
  CodexAppServerClient,
  CodexRpcError,
  StdioCodexTransport,
} from './CodexAppServerClient.js';
export { buildCodexProcessEnv } from './processEnv.js';
export type {
  CodexAppServerClientOptions,
  CodexProcessOptions,
  CodexProcessTransport,
  CodexTransportHandlers,
  SpawnCodexProcess,
} from './CodexAppServerClient.js';

export interface CodexServiceOptions extends Omit<
  CodexAppServerClientOptions,
  'onNotification' | 'onServerRequest' | 'onExit'
> {
  onStream?: (event: CodexStreamEvent) => void;
  onStatus?: (event: CodexStatusEvent) => void;
  onApproval?: (request: CodexApprovalRequest) => void;
  onNotification?: (notification: JsonRpcNotification) => void;
  onExit?: (error: Error) => void;
  now?: () => number;
}

const approvalKind = (method: string): CodexApprovalRequest['kind'] => {
  if (method === 'item/commandExecution/requestApproval') return 'command';
  if (method === 'item/fileChange/requestApproval') return 'fileChange';
  if (method === 'item/tool/requestUserInput') return 'userInput';
  if (method === 'item/permissions/requestApproval') return 'permissions';
  return 'other';
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const ALL_THREAD_SOURCE_KINDS: ThreadSourceKind[] = [
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
];

export class CodexService {
  private readonly client: CodexAppServerClient;
  private readonly sessions = new Map<string, CodexSession>();
  private readonly chatByThreadId = new Map<string, string>();
  private readonly approvals = new Map<string, CodexApprovalRequest>();
  private readonly streamedTextItems = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly options: CodexServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.client = new CodexAppServerClient({
      ...options,
      onNotification: (notification) => {
        this.handleNotification(notification);
        options.onNotification?.(notification);
      },
      onServerRequest: (request, generation) => this.handleServerRequest(request, generation),
      onExit: (error) => {
        this.approvals.clear();
        this.streamedTextItems.clear();
        for (const session of this.sessions.values()) {
          session.state = 'stopped';
          session.activeTurnId = undefined;
          session.updatedAt = this.now();
          this.emitStatus(session);
        }
        options.onExit?.(error);
      },
    });
  }

  initialize(): Promise<unknown> {
    return this.client.initialize();
  }

  async listThreads(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    return this.client.request<ThreadListResponse>('thread/list', {
      ...params,
      sourceKinds: params.sourceKinds ?? ALL_THREAD_SOURCE_KINDS,
    });
  }

  async listAllThreads(params: Omit<ThreadListParams, 'cursor'> = {}): Promise<CodexThread[]> {
    const threads: CodexThread[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.listThreads({ ...params, cursor });
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return threads;
  }

  readThread(threadId: string, includeTurns = false): Promise<ThreadOperationResponse> {
    return this.client.request('thread/read', { threadId, includeTurns });
  }

  startThread(options: ThreadStartOptions = {}): Promise<ThreadOperationResponse> {
    return this.client.request('thread/start', this.threadParams(options));
  }

  resumeThread(
    threadId: string,
    options: ThreadStartOptions = {}
  ): Promise<ThreadOperationResponse> {
    return this.client.request('thread/resume', { ...this.threadParams(options), threadId });
  }

  forkThread(threadId: string, options: ThreadStartOptions = {}): Promise<ThreadOperationResponse> {
    return this.client.request('thread/fork', { ...this.threadParams(options), threadId });
  }

  async startCodexSession(
    chatId: string,
    options: ThreadStartOptions = {},
    userId?: string
  ): Promise<CodexSession> {
    const response = await this.startThread(options);
    return this.bindSession(chatId, response.thread, options.cwd ?? undefined, userId);
  }

  async resumeCodexSession(
    chatId: string,
    threadId: string,
    options: ThreadStartOptions = {},
    userId?: string
  ): Promise<CodexSession> {
    const response = await this.resumeThread(threadId, options);
    return this.bindSession(chatId, response.thread, options.cwd ?? undefined, userId);
  }

  async forkCodexSession(
    chatId: string,
    threadId: string,
    options: ThreadStartOptions = {},
    userId?: string
  ): Promise<CodexSession> {
    const response = await this.forkThread(threadId, options);
    return this.bindSession(chatId, response.thread, options.cwd ?? undefined, userId);
  }

  getSession(chatId: string): CodexSession | undefined {
    const session = this.sessions.get(chatId);
    return session ? { ...session } : undefined;
  }

  getAllSessions(): CodexSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  getSessionInfos(userId: string): CodexSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .map((session) => ({ ...session }));
  }

  isSessionRunning(chatId: string): boolean {
    const state = this.sessions.get(chatId)?.state;
    return state === 'running' || state === 'waiting';
  }

  canResumeSession(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    return !!session && session.state !== 'running' && session.state !== 'waiting';
  }

  async addMessageToSession(
    chatId: string,
    content: string | CodexUserInput[],
    options: TurnStartOptions = {}
  ): Promise<CodexTurn> {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`Codex session not found: ${chatId}`);
    if (session.activeTurnId)
      throw new Error(`Codex session already has an active turn: ${chatId}`);

    if (session.state === 'stopped' || session.state === 'error') {
      const resumed = await this.resumeThread(session.threadId, {
        cwd: options.cwd ?? session.cwd,
      });
      session.cwd = resumed.thread.cwd ?? session.cwd;
      session.state = 'idle';
    }

    const input = typeof content === 'string' ? [this.textInput(content)] : content;
    const response = await this.startTurn(session.threadId, input, options);
    session.activeTurnId = response.turn.id;
    session.state = 'running';
    session.lastError = undefined;
    session.updatedAt = this.now();
    this.emitStatus(session);
    return response.turn;
  }

  startTurn(
    threadId: string,
    input: CodexUserInput[],
    options: TurnStartOptions = {}
  ): Promise<TurnStartResponse> {
    return this.client.request('turn/start', { ...options, threadId, input });
  }

  interruptTurn(threadId: string, turnId: string): Promise<Record<string, never>> {
    return this.client.request('turn/interrupt', { threadId, turnId });
  }

  async stopSession(chatId: string): Promise<boolean> {
    const session = this.sessions.get(chatId);
    if (!session?.activeTurnId) return false;
    await this.interruptTurn(session.threadId, session.activeTurnId);
    return true;
  }

  resolvePermissionRequest(
    approvalToken: JsonRpcId,
    decision: CodexApprovalDecision,
    expectedChatId?: string,
    expectedUserId?: string
  ): boolean {
    const request =
      typeof approvalToken === 'string' ? this.approvals.get(approvalToken) : undefined;
    if (!this.matchesApprovalOwner(request, expectedChatId, expectedUserId)) return false;
    if (request.kind === 'permissions') {
      if (
        typeof decision !== 'string' ||
        !['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)
      ) {
        return false;
      }
      return this.resolvePermissionsRequest(
        approvalToken,
        decision as CodexPermissionDecision,
        expectedChatId,
        expectedUserId
      );
    }
    this.approvals.delete(approvalToken as string);
    this.client.respond(request.requestId, { decision });

    if (request.chatId && !this.hasApprovalForChat(request.chatId)) {
      const session = this.sessions.get(request.chatId);
      if (session?.activeTurnId) {
        session.state = 'running';
        session.updatedAt = this.now();
        this.emitStatus(session);
      }
    }
    return true;
  }

  resolvePermissionsRequest(
    approvalToken: JsonRpcId,
    decision: CodexPermissionDecision,
    expectedChatId?: string,
    expectedUserId?: string
  ): boolean {
    const request =
      typeof approvalToken === 'string' ? this.approvals.get(approvalToken) : undefined;
    if (
      !this.matchesApprovalOwner(request, expectedChatId, expectedUserId) ||
      request.kind !== 'permissions'
    ) {
      return false;
    }

    const permissions =
      decision === 'accept' || decision === 'acceptForSession'
        ? this.grantedPermissionProfile(request.params.permissions)
        : {};
    this.approvals.delete(approvalToken as string);
    this.client.respond(request.requestId, {
      permissions,
      scope: decision === 'acceptForSession' ? 'session' : 'turn',
    });
    if (request.chatId && !this.hasApprovalForChat(request.chatId)) {
      const session = this.sessions.get(request.chatId);
      if (session?.activeTurnId) this.setSessionState(session, 'running');
    }
    return true;
  }

  resolveUserInputRequest(
    approvalToken: JsonRpcId,
    answersByIndex: Record<string, string[]>,
    expectedChatId?: string,
    expectedUserId?: string
  ): boolean {
    const request =
      typeof approvalToken === 'string' ? this.approvals.get(approvalToken) : undefined;
    if (
      !this.matchesApprovalOwner(request, expectedChatId, expectedUserId) ||
      request.kind !== 'userInput'
    ) {
      return false;
    }

    const questions = Array.isArray(request.params.questions)
      ? request.params.questions.map(asRecord)
      : [];
    const answers: Record<string, { answers: string[] }> = {};
    for (const [key, values] of Object.entries(answersByIndex)) {
      const question = questions[Number(key)];
      const questionId = typeof question?.id === 'string' ? question.id : key;
      answers[questionId] = { answers: Array.isArray(values) ? values : [] };
    }

    this.approvals.delete(approvalToken as string);
    this.client.respond(request.requestId, { answers });
    if (request.chatId && !this.hasApprovalForChat(request.chatId)) {
      const session = this.sessions.get(request.chatId);
      if (session?.activeTurnId) this.setSessionState(session, 'running');
    }
    return true;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.client.request('thread/archive', { threadId });
    this.removeThreadBindings(threadId);
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.client.request('thread/unarchive', { threadId });
  }

  async restart(): Promise<unknown> {
    for (const session of this.sessions.values()) {
      session.state = 'stopped';
      session.activeTurnId = undefined;
      session.updatedAt = this.now();
      this.emitStatus(session);
    }
    this.approvals.clear();
    return this.client.restart();
  }

  shutdown(): Promise<void> {
    this.approvals.clear();
    this.streamedTextItems.clear();
    for (const session of this.sessions.values()) {
      session.state = 'stopped';
      session.activeTurnId = undefined;
      session.updatedAt = this.now();
      this.emitStatus(session);
    }
    return this.client.shutdown();
  }

  private textInput(text: string): CodexUserInput {
    return { type: 'text', text, text_elements: [] };
  }

  private threadParams(options: ThreadStartOptions): Record<string, unknown> {
    const { effort, ...params } = options;
    if (effort == null) return params;
    return {
      ...params,
      config: { ...(params.config ?? {}), model_reasoning_effort: effort },
    };
  }

  private grantedPermissionProfile(value: unknown): CodexGrantedPermissionProfile {
    const requested = asRecord(value);
    const granted: CodexGrantedPermissionProfile = {};
    if (requested.network && typeof requested.network === 'object') {
      granted.network = requested.network as Record<string, unknown>;
    }
    if (requested.fileSystem && typeof requested.fileSystem === 'object') {
      granted.fileSystem = requested.fileSystem as Record<string, unknown>;
    }
    return granted;
  }

  private bindSession(
    chatId: string,
    thread: CodexThread,
    fallbackCwd?: string,
    userId?: string
  ): CodexSession {
    const previous = this.sessions.get(chatId);
    if (previous) this.chatByThreadId.delete(previous.threadId);
    const session: CodexSession = {
      chatId,
      userId,
      threadId: thread.id,
      cwd: thread.cwd ?? fallbackCwd,
      state: this.stateFromThreadStatus(thread.status),
      updatedAt: this.now(),
    };
    this.sessions.set(chatId, session);
    this.chatByThreadId.set(thread.id, chatId);
    return { ...session };
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const params = asRecord(notification.params);
    const threadId = this.threadIdFrom(params);
    const session = threadId ? this.sessionForThread(threadId) : undefined;

    switch (notification.method) {
      case 'turn/started': {
        if (!session) return;
        const turn = asRecord(params.turn);
        session.activeTurnId = typeof turn.id === 'string' ? turn.id : undefined;
        this.setSessionState(session, 'running');
        return;
      }
      case 'turn/completed': {
        if (!session) return;
        const turn = asRecord(params.turn);
        const status = turn.status;
        session.activeTurnId = undefined;
        if (Array.isArray(turn.items)) {
          for (const item of turn.items) {
            const itemRecord = asRecord(item);
            if (typeof itemRecord.id === 'string') this.streamedTextItems.delete(itemRecord.id);
          }
        }
        if (status === 'failed') {
          const error = asRecord(turn.error);
          session.lastError =
            typeof error.message === 'string' ? error.message : 'Codex turn failed';
          this.setSessionState(session, 'error');
        } else {
          session.lastError = undefined;
          this.setSessionState(session, 'idle');
        }
        return;
      }
      case 'thread/status/changed': {
        if (!session) return;
        this.setSessionState(session, this.stateFromThreadStatus(params.status));
        return;
      }
      case 'thread/archived':
        if (threadId) this.removeThreadBindings(threadId);
        return;
      case 'thread/closed': {
        if (session) {
          session.activeTurnId = undefined;
          this.setSessionState(session, 'stopped');
        }
        return;
      }
      case 'serverRequest/resolved': {
        const requestId = params.requestId;
        if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
        const approvalEntry = [...this.approvals.entries()].find(
          ([, candidate]) =>
            candidate.generation === this.client.getGeneration() &&
            candidate.requestId === requestId
        );
        if (!approvalEntry) return;
        const [approvalToken, approval] = approvalEntry;
        this.approvals.delete(approvalToken);
        if (approval?.chatId && !this.hasApprovalForChat(approval.chatId)) {
          const approvalSession = this.sessions.get(approval.chatId);
          if (approvalSession?.activeTurnId) this.setSessionState(approvalSession, 'running');
        }
        return;
      }
      case 'error': {
        if (!session) return;
        const error = asRecord(params.error);
        session.lastError = typeof error.message === 'string' ? error.message : 'Codex error';
        this.setSessionState(session, 'error');
        return;
      }
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/reasoning/summaryTextDelta': {
        if (!session || typeof params.delta !== 'string') return;
        const itemId = typeof params.itemId === 'string' ? params.itemId : `${notification.method}`;
        const previous = this.streamedTextItems.get(itemId);
        const content = `${previous ?? ''}${params.delta}`;
        this.streamedTextItems.set(itemId, content);
        this.emitBlock(
          session,
          {
            type: 'text',
            blockId: itemId,
            content,
            text: content,
            timestamp: this.now(),
            codexItemType:
              notification.method === 'item/plan/delta'
                ? 'plan'
                : notification.method === 'item/reasoning/summaryTextDelta'
                  ? 'reasoning'
                  : 'agentMessage',
          },
          previous === undefined ? 'append' : 'replace'
        );
        return;
      }
      case 'item/started': {
        if (!session) return;
        const item = asRecord(params.item) as CodexThreadItem;
        const block = this.startedItemBlock(item);
        if (block) this.emitBlock(session, block);
        return;
      }
      case 'item/completed': {
        if (!session) return;
        const item = asRecord(params.item) as CodexThreadItem;
        const block = this.completedItemBlock(item);
        if (block) this.emitBlock(session, block);
        return;
      }
    }
  }

  private handleServerRequest(request: JsonRpcRequest, generation: number): void {
    const params = asRecord(request.params);
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const chatId = threadId ? this.chatByThreadId.get(threadId) : undefined;
    const approvalToken = randomUUID();
    const approval: CodexApprovalRequest = {
      approvalToken,
      generation,
      requestId: request.id,
      kind: approvalKind(request.method),
      chatId,
      userId: chatId ? this.sessions.get(chatId)?.userId : undefined,
      threadId,
      turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
      itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
      method: request.method,
      params,
    };
    this.approvals.set(approvalToken, approval);
    if (chatId) {
      const session = this.sessions.get(chatId);
      if (session) this.setSessionState(session, 'waiting');
    }
    this.options.onApproval?.(approval);
  }

  private startedItemBlock(item: CodexThreadItem): CodexContentBlock | null {
    if (item.type === 'commandExecution') {
      return this.toolUseBlock(item, 'Bash', { command: item.command, cwd: item.cwd });
    }
    if (item.type === 'fileChange') {
      return this.toolUseBlock(item, 'ApplyPatch', { changes: item.changes });
    }
    if (item.type === 'mcpToolCall') {
      return this.toolUseBlock(
        item,
        `mcp__${String(item.server)}__${String(item.tool)}`,
        item.arguments
      );
    }
    if (item.type === 'collabAgentToolCall') {
      return this.toolUseBlock(item, String(item.tool), item);
    }
    if (item.type === 'webSearch') {
      return this.toolUseBlock(item, 'WebSearch', {
        query: item.query,
        action: item.action,
      });
    }
    if (item.type === 'dynamicToolCall') {
      const toolName = item.namespace
        ? `${String(item.namespace)}__${String(item.tool)}`
        : String(item.tool);
      return this.toolUseBlock(item, toolName, item.arguments);
    }
    return null;
  }

  private completedItemBlock(item: CodexThreadItem): CodexContentBlock | null {
    if (item.type === 'agentMessage' && !this.streamedTextItems.has(item.id)) {
      const text = typeof item.text === 'string' ? item.text : '';
      return {
        type: 'text',
        blockId: item.id,
        content: text,
        text,
        timestamp: this.now(),
        codexItemType: item.type,
      };
    }
    if (
      item.type !== 'commandExecution' &&
      item.type !== 'fileChange' &&
      item.type !== 'mcpToolCall' &&
      item.type !== 'collabAgentToolCall' &&
      item.type !== 'webSearch' &&
      item.type !== 'dynamicToolCall'
    ) {
      return null;
    }
    const failed =
      item.status === 'failed' ||
      item.status === 'declined' ||
      item.error != null ||
      (item.type === 'dynamicToolCall' && item.success === false);
    return {
      type: 'tool_result',
      blockId: `${item.id}:result`,
      id: item.id,
      content:
        item.type === 'commandExecution'
          ? { output: item.aggregatedOutput, exitCode: item.exitCode, durationMs: item.durationMs }
          : item.type === 'fileChange'
            ? { changes: item.changes, status: item.status }
            : item.type === 'webSearch'
              ? { query: item.query, action: item.action, results: item.results }
              : item.type === 'dynamicToolCall'
                ? {
                    contentItems: item.contentItems,
                    success: item.success,
                    status: item.status,
                  }
                : { result: item.result, error: item.error, status: item.status },
      is_error: failed,
      timestamp: this.now(),
      codexItemType: item.type,
    };
  }

  private toolUseBlock(item: CodexThreadItem, toolName: string, input: unknown): CodexContentBlock {
    return {
      type: 'tool_use',
      blockId: item.id,
      id: item.id,
      toolName,
      input,
      timestamp: this.now(),
      codexItemType: item.type,
    };
  }

  private emitBlock(
    session: CodexSession,
    block: CodexContentBlock,
    operation: CodexStreamEvent['operation'] = 'append'
  ): void {
    this.options.onStream?.({
      chatId: session.chatId,
      userId: session.userId,
      threadId: session.threadId,
      turnId: session.activeTurnId,
      operation,
      block,
    });
  }

  private emitStatus(session: CodexSession): void {
    this.options.onStatus?.({
      chatId: session.chatId,
      userId: session.userId,
      threadId: session.threadId,
      state: session.state,
      turnId: session.activeTurnId,
      error: session.lastError,
    });
  }

  private setSessionState(session: CodexSession, state: CodexSessionState): void {
    session.state = state;
    session.updatedAt = this.now();
    this.emitStatus(session);
  }

  private stateFromThreadStatus(status: unknown): CodexSessionState {
    const record = asRecord(status);
    if (record.type === 'active') {
      const flags = Array.isArray(record.activeFlags) ? record.activeFlags : [];
      return flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')
        ? 'waiting'
        : 'running';
    }
    if (record.type === 'systemError') return 'error';
    if (record.type === 'notLoaded') return 'stopped';
    return 'idle';
  }

  private threadIdFrom(params: Record<string, unknown>): string | undefined {
    if (typeof params.threadId === 'string') return params.threadId;
    const thread = asRecord(params.thread);
    return typeof thread.id === 'string' ? thread.id : undefined;
  }

  private sessionForThread(threadId: string): CodexSession | undefined {
    const chatId = this.chatByThreadId.get(threadId);
    return chatId ? this.sessions.get(chatId) : undefined;
  }

  private hasApprovalForChat(chatId: string): boolean {
    for (const approval of this.approvals.values()) {
      if (approval.chatId === chatId) return true;
    }
    return false;
  }

  private matchesApprovalOwner(
    request: CodexApprovalRequest | undefined,
    expectedChatId?: string,
    expectedUserId?: string
  ): request is CodexApprovalRequest {
    return !!(
      expectedChatId !== undefined &&
      request &&
      request.generation === this.client.getGeneration() &&
      request.chatId === expectedChatId &&
      request.userId === expectedUserId
    );
  }

  private removeThreadBindings(threadId: string): void {
    const chatId = this.chatByThreadId.get(threadId);
    if (!chatId) return;
    this.chatByThreadId.delete(threadId);
    this.sessions.delete(chatId);
    for (const [approvalToken, approval] of this.approvals) {
      if (approval.threadId === threadId) this.approvals.delete(approvalToken);
    }
  }
}
