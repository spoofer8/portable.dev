import { isOverlayMessage, mergeStreams } from '../ClaudeProjects/ClaudeProjectsMessageStore.js';
import { OverlayMessageStore } from '../ClaudeProjects/OverlayMessageStore.js';
import { readCodexRollout } from './codexPaths.js';
import { parseRollout, rolloutToMessages } from './rolloutReader.js';

import type { IMessageStore } from '../ClaudeProjects/IMessageStore.js';
import type { MessageRow } from '../JsonDbAdapter/JsonChatStore.js';

const MAX_CODEX_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_HISTORY_RECORDS = 100_000;
const MAX_CODEX_HISTORY_MESSAGES = 20_000;

function nonEmptyLineCount(value: string): number {
  if (value.length === 0) return 0;
  let count = value.endsWith('\n') ? 0 : 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

export type CodexRolloutResolver = (chatId: string) => Promise<string | null>;

export class CodexProjectsMessageStore implements IMessageStore {
  constructor(
    private readonly codexHome: string,
    private readonly overlay: OverlayMessageStore,
    private readonly resolveRollout: CodexRolloutResolver
  ) {}

  async initialize(): Promise<void> {
    await this.overlay.initialize();
  }

  close(): void {
    this.overlay.close();
  }

  async appendMessage(
    chatId: string,
    type: string,
    data: unknown,
    timestamp: number
  ): Promise<number> {
    if (!isOverlayMessage(type, data)) return 0;
    return this.overlay.append(chatId, type, data, timestamp);
  }

  async readMessages(chatId: string): Promise<MessageRow[]> {
    const [rollout, overlay] = await Promise.all([
      this.readRollout(chatId),
      this.overlay.read(chatId),
    ]);
    return mergeStreams(rollout, overlay);
  }

  async getMessageCount(chatId: string): Promise<number> {
    return (await this.readMessages(chatId)).length;
  }

  async deleteMessages(chatId: string): Promise<void> {
    await this.overlay.deleteChat(chatId);
  }

  private async readRollout(chatId: string): Promise<MessageRow[]> {
    const filePath = await this.resolveRollout(chatId);
    if (!filePath) return [];
    const rollout = await readCodexRollout(this.codexHome, filePath, {
      maxBytes: MAX_CODEX_HISTORY_BYTES,
    });
    if (!rollout) return [];
    const recordTruncated = nonEmptyLineCount(rollout.contents) > MAX_CODEX_HISTORY_RECORDS;
    const parsed = parseRollout(rollout.contents, MAX_CODEX_HISTORY_RECORDS);
    const uncappedMessages = rolloutToMessages(parsed, Number.MAX_SAFE_INTEGER);
    const messageTruncated = uncappedMessages.length > MAX_CODEX_HISTORY_MESSAGES;
    const messages = messageTruncated
      ? uncappedMessages
          .slice(-MAX_CODEX_HISTORY_MESSAGES)
          .map((message, index) => ({ ...message, id: index + 1 }))
      : uncappedMessages;
    if (!rollout.truncated && !recordTruncated && !messageTruncated) return messages;
    return [
      {
        id: 0,
        type: 'claude_code_block',
        data: {
          type: 'error',
          code: 'codex_history_truncated',
          title: 'Earlier history omitted',
          message:
            'Earlier Codex history was omitted because this session exceeds local safety limits.',
        },
        timestamp: 0,
      },
      ...messages,
    ];
  }
}
