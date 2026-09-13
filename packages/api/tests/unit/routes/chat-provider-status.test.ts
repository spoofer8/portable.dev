import { describe, expect, it } from 'bun:test';

import { resolveChatListStatus } from '../../../src/routes/subroutes/chat.routes.js';

describe('GET /api/chats provider-aware status', () => {
  it('reads Codex live state from CodexService instead of the Claude session map', () => {
    const claudeSessions = new Map([
      ['codex-chat', { query: {}, isProcessing: false, signal: { stopped: false } }],
    ]);
    const codexService = {
      getSession: () => ({ state: 'waiting' }),
    };

    expect(
      resolveChatListStatus(
        { id: 'codex-chat', provider: 'codex', status: 'completed' },
        claudeSessions,
        codexService
      )
    ).toBe('running');
  });

  it('keeps legacy chats on the Claude-default status path', () => {
    expect(
      resolveChatListStatus(
        { id: 'claude-chat', status: 'completed' },
        new Map([['claude-chat', { query: {}, isProcessing: true, signal: { stopped: false } }]])
      )
    ).toBe('running');
  });

  it('preserves externally detected Codex running status without a local binding', () => {
    expect(
      resolveChatListStatus(
        { id: 'codex:external', provider: 'codex', status: 'running' },
        new Map(),
        { getSession: () => undefined }
      )
    ).toBe('running');
  });
});
