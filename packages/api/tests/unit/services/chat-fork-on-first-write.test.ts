/**
 * Fork-on-first-write — `ChatExecutionService.handleChatMessage` fork branch.
 *
 * When the first message targets a Claude-Code-originated chat (a *discovered*
 * transcript with no Portable row), `handleChatMessage` must:
 *   - mint a NEW Portable chat id,
 *   - claim a real row carrying `forkSourceSessionId` (+ repoPath = the source cwd,
 *     repoFullName) with session_id still null,
 *   - emit `chat:created` + `chat:forked` and join the user to the new room,
 *   - buffer the user message + return the NEW chat id.
 * A normal (sqlite-origin) chat is untouched: same id, no fork emits.
 *
 * Boundary: a fake ChatService + emitter only — handleChatMessage touches no DB / SDK.
 */
import { describe, it, expect } from 'bun:test';

import { ChatExecutionService } from '../../../src/services/ChatExecutionService';
import type { ChatOrigin } from '../../../src/db/DbAdapter';
import type { ExecutionContext } from '../../../src/services/types/ExecutionContext';

/** A transcript last-touched long ago (cold — outside the adopt freshness guard). */
const COLD = Date.now() - 10 * 60_000;

/** An ended registry row (a session Portable OBSERVED via hooks and saw end). */
const endedRow = (over: Record<string, unknown> = {}) => ({
  sessionId: 'src-sess',
  state: 'ended',
  pid: 0,
  pidConfirmed: false,
  cwd: '/ws/clock-app',
  transcriptPath: '',
  updatedAt: Date.now(),
  ...over,
});

function makeService(
  origin: ChatOrigin,
  externalRegistry?: { isLive: (id: string) => boolean; getSession?: (id: string) => any },
  stopOnPc?: { stop: (sessionId: string, mode?: string) => Promise<any> },
  runtime?: {
    chat?: Record<string, unknown>;
    codexSession?: unknown;
    codexServiceAvailable?: boolean;
  }
) {
  const saveChatCalls: any[] = [];
  const bufferCalls: any[] = [];
  const updateSettingsCalls: any[] = [];
  const fakeChatService: any = {
    getChatOrigin: async () => origin,
    saveChat: async (opts: any) => {
      saveChatCalls.push(opts);
      return true;
    },
    // After a claim, getChat(newId) returns a minimal row (no autopilot).
    getChat: async (chatId: string) => {
      const saved = saveChatCalls.find((chat) => chat.chatId === chatId);
      return {
        id: chatId,
        provider: saved?.provider ?? runtime?.chat?.provider,
        model: saved?.model ?? runtime?.chat?.model ?? 'opus',
        permissions: saved?.permissions ?? runtime?.chat?.permissions ?? 'default',
        agent_setup_id: saved?.agentSetupId ?? runtime?.chat?.agent_setup_id ?? 'freestyle',
        ...runtime?.chat,
      };
    },
    updateChatSettings: async (...args: any[]) => updateSettingsCalls.push(args),
    bufferMessage: async (...args: any[]) => {
      bufferCalls.push(args);
    },
  };

  const emitted: Array<{ event: string; payload: any }> = [];
  const joinedRooms: string[] = [];
  const emitter: any = {
    emit: () => {},
    emitToUser: (_userId: string, event: string, payload: any) => emitted.push({ event, payload }),
    joinUserToRoom: (_userId: string, room: string) => joinedRooms.push(room),
  };

  const svc = new ChatExecutionService(
    fakeChatService,
    {} as any, // claudeService — unused by handleChatMessage
    {} as any, // gitLocalService
    {} as any, // messageDeduplicationService
    undefined, // tunnelService
    undefined, // processTrackerService
    undefined, // dbAdapter
    undefined, // pushNotificationService
    undefined, // sopService
    undefined, // claudeCodeSessions
    undefined, // reposCacheService
    undefined, // handshakeVerificationGate
    externalRegistry as any, // rev12: adopt-vs-fork gate (absent ⇒ always fork)
    stopOnPc as any, // rev12 D63: stop-on-send (absent ⇒ fork exactly as before)
    undefined,
    (runtime?.codexServiceAvailable === false
      ? undefined
      : { getSession: () => runtime?.codexSession }) as any
  );

  const context = {
    chatId: 'ignored',
    userId: 'user-1',
    username: 'user-1',
    authToken: 'tok',
    emitter,
  } as unknown as ExecutionContext;

  return {
    svc,
    context,
    saveChatCalls,
    bufferCalls,
    updateSettingsCalls,
    emitted,
    joinedRooms,
  };
}

