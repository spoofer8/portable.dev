import { describe, expect, it } from 'bun:test';

import {
  MAX_ROLLOUT_MESSAGES,
  parseRollout,
  rolloutToMessages,
  summarizeRollout,
} from '../../../src/db/CodexProjects/rolloutReader';

const line = (value: unknown) => JSON.stringify(value);

describe('Codex rollout reader', () => {
  it('maps user, assistant, tool use, and tool result records to the portable stream', () => {
    const raw = [
      line({
        timestamp: '2026-09-13T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'thread-1', cwd: '/Users/me/projects/app', source: 'cli' },
      }),
      line({
        timestamp: '2026-09-13T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fix the tests' }],
        },
      }),
      line({
        timestamp: '2026-09-13T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-1',
          arguments: '{"cmd":"bun test"}',
        },
      }),
      line({
        timestamp: '2026-09-13T10:00:02.500Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'browser',
          call_id: 'custom-1',
          input: { url: 'https://example.test' },
        },
      }),
      line({
        timestamp: '2026-09-13T10:00:03.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'pass' },
      }),
      line({
        timestamp: '2026-09-13T10:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'msg-1',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      }),
      '{"torn":',
    ].join('\n');

    const parsed = parseRollout(raw);
    const messages = rolloutToMessages(parsed);
    expect(messages.map((message) => message.type)).toEqual([
      'user_message',
      'claude_code_block',
      'claude_code_block',
      'claude_code_block',
      'claude_code_block',
    ]);
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3, 4, 5]);
    expect((messages[1].data as any).input).toEqual({ cmd: 'bun test' });
    expect((messages[2].data as any).input).toEqual({ url: 'https://example.test' });
    expect((messages[3].data as any).blockId).toBe('call-1:result');

    const summary = summarizeRollout(parsed);
    expect(summary.threadId).toBe('thread-1');
    expect(summary.cwd).toBe('/Users/me/projects/app');
    expect(summary.title).toBe('Fix the tests');
    expect(summary.isSubagent).toBe(false);
  });

  it('identifies subagent rollouts from structured source metadata', () => {
    const summary = summarizeRollout(
      parseRollout(
        line({
          type: 'session_meta',
          payload: {
            id: 'child',
            cwd: '/Users/me/projects/app',
            source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
          },
        })
      )
    );
    expect(summary.isSubagent).toBe(true);
  });

  it('bounds rendered history while preserving the newest messages', () => {
    const records = Array.from({ length: MAX_ROLLOUT_MESSAGES + 5 }, (_, index) => ({
      type: 'response_item',
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `message-${index}` }],
      },
    }));

    const messages = rolloutToMessages(records);
    expect(messages).toHaveLength(MAX_ROLLOUT_MESSAGES);
    expect(messages[0].id).toBe(1);
    expect((messages[0].data as any).content).toBe('message-5');
    expect((messages.at(-1)?.data as any).content).toBe(`message-${MAX_ROLLOUT_MESSAGES + 4}`);
  });
});
