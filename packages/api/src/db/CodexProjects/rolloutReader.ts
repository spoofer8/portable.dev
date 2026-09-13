import { pickPreviewRows } from '../previewRows.js';

import type { MessageRow } from '../JsonDbAdapter/JsonChatStore.js';

interface RolloutContent {
  type?: string;
  text?: string;
  image_url?: string;
}

export interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    id?: string;
    session_id?: string;
    cwd?: string;
    source?: unknown;
    thread_source?: string;
    role?: string;
    content?: RolloutContent[];
    name?: string;
    call_id?: string;
    arguments?: string;
    input?: unknown;
    output?: unknown;
  };
}

export interface RolloutSummary {
  threadId: string | null;
  cwd: string | null;
  isSubagent: boolean;
  lastUpdated: number;
  messages: MessageRow[];
  title: string | null;
  firstMessageData: unknown;
  lastMessageData: unknown;
}

export const MAX_ROLLOUT_RECORDS = 10_000;
export const MAX_ROLLOUT_MESSAGES = 2_000;

export function parseRollout(
  jsonl: string,
  maxRecords: number = MAX_ROLLOUT_RECORDS
): RolloutLine[] {
  const lines: RolloutLine[] = [];
  let sessionMeta: RolloutLine | null = null;
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const parsed = value as RolloutLine;
        if (parsed.type === 'session_meta' && !sessionMeta) sessionMeta = parsed;
        else lines.push(parsed);
      }
    } catch {
      // Codex can be appending the final line while discovery reads it.
    }
  }
  const keep = Math.max(0, maxRecords - (sessionMeta ? 1 : 0));
  const bounded = keep === 0 ? [] : lines.slice(-keep);
  return sessionMeta ? [sessionMeta, ...bounded] : bounded;
}

function timestampMs(value: string | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textContent(content: RolloutContent[] | undefined, kind: string): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item?.type === kind && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n');
}

function parseArguments(value: unknown): unknown {
  if (value == null || value === '') return {};
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sourceIsSubagent(source: unknown): boolean {
  if (typeof source === 'string') {
    if (source === 'subagent') return true;
    try {
      return sourceIsSubagent(JSON.parse(source));
    } catch {
      return false;
    }
  }
  if (!source || typeof source !== 'object') return false;
  return 'subagent' in source;
}

export function rolloutToMessages(
  lines: RolloutLine[],
  maxMessages: number = MAX_ROLLOUT_MESSAGES
): MessageRow[] {
  const messages: MessageRow[] = [];
  let nextId = 1;
  let lastTimestamp = 0;

  const emit = (type: string, data: unknown, timestamp: number) => {
    messages.push({ id: nextId++, type, data, timestamp });
  };

  for (const line of lines) {
    const payload = line.payload;
    if (line.type !== 'response_item' || !payload) continue;
    const timestamp = timestampMs(line.timestamp, lastTimestamp + 1);
    lastTimestamp = Math.max(lastTimestamp, timestamp);

    if (payload.type === 'message') {
      if (payload.role === 'user') {
        const content = textContent(payload.content, 'input_text');
        if (content) emit('user_message', { content }, timestamp);
      } else if (payload.role === 'assistant') {
        const content = textContent(payload.content, 'output_text');
        if (content) {
          emit('claude_code_block', { type: 'text', content, blockId: payload.id }, timestamp);
        }
      }
      continue;
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const callId = payload.call_id ?? payload.id;
      emit(
        'claude_code_block',
        {
          type: 'tool_use',
          id: callId,
          blockId: callId,
          name: payload.name ?? 'tool',
          input: parseArguments(payload.arguments ?? payload.input),
        },
        timestamp
      );
      continue;
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const callId = payload.call_id ?? payload.id;
      emit(
        'claude_code_block',
        {
          type: 'tool_result',
          id: callId,
          blockId: callId ? `${callId}:result` : undefined,
          content: outputText(payload.output),
          is_error: false,
        },
        timestamp
      );
    }
  }
  const bounded = maxMessages <= 0 ? [] : messages.slice(-maxMessages);
  return bounded.map((message, index) => ({ ...message, id: index + 1 }));
}

export function summarizeRollout(lines: RolloutLine[], fallbackTimestamp = 0): RolloutSummary {
  let threadId: string | null = null;
  let cwd: string | null = null;
  let isSubagent = false;
  let lastUpdated = fallbackTimestamp;
  let title: string | null = null;

  for (const line of lines) {
    const payload = line.payload;
    if (line.type === 'session_meta' && payload) {
      threadId = payload.id ?? payload.session_id ?? threadId;
      cwd = payload.cwd ?? cwd;
      isSubagent ||= payload.thread_source === 'subagent' || sourceIsSubagent(payload.source);
    }
    if (title === null && line.type === 'response_item' && payload?.type === 'message') {
      const firstUserText =
        payload.role === 'user' ? textContent(payload.content, 'input_text') : '';
      if (firstUserText.trim()) title = firstUserText.trim();
    }
    lastUpdated = Math.max(lastUpdated, timestampMs(line.timestamp, 0));
  }

  const messages = rolloutToMessages(lines);
  const { firstUserMessage, lastMessage } = pickPreviewRows(messages);
  return {
    threadId,
    cwd,
    isSubagent,
    lastUpdated,
    messages,
    title,
    firstMessageData: title ? { content: title } : firstUserMessage?.data,
    lastMessageData: lastMessage?.data,
  };
}