describe('fork-on-first-write — handleChatMessage', () => {
  it('forks a discovered Claude Code chat into a new Portable chat', async () => {
    const { svc, context, saveChatCalls, bufferCalls, emitted, joinedRooms } = makeService({
      origin: 'discovered',
      sourceSessionId: 'src-sess',
      cwd: '/ws/clock-app',
      repoPath: '/ws/clock-app',
      repoFullName: 'me/clock-app',
      title: 'Existing CC chat',
      lastUpdated: COLD,
    });

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess', // the discovered chat == its session id
      content: 'continue please',
    });

    expect(result.success).toBe(true);
    // A NEW Portable id, distinct from the original CC session id.
    expect(result.chatId).toBeDefined();
    expect(result.chatId).not.toBe('src-sess');
    expect(result.chatId!.startsWith('chat-')).toBe(true);

    // The claim row carries the fork source + repo identity, session_id left unset.
    expect(saveChatCalls).toHaveLength(1);
    const claim = saveChatCalls[0];
    expect(claim.chatId).toBe(result.chatId);
    expect(claim.forkSourceSessionId).toBe('src-sess');
    expect(claim.repoPath).toBe('/ws/clock-app');
    expect(claim.repoFullName).toBe('me/clock-app');
    expect(claim.sessionId).toBeUndefined();

    // The client is told to navigate (chat:forked) + the new chat appears (chat:created).
    const events = emitted.map((e) => e.event);
    expect(events).toContain('chat:created');
    expect(events).toContain('chat:forked');
    const forked = emitted.find((e) => e.event === 'chat:forked')!;
    expect(forked.payload).toEqual({ oldChatId: 'src-sess', newChatId: result.chatId });
    expect(joinedRooms).toContain(result.chatId);

    // The user message is buffered under the NEW id (not the original CC id).
    expect(bufferCalls.length).toBeGreaterThan(0);
    expect(bufferCalls[0][1]).toBe(result.chatId); // (userId, chatId, type, …)
  });

  it('forks a discovered Codex rollout without a confirmed stop and keeps its provider', async () => {
    const { svc, context, saveChatCalls, emitted } = makeService({
      origin: 'discovered',
      provider: 'codex',
      sourceSessionId: 'thread-source',
      cwd: '/ws/codex-app',
      repoPath: '/ws/codex-app',
      repoFullName: 'me/codex-app',
      title: 'Existing Codex thread',
      lastUpdated: COLD,
    });

    const result = await svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'continue safely',
    });

    expect(result.success).toBe(true);
    expect(result.chatId).not.toBe('codex:thread-source');
    expect(result.provider).toBe('codex');
    expect(result.effectiveModel).toBe('supersol');
    expect(saveChatCalls[0]).toMatchObject({
      provider: 'codex',
      forkSourceSessionId: 'thread-source',
      model: 'supersol',
    });
    expect(emitted.find((event) => event.event === 'chat:forked')?.payload).toEqual({
      oldChatId: 'codex:thread-source',
      newChatId: result.chatId,
    });
  });

  it('stops a live discovered Codex thread and adopts that thread in place after confirmation', async () => {
    const stopCalls: Array<[string, string | undefined]> = [];
    const { svc, context, saveChatCalls, emitted } = makeService(
      {
        origin: 'discovered',
        provider: 'codex',
        sourceSessionId: 'thread-source',
        cwd: '/ws/codex-app',
        repoPath: '/ws/codex-app',
        repoFullName: 'me/codex-app',
        title: 'Existing Codex thread',
        lastUpdated: Date.now(),
      },
      undefined,
      {
        stop: async (sessionId, mode) => {
          stopCalls.push([sessionId, mode]);
          return { stopped: true, reason: 'stopped' };
        },
      }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'continue on my phone',
    });

    expect(stopCalls).toEqual([['codex:thread-source', 'end']]);
    expect(result.chatId).toBe('codex:thread-source');
    expect(result.provider).toBe('codex');
    expect(saveChatCalls).toHaveLength(1);
    expect(saveChatCalls[0]).toMatchObject({
      chatId: 'codex:thread-source',
      provider: 'codex',
      sessionId: 'thread-source',
      model: 'supersol',
    });
    expect(saveChatCalls[0].forkSourceSessionId).toBeUndefined();
    expect(emitted.map((event) => event.event)).not.toContain('chat:forked');
  });

  it('keeps the Codex fork fallback when writer shutdown cannot be confirmed', async () => {
    const stopCalls: string[] = [];
    const { svc, context, saveChatCalls, emitted } = makeService(
      {
        origin: 'discovered',
        provider: 'codex',
        sourceSessionId: 'thread-source',
        cwd: '/ws/codex-app',
        repoPath: '/ws/codex-app',
        repoFullName: 'me/codex-app',
        title: 'Existing Codex thread',
        lastUpdated: Date.now(),
      },
      undefined,
      {
        stop: async (sessionId) => {
          stopCalls.push(sessionId);
          return { stopped: false, reason: 'not-confirmed' };
        },
      }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'continue safely',
    });

    expect(stopCalls).toEqual(['codex:thread-source']);
    expect(result.chatId).not.toBe('codex:thread-source');
    expect(saveChatCalls[0].forkSourceSessionId).toBe('thread-source');
    expect(emitted.map((event) => event.event)).toContain('chat:forked');
  });

  it('ADOPTS in place (rev12 D56): an ENDED registry row + cold transcript ⇒ same id, sessionId set, no fork emits', async () => {
    const { svc, context, saveChatCalls, bufferCalls, emitted } = makeService(
      {
        origin: 'discovered',
        sourceSessionId: 'src-sess',
        cwd: '/ws/clock-app',
        repoPath: '/ws/clock-app',
        repoFullName: 'me/clock-app',
        title: 'Existing CC chat',
        lastUpdated: COLD,
      },
      // A session Portable OBSERVED via hooks and saw END (SessionEnd), but with
      // no confirmed pid → adopt only because the transcript is cold.
      { isLive: () => false, getSession: () => endedRow() }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess',
      content: 'continue please',
    });

    expect(result.success).toBe(true);
    // The SAME chat id — no new Portable chat, no navigation.
    expect(result.chatId).toBe('src-sess');

    // The adopted row resumes IN PLACE: session_id set, NO fork source.
    expect(saveChatCalls).toHaveLength(1);
    const claim = saveChatCalls[0];
    expect(claim.chatId).toBe('src-sess');
    expect(claim.sessionId).toBe('src-sess');
    expect(claim.forkSourceSessionId).toBeUndefined();

    // No fork signals — the chat list reconciles the row by session_id.
    expect(emitted.map((e) => e.event)).not.toContain('chat:forked');
    expect(bufferCalls[0][1]).toBe('src-sess');
  });

  it('FORKS when the registry reports the terminal session live (D57 safety floor)', async () => {
    const { svc, context, saveChatCalls, emitted } = makeService(
      {
        origin: 'discovered',
        sourceSessionId: 'src-sess',
        cwd: '/ws/clock-app',
        repoPath: '/ws/clock-app',
        repoFullName: 'me/clock-app',
        title: 'Existing CC chat',
        lastUpdated: COLD,
      },
      { isLive: () => true, getSession: () => endedRow({ state: 'live-idle' }) }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess',
      content: 'continue please',
    });

    expect(result.chatId).not.toBe('src-sess');
    expect(saveChatCalls[0].forkSourceSessionId).toBe('src-sess');
    expect(saveChatCalls[0].sessionId).toBeUndefined();
    expect(emitted.map((e) => e.event)).toContain('chat:forked');
  });

  it("FORKS when there is NO registry row (B1: no hook evidence ⇒ can't prove not-live even if cold)", async () => {
    // The dual-writer guard: a terminal session started BEFORE `portable start`
    // has no hooks and is never registered. A cold-but-alive session at a prompt
    // is indistinguishable from a dead one, so adopting would race the terminal's
    // next write. No row ⇒ fork, regardless of a cold transcript.
    const { svc, context, saveChatCalls, emitted } = makeService(
      {
        origin: 'discovered',
        sourceSessionId: 'src-sess',
        cwd: '/ws/clock-app',
        repoPath: '/ws/clock-app',
        repoFullName: 'me/clock-app',
        title: 'Existing CC chat',
        lastUpdated: COLD, // cold — but no registry row
      },
      { isLive: () => false, getSession: () => null }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess',
      content: 'continue please',
    });

    expect(result.chatId).not.toBe('src-sess'); // forked
    expect(saveChatCalls[0].forkSourceSessionId).toBe('src-sess');
    expect(saveChatCalls[0].sessionId).toBeUndefined();
    expect(emitted.map((e) => e.event)).toContain('chat:forked');
  });

  it('ADOPTS a HOT transcript when there is POSITIVE end evidence (Stop-on-PC → continue here, D60)', async () => {
    // After Stop-on-PC ends the terminal session, its transcript mtime is fresh
    // — but the registry has a confirmed-dead ended row, which bypasses the
    // freshness guard so the hand-off adopts instead of forking.
    const { svc, context, saveChatCalls, emitted } = makeService(
      {
        origin: 'discovered',
        sourceSessionId: 'src-sess',
        cwd: '/ws/clock-app',
        repoPath: '/ws/clock-app',
        repoFullName: 'me/clock-app',
        title: 'Existing CC chat',
        lastUpdated: Date.now() - 1000, // HOT
      },
      {
        isLive: () => false,
        getSession: () => ({
          sessionId: 'src-sess',
          state: 'ended',
          pid: 999_999_999, // a pid that is not alive on this machine
          pidConfirmed: true,
          cwd: '/ws/clock-app',
          transcriptPath: '',
          updatedAt: Date.now(),
        }),
      }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess',
      content: 'continue please',
    });

    expect(result.chatId).toBe('src-sess'); // adopted in place
    expect(saveChatCalls[0].sessionId).toBe('src-sess');
    expect(saveChatCalls[0].forkSourceSessionId).toBeUndefined();
    expect(emitted.map((e) => e.event)).not.toContain('chat:forked');
  });

  it('FORKS when the transcript is hot even with no live evidence (Portable-was-off guard)', async () => {
    const { svc, context, saveChatCalls } = makeService(
      {
        origin: 'discovered',
        sourceSessionId: 'src-sess',
        cwd: '/ws/clock-app',
        repoPath: '/ws/clock-app',
        repoFullName: 'me/clock-app',
        title: 'Existing CC chat',
        lastUpdated: Date.now() - 1000, // hot — inside the freshness guard
      },
      // Ended row but no confirmed-dead pid → hot transcript forces a fork.
      { isLive: () => false, getSession: () => endedRow() }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess',
      content: 'continue please',
    });

    expect(result.chatId).not.toBe('src-sess');
    expect(saveChatCalls[0].forkSourceSessionId).toBe('src-sess');
  });

  it('STOP-ON-SEND (D63): a live terminal session is stopped, then the send ADOPTS in place', async () => {
    // The last-step UX: sending from the app while the chat is live in a
    // terminal means "continue HERE". The gate ends the terminal session
    // (evidence-confirmed) and the SAME conversation continues — no fork, no
    // navigation — even though the transcript is HOT (the turn just ran).
    let session: any = endedRow({ state: 'live-running', pid: 4242, pidConfirmed: true });
    const stopCalls: Array<[string, string | undefined]> = [];
    const stopOnPc = {
      stop: async (sessionId: string, mode?: string) => {
        stopCalls.push([sessionId, mode]);
        // The confirmed stop's evidence: registry row flips to ended with a
        // confirmed pid that is no longer alive.
        session = endedRow({ state: 'ended', pid: 999_999_999, pidConfirmed: true });
        return { stopped: true, reason: 'stopped' };
      },
    };
    const { svc, context, saveChatCalls, emitted } = makeService(
      {
        origin: 'discovered',
        sourceSessionId: 'src-sess',
        cwd: '/ws/clock-app',
        repoPath: '/ws/clock-app',
        repoFullName: 'me/clock-app',
        title: 'Existing CC chat',
        lastUpdated: Date.now() - 1000, // HOT — the terminal was just working
      },
      { isLive: () => session.state !== 'ended', getSession: () => session },
      stopOnPc
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess',
      content: 'stop that and do this instead',
    });

    expect(stopCalls).toEqual([['src-sess', 'end']]);
    expect(result.chatId).toBe('src-sess'); // adopted in place — ONE conversation
    expect(saveChatCalls[0].sessionId).toBe('src-sess');
    expect(saveChatCalls[0].forkSourceSessionId).toBeUndefined();
    expect(emitted.map((e) => e.event)).not.toContain('chat:forked');
  });

  it('STOP-ON-SEND (D63): an UNCONFIRMED stop falls back to the fork (never data loss)', async () => {
    const stopOnPc = {
      stop: async () => ({ stopped: false, reason: 'not-confirmed' }),
    };
    const { svc, context, saveChatCalls, emitted } = makeService(
      {
        origin: 'discovered',
        sourceSessionId: 'src-sess',
        cwd: '/ws/clock-app',
        repoPath: '/ws/clock-app',
        repoFullName: 'me/clock-app',
        title: 'Existing CC chat',
        lastUpdated: Date.now() - 1000,
      },
      {
        isLive: () => true,
        getSession: () => endedRow({ state: 'live-running', pid: 4242, pidConfirmed: true }),
      },
      stopOnPc
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess',
      content: 'continue please',
    });

    expect(result.chatId).not.toBe('src-sess'); // forked — today's safety floor
    expect(saveChatCalls[0].forkSourceSessionId).toBe('src-sess');
    expect(emitted.map((e) => e.event)).toContain('chat:forked');
  });

  it('STOP-ON-SEND (D63): a throwing stop service degrades to the fork', async () => {
    const stopOnPc = {
      stop: async () => {
        throw new Error('sidecar unreachable');
      },
    };
    const { svc, context, saveChatCalls } = makeService(
      {
        origin: 'discovered',
        sourceSessionId: 'src-sess',
        cwd: '/ws/clock-app',
        repoPath: '/ws/clock-app',
        repoFullName: 'me/clock-app',
        title: 'Existing CC chat',
        lastUpdated: Date.now() - 1000,
      },
      {
        isLive: () => true,
        getSession: () => endedRow({ state: 'live-running', pid: 4242, pidConfirmed: true }),
      },
      stopOnPc
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess',
      content: 'continue please',
    });

    expect(result.chatId).not.toBe('src-sess');
    expect(saveChatCalls[0].forkSourceSessionId).toBe('src-sess');
  });

  it('STOP-ON-SEND (D63): an already-adoptable chat never calls stop (no needless kill)', async () => {
    const stopCalls: string[] = [];
    const stopOnPc = {
      stop: async (sessionId: string) => {
        stopCalls.push(sessionId);
        return { stopped: true, reason: 'stopped' };
      },
    };
    const { svc, context } = makeService(
      {
        origin: 'discovered',
        sourceSessionId: 'src-sess',
        cwd: '/ws/clock-app',
        repoPath: '/ws/clock-app',
        repoFullName: 'me/clock-app',
        title: 'Existing CC chat',
        lastUpdated: COLD,
      },
      { isLive: () => false, getSession: () => endedRow() },
      stopOnPc
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess',
      content: 'continue please',
    });

    expect(result.chatId).toBe('src-sess'); // plain D56 adopt
    expect(stopCalls).toHaveLength(0);
  });

  it('does NOT fork a normal Portable chat (sqlite origin)', async () => {
    const { svc, context, saveChatCalls, bufferCalls, emitted } = makeService({ origin: 'sqlite' });

    const result = await svc.handleChatMessage(context, {
      chatId: 'chat-existing',
      content: 'hello',
    });

    expect(result.success).toBe(true);
    expect(result.chatId).toBe('chat-existing'); // unchanged
    expect(saveChatCalls).toHaveLength(0); // no claim
    expect(emitted.map((e) => e.event)).not.toContain('chat:forked');
    expect(bufferCalls[0][1]).toBe('chat-existing');
  });

  it('reconfirms handoff before an interactive send to an adopted external Codex row', async () => {
    const stopCalls: string[] = [];
    const { svc, context, saveChatCalls, bufferCalls, emitted } = makeService(
      { origin: 'sqlite', provider: 'codex' },
      undefined,
      {
        stop: async (sessionId) => {
          stopCalls.push(sessionId);
          return { stopped: true, reason: 'stopped' };
        },
      },
      {
        chat: {
          provider: 'codex',
          session_id: 'thread-source',
          title: 'Adopted Codex thread',
          repo_path: '/ws/codex-app',
          repo_full_name: 'me/codex-app',
          model: 'superastra',
          permissions: 'bypass_permissions',
          agent_setup_id: 'reviewer',
          effort: 'high',
        },
      }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'continue here',
    });

    expect(stopCalls).toEqual(['codex:thread-source']);
    expect(result).toMatchObject({
      success: true,
      chatId: 'codex:thread-source',
      provider: 'codex',
      effectiveModel: 'superastra',
      effectivePermissions: 'bypass_permissions',
      effectiveAgentSetupId: 'reviewer',
      effectiveEffort: 'high',
      codexHandoffConfirmed: true,
    });
    expect(saveChatCalls).toHaveLength(0);
    expect(bufferCalls[0][1]).toBe('codex:thread-source');
    expect(emitted.map((event) => event.event)).not.toContain('chat:forked');
  });

  it('forks an adopted external Codex row before buffering when handoff is unconfirmed', async () => {
    const { svc, context, saveChatCalls, bufferCalls, updateSettingsCalls, emitted } = makeService(
      { origin: 'sqlite', provider: 'codex' },
      undefined,
      { stop: async () => ({ stopped: false, reason: 'not-confirmed' }) },
      {
        chat: {
          provider: 'codex',
          session_id: 'thread-source',
          title: 'Adopted Codex thread',
          repo_path: '/ws/codex-app',
          repo_full_name: 'me/codex-app',
          model: 'superastra',
          permissions: 'bypass_permissions',
          agent_setup_id: 'reviewer',
          effort: 'high',
        },
      }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'continue safely',
    });

    expect(result.chatId).not.toBe('codex:thread-source');
    expect(saveChatCalls[0]).toMatchObject({
      chatId: result.chatId,
      provider: 'codex',
      forkSourceSessionId: 'thread-source',
      model: 'superastra',
      permissions: 'bypass_permissions',
      agentSetupId: 'reviewer',
    });
    expect(updateSettingsCalls[0]).toEqual([result.chatId, 'user-1', { effort: 'high' }, 'tok']);
    expect(bufferCalls[0][1]).toBe(result.chatId);
    expect(emitted.find((event) => event.event === 'chat:forked')?.payload).toEqual({
      oldChatId: 'codex:thread-source',
      newChatId: result.chatId,
    });
  });

  it('forks an adopted external Codex row when stop-on-PC is unavailable', async () => {
    const { svc, context, saveChatCalls, bufferCalls } = makeService(
      { origin: 'sqlite', provider: 'codex' },
      undefined,
      undefined,
      {
        chat: {
          provider: 'codex',
          session_id: 'thread-source',
          title: 'Adopted Codex thread',
          repo_path: '/ws/codex-app',
          model: 'supersol',
          permissions: 'ask_each_time',
          agent_setup_id: 'freestyle',
        },
      }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'continue safely',
    });

    expect(result.chatId).not.toBe('codex:thread-source');
    expect(saveChatCalls[0].forkSourceSessionId).toBe('thread-source');
    expect(bufferCalls[0][1]).toBe(result.chatId);
  });

  it('does not stop or fork a Portable-owned in-memory Codex session', async () => {
    const stopCalls: string[] = [];
    const { svc, context, saveChatCalls, bufferCalls } = makeService(
      { origin: 'sqlite', provider: 'codex' },
      undefined,
      {
        stop: async (sessionId) => {
          stopCalls.push(sessionId);
          return { stopped: true, reason: 'stopped' };
        },
      },
      {
        chat: { provider: 'codex', session_id: 'thread-source', model: 'supersol' },
        codexSession: { chatId: 'codex:thread-source', threadId: 'thread-source', state: 'idle' },
      }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'continue portable session',
    });

    expect(result.chatId).toBe('codex:thread-source');
    expect(stopCalls).toHaveLength(0);
    expect(saveChatCalls).toHaveLength(0);
    expect(bufferCalls[0][1]).toBe('codex:thread-source');
  });

  it('does not stop a normal Portable Codex row whose chat id is not its thread id', async () => {
    const stopCalls: string[] = [];
    const { svc, context, saveChatCalls, bufferCalls } = makeService(
      { origin: 'sqlite', provider: 'codex' },
      undefined,
      {
        stop: async (sessionId) => {
          stopCalls.push(sessionId);
          return { stopped: true, reason: 'stopped' };
        },
      },
      {
        chat: { provider: 'codex', session_id: 'thread-source', model: 'supersol' },
      }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'chat-portable',
      content: 'continue portable session',
    });

    expect(result.chatId).toBe('chat-portable');
    expect(stopCalls).toHaveLength(0);
    expect(saveChatCalls).toHaveLength(0);
    expect(bufferCalls[0][1]).toBe('chat-portable');
  });

  it('does not stop an external Codex process when Codex is unavailable locally', async () => {
    const stopCalls: string[] = [];
    const { svc, context } = makeService(
      { origin: 'sqlite', provider: 'codex' },
      undefined,
      {
        stop: async (sessionId) => {
          stopCalls.push(sessionId);
          return { stopped: true, reason: 'stopped' };
        },
      },
      {
        codexServiceAvailable: false,
        chat: { provider: 'codex', session_id: 'thread-source', model: 'supersol' },
      }
    );

    const result = await svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'continue portable session',
    });

    expect(result.chatId).toBe('codex:thread-source');
    expect(stopCalls).toHaveLength(0);
  });

  it('rejects a second interactive send before buffering while Codex handoff is in progress', async () => {
    let markStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    let releaseStop!: () => void;
    const stopReleased = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const { svc, context, bufferCalls } = makeService(
      { origin: 'sqlite', provider: 'codex' },
      undefined,
      {
        stop: async () => {
          markStopStarted();
          await stopReleased;
          return { stopped: true, reason: 'stopped' };
        },
      },
      {
        chat: {
          provider: 'codex',
          session_id: 'thread-source',
          title: 'Adopted Codex thread',
          model: 'supersol',
        },
      }
    );

    const first = svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'first message',
    });
    await stopStarted;

    const second = await svc.handleChatMessage(context, {
      chatId: 'codex:thread-source',
      content: 'second message',
    });

    expect(second).toEqual({
      success: false,
      error: 'This Codex chat is already being handed off',
    });
    expect(bufferCalls).toHaveLength(0);

    releaseStop();
    expect((await first).success).toBe(true);
    expect(bufferCalls).toHaveLength(1);
  });
});

