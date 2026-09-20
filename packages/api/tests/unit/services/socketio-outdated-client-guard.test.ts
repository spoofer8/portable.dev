/**
 * Integration of the outdated-build kill switch INTO the Socket.IO
 * `chat:message` handler (SocketIOService.setupChatHandlers).
 *
 * The service primitives (`shouldBlockOutdatedClient`, `emitOutdatedClientNotice`)
 * are unit-tested in chat-session-lifecycle.test.ts. This file covers the thin —
 * but load-bearing — glue that the kill switch exists to drive:
 *   - the guard genuinely AWAITS the (async) flag check before deciding. A dropped
 *     `await` would make `if (Promise)` always truthy and block EVERY client; the
 *     "gate OFF ⇒ proceeds normally" case below fails loudly if the await is lost.
 *   - when blocked: the socket JOINS the room BEFORE the notice is emitted (else the
 *     sender never receives it), the ephemeral notice fires, `handleChatMessage`
 *     (persistence / user_message echo / execution) NEVER runs, and the ack succeeds.
 *   - when not blocked: `handleChatMessage` proceeds and NO notice is emitted.
 *
 * We capture the real handler by calling the private `setupChatHandlers` on a
 * prototype instance (no constructor → no io server / intervals) with a fake socket
 * that records `socket.on(...)` registrations, then invoke `chat:message` directly.
 */
import { describe, expect, it, mock } from 'bun:test';

import { SocketIOService } from '../../../src/services/SocketIOService';

/**
 * Build a SocketIOService whose `chat:message` handler is reachable, with the
 * collaborators the guard touches stubbed. `gateBlocks` drives
 * `shouldBlockOutdatedClient` (returned as a Promise so the test also exercises
 * the `await`). Returns the captured handler + spies + an ordered call log.
 */
function harness(gateBlocks: boolean) {
  const order: string[] = [];

  const shouldBlockOutdatedClient = mock(async () => gateBlocks);
  const emitOutdatedClientNotice = mock(() => {
    order.push('notice');
  });
  const handleChatMessage = mock(async () => {
    order.push('handleChatMessage');
    return {
      success: true,
      effectiveContent: 'hi',
      effectiveModel: 'sonnet',
      effectivePermissions: 'default',
      effectiveAgentSetupId: 'setup-1',
      codexHandoffConfirmed: true,
    };
  });
  const executeMessage = mock(async () => {});

  const chatExecutionService = {
    shouldBlockOutdatedClient,
    emitOutdatedClientNotice,
    handleChatMessage,
    executeMessage,
  } as any;

  const emit = mock(() => {});
  const io = { sockets: { sockets: new Map() } } as any;

  // Prototype instance: real methods, no constructor (no io server, no intervals).
  const service: any = Object.create(SocketIOService.prototype);
  service.io = io;
  service.chatExecutionService = chatExecutionService;
  service.idleTimerService = undefined;
  // Own-property stubs shadow the prototype methods the handler calls.
  service.updateSocketActivity = () => {};
  service.buildExecutionContext = (_socket: any, chatId: string) => ({
    chatId,
    userId: 'alice@example.com',
    username: 'alice',
    authToken: 't',
    emitter: { emit: () => {} },
  });

  // Fake socket: records `on` registrations, tracks room membership + join order.
  const rooms = new Set<string>();
  const joined: string[] = [];
  const registrations: Record<string, (...args: any[]) => any> = {};
  const socket = {
    id: 'sock-1',
    data: { userEmail: 'alice@example.com', username: 'alice' },
    rooms,
    emit,
    join: mock((room: string) => {
      order.push('join');
      joined.push(room);
      rooms.add(room);
    }),
    on: (event: string, handler: (...args: any[]) => any) => {
      registrations[event] = handler;
    },
  };
  io.sockets.sockets.set(socket.id, socket);

  service.setupChatHandlers(socket);
  const chatMessage = registrations['chat:message'];
  if (!chatMessage) throw new Error('chat:message handler was not registered');

  return {
    chatMessage,
    joined,
    order,
    spies: {
      shouldBlockOutdatedClient,
      emitOutdatedClientNotice,
      handleChatMessage,
      executeMessage,
      emit,
    },
  };
}

