export type JsonRpcId = number | string;

export interface JsonRpcRequest<T = unknown> {
  id: JsonRpcId;
  method: string;
  params: T;
}

export interface JsonRpcNotification<T = unknown> {
  method: string;
  params: T;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  id: JsonRpcId;
  result?: T;
  error?: JsonRpcError;
}

export interface CodexThreadStatus {
  type: 'notLoaded' | 'idle' | 'systemError' | 'active';
  activeFlags?: Array<'waitingOnApproval' | 'waitingOnUserInput' | string>;
}

export interface CodexTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  items?: CodexThreadItem[];
  error?: { message: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}

export interface CodexThread {
  id: string;
  sessionId?: string;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  preview?: string;
  cwd?: string;
  model?: string | null;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: CodexThreadStatus;
  turns?: CodexTurn[];
  [key: string]: unknown;
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements?: unknown[] }
  | { type: 'image'; url: string; detail?: string }
  | { type: 'localImage'; path: string; detail?: string }
  | { type: 'audio'; url: string }
  | { type: 'localAudio'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export interface CodexThreadItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export type CodexApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: unknown } };

export type CodexPermissionDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CodexGrantedPermissionProfile {
  network?: Record<string, unknown>;
  fileSystem?: Record<string, unknown>;
}

export interface CodexApprovalRequest {
  approvalToken: string;
  generation: number;
  requestId: JsonRpcId;
  kind: 'command' | 'fileChange' | 'userInput' | 'permissions' | 'other';
  chatId?: string;
  userId?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  method: string;
  params: Record<string, unknown>;
}

export type CodexSessionState = 'idle' | 'running' | 'waiting' | 'error' | 'stopped';

export interface CodexSession {
  chatId: string;
  userId?: string;
  threadId: string;
  cwd?: string;
  state: CodexSessionState;
  activeTurnId?: string;
  lastCompletedTurnId?: string;
  lastError?: string;
  updatedAt: number;
}

export interface CodexContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  blockId: string;
  timestamp: number;
  content?: unknown;
  text?: string;
  id?: string;
  toolName?: string;
  input?: unknown;
  is_error?: boolean;
  codexItemType?: string;
}

export interface CodexStreamEvent {
  chatId: string;
  userId?: string;
  threadId: string;
  turnId?: string;
  operation: 'append' | 'replace';
  block: CodexContentBlock;
}

export interface CodexStatusEvent {
  chatId: string;
  userId?: string;
  threadId: string;
  state: CodexSessionState;
  turnId?: string;
  /** Present only for the authoritative turn/completed notification. */
  completedTurnId?: string;
  /** The app-server confirmed that this process no longer owns the thread. */
  ownershipReleased?: boolean;
  error?: string;
}

export type ThreadUnsubscribeStatus = 'notLoaded' | 'notSubscribed' | 'unsubscribed';

export interface ThreadUnsubscribeResponse {
  status: ThreadUnsubscribeStatus;
}

export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: 'created_at' | 'updated_at' | 'recency_at';
  sortDirection?: 'asc' | 'desc';
  modelProviders?: string[] | null;
  sourceKinds?: ThreadSourceKind[] | null;
  archived?: boolean | null;
  cwd?: string | string[] | null;
  useStateDbOnly?: boolean;
  searchTerm?: string | null;
}

export type ThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
}

export interface ThreadOperationResponse {
  thread: CodexThread;
  [key: string]: unknown;
}

export interface TurnStartResponse {
  turn: CodexTurn;
}

export interface ThreadStartOptions {
  model?: string | null;
  /** Convenience field mapped to Codex config.model_reasoning_effort. */
  effort?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  sandbox?: CodexSandboxMode | null;
  config?: Record<string, unknown> | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  [key: string]: unknown;
}

export interface TurnStartOptions {
  cwd?: string | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  sandboxPolicy?: unknown;
  model?: string | null;
  effort?: string | null;
  [key: string]: unknown;
}

export type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