describe('fork-on-first-write — executeMessage chokepoint (non-socket callers)', () => {
  it('forks a discovered chat before resuming, retargeting downstream to the new id', async () => {
    // The durability guard: a caller that BYPASSES handleChatMessage (e.g. the
    // portable_execute cross-chat send) must still never resume a CC transcript.
    const saveChatCalls: any[] = [];
    let restoreCalledWith: string | null = null;

    const fakeChatService: any = {
      getChatOrigin: async (): Promise<ChatOrigin> => ({
        origin: 'discovered',
        sourceSessionId: 'cc-src',
        cwd: '/ws/app',
        repoPath: '/ws/app',
        repoFullName: 'me/app',
        title: 'CC chat',
        lastUpdated: COLD,
      }),
      saveChat: async (opts: any) => {
        saveChatCalls.push(opts);
        return true;
      },
      getChat: async (chatId: string) => ({
        id: chatId,
        model: 'opus',
        permissions: 'default',
        agent_setup_id: 'freestyle',
      }),
      bufferMessage: async () => {},
    };

    const emitted: string[] = [];
    const emitter: any = {
      emit: () => {},
      emitToUser: (_userId: string, event: string) => emitted.push(event),
      joinUserToRoom: () => {},
    };

    // Stop the flow right after retargeting (before the heavy startNewSession path) by
    // throwing a sentinel from the first downstream call, capturing the chatId it saw.
    const fakeClaudeService: any = {
      restoreSessionFromDatabase: async (chatId: string) => {
        restoreCalledWith = chatId;
        throw new Error('__STOP__');
      },
    };
    const fakeDedup: any = { isDuplicate: () => false, addHash: () => {} };

    const svc = new ChatExecutionService(
      fakeChatService,
      fakeClaudeService,
      {} as any, // gitLocalService
      fakeDedup,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );

    const context = {
      chatId: 'cc-src',
      userId: 'user-1',
      username: 'user-1',
      authToken: 'tok',
      emitter,
    } as unknown as ExecutionContext;

    await expect(svc.executeMessage(context, { content: 'hi' }, {})).rejects.toThrow('__STOP__');

    // A new Portable chat was claimed from the CC source...
    expect(saveChatCalls).toHaveLength(1);
    const newId = saveChatCalls[0].chatId as string;
    expect(newId.startsWith('chat-')).toBe(true);
    expect(saveChatCalls[0].forkSourceSessionId).toBe('cc-src');
    // ...and every downstream step targets the NEW id, never the CC session id.
    expect(restoreCalledWith).toBe(newId);
    expect(restoreCalledWith).not.toBe('cc-src');
    expect(emitted).toContain('chat:forked');
  });

  it('NEVER stops-on-send from the headless chokepoint (D63 is interactive-only)', async () => {
    // A portable_execute cross-chat send hitting a terminal-LIVE discovered chat
    // must fork exactly as before — an automated pipeline must never kill the
    // user's live terminal session.
    const saveChatCalls: any[] = [];
    const stopCalls: string[] = [];

    const fakeChatService: any = {
      getChatOrigin: async (): Promise<ChatOrigin> => ({
        origin: 'discovered',
        sourceSessionId: 'cc-src',
        cwd: '/ws/app',
        repoPath: '/ws/app',
        repoFullName: 'me/app',
        title: 'CC chat',
        lastUpdated: Date.now() - 1000, // hot — live terminal
      }),
      saveChat: async (opts: any) => {
        saveChatCalls.push(opts);
        return true;
      },
      getChat: async (chatId: string) => ({
        id: chatId,
        model: 'opus',
        permissions: 'default',
        agent_setup_id: 'freestyle',
      }),
      bufferMessage: async () => {},
    };
    const emitter: any = { emit: () => {}, emitToUser: () => {}, joinUserToRoom: () => {} };
    const fakeClaudeService: any = {
      restoreSessionFromDatabase: async () => {
        throw new Error('__STOP__');
      },
    };
    const fakeDedup: any = { isDuplicate: () => false, addHash: () => {} };
    const liveRegistry: any = {
      isLive: () => true,
      getSession: () => endedRow({ state: 'live-running', pid: 4242, pidConfirmed: true }),
    };
    const stopOnPc: any = {
      stop: async (sessionId: string) => {
        stopCalls.push(sessionId);
        return { stopped: true, reason: 'stopped' };
      },
    };

    const svc = new ChatExecutionService(
      fakeChatService,
      fakeClaudeService,
      {} as any,
      fakeDedup,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // claudeCodeSessions
      undefined, // reposCacheService
      undefined, // handshakeVerificationGate
      liveRegistry, // rev12: adopt-vs-fork gate
      stopOnPc // rev12 D63 — injected but must stay unused on this path
    );

    const context = {
      chatId: 'cc-src',
      userId: 'user-1',
      username: 'user-1',
      authToken: 'tok',
      emitter,
    } as unknown as ExecutionContext;

    await expect(svc.executeMessage(context, { content: 'hi' }, {})).rejects.toThrow('__STOP__');

    expect(stopCalls).toHaveLength(0); // the terminal session was never touched
    expect(saveChatCalls[0].forkSourceSessionId).toBe('cc-src'); // forked as before
  });
});