describe('SocketIOService chat:message — kill-switch guard', () => {
  it('blocks an outdated client when the kill switch is ON: joins room → notice → no Claude run → ack', async () => {
    const h = harness(/* gateBlocks */ true);
    const callback = mock(() => {});

    await h.chatMessage({ chatId: 'chat-1', content: 'hello' }, callback);

    expect(h.spies.shouldBlockOutdatedClient).toHaveBeenCalledTimes(1);
    expect(h.spies.emitOutdatedClientNotice).toHaveBeenCalledTimes(1);
    // The block must NOT persist / echo / execute anything.
    expect(h.spies.handleChatMessage).not.toHaveBeenCalled();
    // Room joined so the ephemeral notice actually reaches the sender, BEFORE the emit.
    expect(h.joined).toEqual(['chat-1']);
    expect(h.order).toEqual(['join', 'notice']);
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it('proceeds normally when the kill switch is OFF (catches a dropped await / inverted guard)', async () => {
    const h = harness(/* gateBlocks */ false);
    const callback = mock(() => {});

    await h.chatMessage({ chatId: 'chat-1', messageId: 'm1', content: 'hello' }, callback);

    expect(h.spies.shouldBlockOutdatedClient).toHaveBeenCalledTimes(1);
    // A dropped `await` would make `if (Promise)` truthy and wrongly block here.
    expect(h.spies.emitOutdatedClientNotice).not.toHaveBeenCalled();
    expect(h.spies.handleChatMessage).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.spies.executeMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ codexHandoffConfirmed: true })
    );
  });
});

/**
 * setupAuth rejections must carry machine-readable `err.data.code` (socket.io
 * delivers `err.data` to the client's connect_error). Prototype-instance
 * harness: `setupAuth` registers on a fake `io.use`, then we invoke it directly.
 */
describe('SocketIOService setupAuth — machine-readable connect_error codes', () => {
  type AuthMiddleware = (socket: any, next: (err?: Error) => void) => Promise<void> | void;

  function authHarness(opts: {
    authResult: any;
    e2eConfigured?: boolean;
    e2eKeys?: unknown;
  }): AuthMiddleware {
    const service: any = Object.create(SocketIOService.prototype);
    let middleware: AuthMiddleware | undefined;
    service.io = {
      use: (fn: AuthMiddleware) => {
        middleware = fn;
      },
    };
    service.authService = { validateSocketAuth: mock(async () => opts.authResult) };
    service.e2eSessionService = opts.e2eConfigured
      ? { isConfigured: () => true, getSessionKeys: () => opts.e2eKeys }
      : undefined;
    service.setupAuth();
    if (!middleware) throw new Error('setupAuth did not register the io.use middleware');
    return middleware;
  }

  async function reject(mw: AuthMiddleware, auth: Record<string, unknown>): Promise<any> {
    let captured: Error | undefined;
    await mw({ handshake: { auth, headers: {} }, data: {} }, (err?: Error) => {
      captured = err;
    });
    return captured;
  }

  it("attaches data.code 'token_expired' to the expired-JWT rejection (message unchanged)", async () => {
    const mw = authHarness({
      authResult: { valid: false, error: 'Token has expired', code: 'token_expired' },
    });
    const err = await reject(mw, { token: 'expired.jwt.token' });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Token has expired');
    expect(err.data).toEqual({ code: 'token_expired' });
  });

  it('attaches NO data to a code-less rejection (nothing to machine-read)', async () => {
    const mw = authHarness({ authResult: { valid: false, error: 'Invalid authentication' } });
    const err = await reject(mw, { token: 'garbage' });
    expect(err.message).toBe('Invalid authentication');
    expect(err.data).toBeUndefined();
  });

  it("attaches data.code 'e2e_session_required' to the missing-E2E-session rejection", async () => {
    const mw = authHarness({
      authResult: { valid: true, userEmail: 'alice@example.com', username: 'alice' },
      e2eConfigured: true,
      e2eKeys: undefined,
    });
    const err = await reject(mw, { token: 'valid.jwt.token' });
    expect(err.message).toBe('E2E session required');
    expect(err.data).toEqual({ code: 'e2e_session_required' });
  });
});
