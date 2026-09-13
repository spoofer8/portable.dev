/**
 * RN socket provider on the shared core.
 *
 * Drives the native Socket.IO provider end-to-end with a mocked Socket.IO server
 * (the virtual `socket.io-client` mock) and injected AppState + NetInfo
 * controllers, asserting:
 *
 *   1. the provider reconnects + resyncs joined rooms when AppState transitions
 *      to `active`;
 *   2. the provider reconnects + resyncs on an offline → online NetInfo
 *      transition;
 *   3. `socketio:connected` / `socketio:disconnected` / `socketio:reconnecting`
 *      surface as Zustand state (`useSocketStore`) — never `window.dispatchEvent`;
 *   4. `chat:created` surfaces as Zustand state AND the `onChatCreated` callback —
 *      again never `window.dispatchEvent`.
 */

// Hoisted above imports: route `createSocket()`'s `io()` to our mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The socket barrel now re-exports the offline-queue hook, which
// transitively imports the MMKV-backed offline queue store. MMKV is a native
// nitro module — mock it so importing the barrel doesn't load the JSI module.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => store.delete(key),
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance };
});

import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  type CreateSocketOptions,
  type SocketLike,
} from '@vgit2/shared/socket';
import { getRepoFromPath } from '@vgit2/shared/utils/pathHelpers';
import {
  optimisticRepoPath,
  useChatChromeStore,
} from '../src/features/chat/chrome/chatChromeStore';
import {
  ReconnectingBanner,
  SocketProvider,
  useSocket,
  useSocketStore,
  type NativeSocket,
} from '../src/features/socket';
import { configureE2eSessions, __resetE2eSessions } from '../src/features/api/e2eSessionManager';
import type { AppStateLike, NetInfoLike, AppStateStatus } from '../src/features/socket';
import { createMockSocket, type MockSocketController, type MockSocketIoModule } from '../src/test';

/** The controller backing the single socket the mocked `io()` hands out. */
const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;

/** Resolve the payload the callback-form `auth` option produces for one attempt. */
function resolveAuthPayload(auth: unknown): Promise<Record<string, unknown>> {
  expect(typeof auth).toBe('function');
  return new Promise((resolve) => {
    (auth as (cb: (data: Record<string, unknown>) => void) => void)(resolve);
  });
}

/** Imperatively-driven AppState mock. */
function createAppStateController(): { appState: AppStateLike; emit: (s: AppStateStatus) => void } {
  let listener: ((s: AppStateStatus) => void) | null = null;
  return {
    appState: {
      currentState: 'active',
      addEventListener: (_type, l) => {
        listener = l;
        return {
          remove: () => {
            listener = null;
          },
        };
      },
    },
    emit: (s) => listener?.(s),
  };
}

/** Imperatively-driven NetInfo mock. */
function createNetInfoController(): { netInfo: NetInfoLike; emit: (isConnected: boolean) => void } {
  let listener: ((s: { isConnected: boolean | null }) => void) | null = null;
  return {
    netInfo: {
      addEventListener: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    emit: (isConnected) => listener?.({ isConnected }),
  };
}

/** Renders the live connection state from the Zustand store (no DOM events). */
function StateProbe() {
  const connectionState = useSocketStore((s) => s.connectionState);
  const lastCreatedChatId = useSocketStore((s) => s.lastCreatedChatId);
  const directoryRevision = useSocketStore((s) => s.directoryRevision);
  return (
    <>
      <Text testID="conn">{connectionState}</Text>
      <Text testID="created">{lastCreatedChatId ?? 'none'}</Text>
      <Text testID="directory-revision">{directoryRevision}</Text>
    </>
  );
}

/** Captures the imperative socket API so the test can call `joinChat`. */
function CaptureApi({ onReady }: { onReady: (api: NativeSocket) => void }) {
  const api = useSocket();
  onReady(api);
  return null;
}

const joinEmissions = () => controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_JOIN);

describe('RN socket provider on the shared core', () => {
  let appCtl: ReturnType<typeof createAppStateController>;
  let netCtl: ReturnType<typeof createNetInfoController>;

  async function mountProvider(opts: { onChatCreated?: (id: string) => void } = {}): Promise<{
    api: NativeSocket;
  }> {
    const apiHolder: { api: NativeSocket | null } = { api: null };
    render(
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
        onChatCreated={opts.onChatCreated}
      >
        <CaptureApi onReady={(a) => (apiHolder.api = a)} />
        <StateProbe />
      </SocketProvider>
    );
    // Flush the async socket-creation effect (resolves token + sandbox URL, binds handlers).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return { api: apiHolder.api! };
  }

  beforeEach(() => {
    appCtl = createAppStateController();
    netCtl = createNetInfoController();
  });

  afterEach(() => {
    act(() => {
      useSocketStore.getState().reset();
      useChatChromeStore.getState().reset();
    });
    controller.reset();
    __resetE2eSessions();
  });

  it('reconnects + resyncs joined rooms when AppState transitions to active', async () => {
    const { api } = await mountProvider();

    // Initial connect → Zustand state 'connected' (replaces socketio:connected DOM event).
    act(() => {
      controller.setConnected(true);
    });
    expect(screen.getByTestId('conn').props.children).toBe('connected');

    // Join a room (tracked for resync) — emits chat:join once.
    await act(async () => {
      await api.joinChat({ chatId: 'chat-1', limit: 50, offset: 0 });
    });
    expect(joinEmissions()).toHaveLength(1);

    // Socket drops → Zustand 'disconnected' (replaces socketio:disconnected DOM event).
    act(() => {
      controller.setConnected(false);
    });
    expect(screen.getByTestId('conn').props.children).toBe('disconnected');

    // Foreground (AppState 'active') → reconnect + resync (rejoin chat-1).
    act(() => {
      appCtl.emit('active');
    });
    expect(screen.getByTestId('conn').props.children).toBe('connected');
    // Resync re-emitted chat:join for the tracked room.
    expect(joinEmissions()).toHaveLength(2);
    expect(joinEmissions()[1].args[0]).toMatchObject({ chatId: 'chat-1' });
  });

  it("surfaces the 'reconnecting' phase as Zustand state while reconnecting", async () => {
    await mountProvider();

    act(() => {
      controller.setConnected(true);
    });
    act(() => {
      controller.setConnected(false);
    });
    // A connect_error during reconnection surfaces as Zustand 'reconnecting' state
    // (this replaces the old window.dispatchEvent('socketio:reconnecting')).
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, new Error('boom'));
    });
    expect(screen.getByTestId('conn').props.children).toBe('reconnecting');
  });

  it('recovers a stale E2E session on connect_error (drop + rebuild with a fresh handshake)', async () => {
    // Configure the E2E manager so isE2eConfigured() is true (the recovery gate)
    // with a resolvable pcId so dropConnectedE2eSession can evict.
    configureE2eSessions({
      outerFetch: async () => ({}) as unknown as Response,
      getPcId: async () => 'pc-1',
      getE2eKey: async () => 'a2V5',
      getRelayBase: async () => 'https://sandbox.portable.test',
    });
    const fakeSession = {
      sessionId: 'sid-1',
      keys: { c2s: new Uint8Array(32), s2c: new Uint8Array(32) },
    };
    // The injected resolver stands in for the per-PC handshake; each call = one
    // fresh handshake, so its call count is the observable rebuild signal.
    const getE2eSession = jest.fn(async () => fakeSession);

    const apiHolder: { api: NativeSocket | null } = { api: null };
    render(
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
        getE2eSession={getE2eSession}
      >
        <CaptureApi onReady={(a) => (apiHolder.api = a)} />
        <StateProbe />
      </SocketProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Initial build handshakes exactly once.
    expect(getE2eSession).toHaveBeenCalledTimes(1);

    // The PC's api restarted → it rejects the socket's now-orphan e2eSid. socket.io
    // would retry the SAME dead sid forever; the recovery must drop + re-handshake.
    await act(async () => {
      controller.emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, new Error('E2E session required'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getE2eSession).toHaveBeenCalledTimes(2);
  });

  it('reconnects + resyncs on an offline → online NetInfo transition', async () => {
    const { api } = await mountProvider();

    act(() => {
      controller.setConnected(true);
    });
    await act(async () => {
      await api.joinChat({ chatId: 'chat-2', limit: 50, offset: 0 });
    });

    // Go offline (socket drops), then back online → proactive reconnect + resync.
    act(() => {
      controller.setConnected(false);
      netCtl.emit(false);
    });
    expect(screen.getByTestId('conn').props.children).toBe('disconnected');

    act(() => {
      netCtl.emit(true);
    });
    expect(screen.getByTestId('conn').props.children).toBe('connected');
    expect(joinEmissions()).toHaveLength(2); // initial + reconnect resync
  });

  it("surfaces 'chat:created' via Zustand state + onChatCreated callback (not window.dispatchEvent)", async () => {
    const onChatCreated = jest.fn();
    const dispatchSpy =
      typeof globalThis !== 'undefined' && (globalThis as { dispatchEvent?: unknown }).dispatchEvent
        ? jest.spyOn(globalThis as unknown as { dispatchEvent: () => boolean }, 'dispatchEvent')
        : null;

    await mountProvider({ onChatCreated });

    act(() => {
      controller.setConnected(true);
      controller.emitServerEvent(SERVER_EVENTS.CHAT_CREATED, {
        chat: { id: 'chat-xyz', repo_path: '/workspace/claude-workspace/u/acme/widget' },
      });
    });

    expect(screen.getByTestId('created').props.children).toBe('chat-xyz');
    expect(onChatCreated).toHaveBeenCalledWith('chat-xyz');
    expect(useSocketStore.getState().lastCreatedChatId).toBe('chat-xyz');
    // The broadcast chat's repo_path is folded into the chrome store — the only
    // repoPath source for a chat opened straight from creation (repo hand-off),
    // which never exists in the chat-directory query cache.
    expect(useChatChromeStore.getState().repoPaths['chat-xyz']).toBe(
      '/workspace/claude-workspace/u/acme/widget'
    );
    if (dispatchSpy) {
      expect(dispatchSpy).not.toHaveBeenCalled();
      dispatchSpy.mockRestore();
    }
  });

  it('records only newer chat directory revisions', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_DIRECTORY_CHANGED, {
        revision: 4,
        providers: ['claude', 'codex'],
      });
      controller.emitServerEvent(SERVER_EVENTS.CHAT_DIRECTORY_CHANGED, { revision: 4 });
      controller.emitServerEvent(SERVER_EVENTS.CHAT_DIRECTORY_CHANGED, { revision: 3 });
    });
    expect(screen.getByTestId('directory-revision').props.children).toBe(4);

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_DIRECTORY_CHANGED, { revision: 5 });
    });
    expect(screen.getByTestId('directory-revision').props.children).toBe(5);
  });

  it("records 'chat:forked' into lastForkedChat (the redirect signal) with a monotonic seq", async () => {
    await mountProvider();

    act(() => {
      controller.setConnected(true);
      controller.emitServerEvent(SERVER_EVENTS.CHAT_FORKED, {
        oldChatId: 'cc-sess',
        newChatId: 'chat-fork-1',
      });
    });

    const first = useSocketStore.getState().lastForkedChat;
    expect(first).toEqual({ oldChatId: 'cc-sess', newChatId: 'chat-fork-1', seq: 1 });

    // A second fork (even of a different pair) bumps seq so the consumer effect re-fires.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_FORKED, {
        oldChatId: 'cc-sess-2',
        newChatId: 'chat-fork-2',
      });
    });
    expect(useSocketStore.getState().lastForkedChat).toEqual({
      oldChatId: 'cc-sess-2',
      newChatId: 'chat-fork-2',
      seq: 2,
    });

    // A malformed event (missing newChatId) is ignored.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_FORKED, { oldChatId: 'x' });
    });
    expect(useSocketStore.getState().lastForkedChat?.seq).toBe(2);
  });

  // a chat opened straight from creation (repo Overview hand-off, home
  // composer, task viewer) must show the git banner even when the server's
  // `chat:created` broadcast is missing (older backend): the provider's
  // `createChat` seeds an optimistic, `getRepoFromPath`-parseable repo path on a
  // successful ack, and the authoritative broadcast value always wins over it.
  describe('optimistic repo-path seed on chat:create', () => {
    const createPayload = {
      chatId: 'chat-new',
      type: 'claude_code' as const,
      title: 'work on widget',
      owner: 'acme',
      repo: 'widget',
      model: 'sonnet',
      permissions: 'bypass_permissions',
      agentSetupId: 'best-practice',
    };

    it('seeds a parseable repo path for the created chat on a successful ack', async () => {
      const { api } = await mountProvider();
      act(() => {
        controller.setConnected(true);
      });

      await act(async () => {
        await api.emitters.createChat(createPayload);
      });

      const seeded = useChatChromeStore.getState().repoPaths['chat-new'];
      expect(seeded).toBe(optimisticRepoPath('acme', 'widget'));
      // The contract the git banner actually needs: owner/repo parse out of it.
      expect(getRepoFromPath(seeded)).toBe('acme/widget');
    });

    it('does not seed when the chat:create ack fails', async () => {
      const { api } = await mountProvider();
      act(() => {
        controller.setConnected(true);
        controller.setAck(CLIENT_EVENTS.CHAT_CREATE, { success: false, error: 'prepare failed' });
      });

      await act(async () => {
        await api.emitters.createChat(createPayload);
      });

      expect(useChatChromeStore.getState().repoPaths['chat-new']).toBeUndefined();
    });

    it('lets the authoritative chat:created repo_path overwrite the seed', async () => {
      const { api } = await mountProvider();
      act(() => {
        controller.setConnected(true);
      });

      await act(async () => {
        await api.emitters.createChat(createPayload);
      });
      act(() => {
        controller.emitServerEvent(SERVER_EVENTS.CHAT_CREATED, {
          chat: { id: 'chat-new', repo_path: '/workspace/claude-workspace/u@x.com/acme/widget' },
        });
      });

      expect(useChatChromeStore.getState().repoPaths['chat-new']).toBe(
        '/workspace/claude-workspace/u@x.com/acme/widget'
      );
    });

    it('never overwrites an already-arrived authoritative path (broadcast-before-ack order)', async () => {
      const { api } = await mountProvider();
      act(() => {
        controller.setConnected(true);
        // On the creating socket the server emits `chat:created` BEFORE the ack —
        // simulate the broadcast landing first, then resolve the create.
        controller.emitServerEvent(SERVER_EVENTS.CHAT_CREATED, {
          chat: { id: 'chat-new', repo_path: '/workspace/claude-workspace/u@x.com/acme/widget' },
        });
      });

      await act(async () => {
        await api.emitters.createChat(createPayload);
      });

      expect(useChatChromeStore.getState().repoPaths['chat-new']).toBe(
        '/workspace/claude-workspace/u@x.com/acme/widget'
      );
    });
  });

  it('unmount stops the io manager BEFORE disconnecting — no queued retry against a dead URL', async () => {
    // With reconnectionAttempts: Infinity, a queued manager retry could still
    // hit the (possibly dead) sandbox URL after the provider unmounts. The
    // teardown must call io.reconnection(false) FIRST, then disconnect — the
    // sandbox-death epoch remount relies on this to silence the old transport.
    const calls: string[] = [];
    const local = createMockSocket({ connected: true });
    const sock = local.socket as SocketLike & { io?: { reconnection: (v: boolean) => void } };
    sock.io = { reconnection: (v: boolean) => calls.push(`reconnection:${v}`) };
    const baseDisconnect = sock.disconnect?.bind(sock);
    sock.disconnect = () => {
      calls.push('disconnect');
      baseDisconnect?.();
    };

    const utils = render(
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
        createSocketImpl={
          (() => sock) as unknown as typeof import('@vgit2/shared/socket').createSocket
        }
      >
        <StateProbe />
      </SocketProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    utils.unmount();

    expect(calls).toEqual(['reconnection:false', 'disconnect']);
  });

  // the handshake reports this build's app version so the backend can
  // detect pre-handshake (outdated) native builds and block them with an
  // "update your app" notice. An up-to-date build sends `auth.appVersion`; an
  // older build (or one whose version can't be read) sends only the token.
  describe('app version handshake', () => {
    function recordingProvider(
      getAppVersion?: () => string | undefined,
      getDeviceName: () => string | undefined = () => undefined
    ) {
      const calls: Array<{ token: string | null; url: string; opts: CreateSocketOptions }> = [];
      const factory = (
        token: string | null,
        url: string,
        opts?: CreateSocketOptions
      ): SocketLike => {
        calls.push({ token, url, opts: opts ?? {} });
        return createMockSocket({ connected: true }).socket;
      };
      render(
        <SocketProvider
          getAuthToken={async () => 'token-abc'}
          getRelayUrl={async () => 'https://sandbox.portable.test'}
          appState={appCtl.appState}
          netInfo={netCtl.netInfo}
          getAppVersion={getAppVersion}
          getDeviceName={getDeviceName}
          createSocketImpl={
            factory as unknown as typeof import('@vgit2/shared/socket').createSocket
          }
        >
          <StateProbe />
        </SocketProvider>
      );
      return calls;
    }

    it('sends the build version in the handshake auth', async () => {
      const calls = recordingProvider(() => '1.5.0');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls).toHaveLength(1);
      await expect(resolveAuthPayload(calls[0].opts.auth)).resolves.toEqual({
        token: 'token-abc',
        appVersion: '1.5.0',
      });
    });

    it('omits appVersion when the build version is unavailable (older build)', async () => {
      const calls = recordingProvider(() => undefined);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls).toHaveLength(1);
      await expect(resolveAuthPayload(calls[0].opts.auth)).resolves.toEqual({
        token: 'token-abc',
      });
    });

    it('sends the device make/model in the handshake auth', async () => {
      const calls = recordingProvider(
        () => '1.5.0',
        () => 'Apple iPhone 15 Pro'
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls).toHaveLength(1);
      await expect(resolveAuthPayload(calls[0].opts.auth)).resolves.toEqual({
        token: 'token-abc',
        appVersion: '1.5.0',
        deviceName: 'Apple iPhone 15 Pro',
      });
    });
  });

  // The handshake auth is the CALLBACK form — the persisted token is re-read on
  // every (re)connect attempt; a typed `token_expired` rejection renews + rebuilds.
  describe('renewable socket credential (portable.dev#24)', () => {
    const fakeSession = {
      sessionId: 'sid-build',
      keys: { c2s: new Uint8Array(32), s2c: new Uint8Array(32) },
    };
    const e2eManagerConfig = {
      outerFetch: async () => ({}) as unknown as Response,
      getPcId: async () => 'pc-1',
      getE2eKey: async () => 'a2V5',
      getRelayBase: async () => 'https://sandbox.portable.test',
    };

    /** One fresh mock socket per build — mirrors `io()` minting a new socket. */
    function freshSocketFactory() {
      const sockets: MockSocketController[] = [];
      const calls: CreateSocketOptions[] = [];
      /** Build indices whose socket received `disconnect()` — teardown proof. */
      const disconnects: number[] = [];
      const factory = (
        _token: string | null,
        _url: string,
        opts?: CreateSocketOptions
      ): SocketLike => {
        calls.push(opts ?? {});
        const ctl = createMockSocket({ connected: false });
        const index = sockets.length;
        const baseDisconnect = ctl.socket.disconnect?.bind(ctl.socket);
        ctl.socket.disconnect = () => {
          disconnects.push(index);
          return baseDisconnect?.();
        };
        sockets.push(ctl);
        return ctl.socket;
      };
      return { sockets, calls, disconnects, factory };
    }

    function mountCredentialProvider(opts: {
      getAuthToken: () => Promise<string | null>;
      factory: (token: string | null, url: string, o?: CreateSocketOptions) => SocketLike;
      renewDataPathToken?: () => Promise<string | null>;
      getE2eSession?: () => Promise<typeof fakeSession>;
    }) {
      return render(
        <SocketProvider
          getAuthToken={opts.getAuthToken}
          getRelayUrl={async () => 'https://sandbox.portable.test'}
          appState={appCtl.appState}
          netInfo={netCtl.netInfo}
          getAppVersion={() => '1.5.0'}
          getDeviceName={() => undefined}
          renewDataPathToken={opts.renewDataPathToken}
          getE2eSession={opts.getE2eSession}
          createSocketImpl={
            opts.factory as unknown as typeof import('@vgit2/shared/socket').createSocket
          }
        >
          <StateProbe />
        </SocketProvider>
      );
    }

    const flushDeep = () =>
      act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });

    const tokenExpiredError = () =>
      Object.assign(new Error('Token has expired'), { data: { code: 'token_expired' } });

    it('re-reads the persisted token on every connect attempt while e2eSid stays the build-time session', async () => {
      const getAuthToken = jest.fn(async (): Promise<string | null> => 'tok-1');
      const { calls, factory } = freshSocketFactory();
      mountCredentialProvider({
        getAuthToken,
        factory,
        getE2eSession: async () => fakeSession,
      });
      await flushDeep();
      expect(calls).toHaveLength(1);

      await expect(resolveAuthPayload(calls[0].auth)).resolves.toEqual({
        token: 'tok-1',
        appVersion: '1.5.0',
        e2eSid: 'sid-build',
      });

      // The next attempt carries the rotated token but the SAME build-time e2eSid —
      // per-frame sealing is keyed to it; a dead session rebuilds the socket instead.
      getAuthToken.mockResolvedValue('tok-2');
      await expect(resolveAuthPayload(calls[0].auth)).resolves.toEqual({
        token: 'tok-2',
        appVersion: '1.5.0',
        e2eSid: 'sid-build',
      });
    });

    it("renews + rebuilds on connect_error code 'token_expired' without burning the E2E recovery budget", async () => {
      configureE2eSessions(e2eManagerConfig);
      const getE2eSession = jest.fn(async () => fakeSession);
      const renewDataPathToken = jest.fn(async (): Promise<string | null> => 'fresh-token');
      const { sockets, factory } = freshSocketFactory();
      mountCredentialProvider({
        getAuthToken: async () => 'tok',
        factory,
        renewDataPathToken,
        getE2eSession,
      });
      await flushDeep();
      expect(sockets).toHaveLength(1);
      // Mid-session expiry, not a cold start (suppress the never-connected fallback).
      act(() => sockets[0].setConnected(true));

      // Drain a whole recovery budget's worth (MAX_E2E_RECOVERY_ATTEMPTS = 5) of expiries.
      for (let i = 1; i <= 5; i++) {
        await act(async () => {
          sockets[sockets.length - 1].emitServerEvent(
            SERVER_EVENTS.CONNECT_ERROR,
            tokenExpiredError()
          );
          for (let j = 0; j < 8; j++) await Promise.resolve();
        });
        expect(sockets).toHaveLength(1 + i);
      }
      expect(renewDataPathToken).toHaveBeenCalledTimes(5);
      expect(getE2eSession).toHaveBeenCalledTimes(6); // 1 initial + 5 token rebuilds

      // The E2E recovery budget is untouched: a stale-session rejection still recovers.
      await act(async () => {
        sockets[sockets.length - 1].emitServerEvent(
          SERVER_EVENTS.CONNECT_ERROR,
          new Error('E2E session required')
        );
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });
      expect(sockets).toHaveLength(7);
      expect(getE2eSession).toHaveBeenCalledTimes(7);
    });

    it('surfaces the terminal failed state when the renewal is rejected (pairing dead)', async () => {
      const renewDataPathToken = jest.fn(async (): Promise<string | null> => null);
      const { sockets, factory } = freshSocketFactory();
      mountCredentialProvider({ getAuthToken: async () => 'tok', factory, renewDataPathToken });
      await flushDeep();
      // Cold start with an already-expired token: the PC rejects the very first handshake.

      await act(async () => {
        sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, tokenExpiredError());
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });

      expect(renewDataPathToken).toHaveBeenCalledTimes(1);
      expect(sockets).toHaveLength(1);
      expect(useSocketStore.getState().connectionState).toBe('failed');
      expect(screen.getByTestId('conn').props.children).toBe('failed');
      expect(screen.getByTestId('connection-failed-banner')).toBeTruthy();
      expect(screen.queryByTestId('reconnecting-banner')).toBeNull();
    });

    // The terminal dead-pairing verdict must SILENCE the ConnectionHealthMonitor's
    // reconnect loop — its ticks would otherwise re-enable reconnection and re-trigger
    // the rejected renewal forever (banner flaps, phone hammers the PC).
    describe('terminal dead pairing silences the reconnect machinery', () => {
      it('a monitor-driven reconnect tick after the verdict never re-enables reconnection or re-renews', async () => {
        jest.useFakeTimers();
        try {
          const renewDataPathToken = jest.fn(async (): Promise<string | null> => null);
          const { sockets, factory } = freshSocketFactory();
          // Record the io manager's reconnection toggles: the verdict turns it
          // OFF; a leaked monitor tick would turn it back ON.
          const reconnectionCalls: boolean[] = [];
          const factoryWithIo = (
            token: string | null,
            url: string,
            o?: CreateSocketOptions
          ): SocketLike => {
            const sock = factory(token, url, o) as SocketLike & {
              io?: { reconnection: (v: boolean) => void };
            };
            sock.io = { reconnection: (v: boolean) => reconnectionCalls.push(v) };
            return sock;
          };
          mountCredentialProvider({
            getAuthToken: async () => 'tok',
            factory: factoryWithIo,
            renewDataPathToken,
          });
          await flushDeep();
          expect(sockets).toHaveLength(1);

          // Live connect then a tunnel drop → the monitor enters its silent reconnect loop.
          act(() => sockets[0].setConnected(true));
          act(() => sockets[0].setConnected(false));

          await act(async () => {
            sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, tokenExpiredError());
            for (let j = 0; j < 8; j++) await Promise.resolve();
          });
          expect(renewDataPathToken).toHaveBeenCalledTimes(1);
          expect(screen.getByTestId('conn').props.children).toBe('failed');
          expect(reconnectionCalls).toEqual([false]);

          // Run out every pending monitor timer: no tick may revive the machinery.
          await act(async () => {
            jest.advanceTimersByTime(60_000);
            for (let j = 0; j < 8; j++) await Promise.resolve();
          });
          expect(reconnectionCalls).toEqual([false]);
          expect(sockets).toHaveLength(1);
          expect(renewDataPathToken).toHaveBeenCalledTimes(1);
          expect(screen.getByTestId('conn').props.children).toBe('failed');
          expect(screen.getByTestId('connection-failed-banner')).toBeTruthy();
          expect(screen.queryByTestId('reconnecting-banner')).toBeNull();
        } finally {
          jest.useRealTimers();
        }
      });

      it('a straggling token_expired retry after the verdict never re-triggers the renewal (sticky failed)', async () => {
        const renewDataPathToken = jest.fn(async (): Promise<string | null> => null);
        const { sockets, factory } = freshSocketFactory();
        mountCredentialProvider({ getAuthToken: async () => 'tok', factory, renewDataPathToken });
        await flushDeep();

        await act(async () => {
          sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, tokenExpiredError());
          for (let j = 0; j < 8; j++) await Promise.resolve();
        });
        expect(renewDataPathToken).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('conn').props.children).toBe('failed');

        await act(async () => {
          sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, tokenExpiredError());
          for (let j = 0; j < 8; j++) await Promise.resolve();
        });
        expect(renewDataPathToken).toHaveBeenCalledTimes(1);
        expect(sockets).toHaveLength(1);
        expect(screen.getByTestId('conn').props.children).toBe('failed');
      });

      it('foreground/online edges cannot resurrect a dead pairing; a remount starts clean', async () => {
        const renewDataPathToken = jest.fn(async (): Promise<string | null> => null);
        const { sockets, factory } = freshSocketFactory();
        const utils = mountCredentialProvider({
          getAuthToken: async () => 'tok',
          factory,
          renewDataPathToken,
        });
        await flushDeep();

        await act(async () => {
          sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, tokenExpiredError());
          for (let j = 0; j < 8; j++) await Promise.resolve();
        });
        expect(screen.getByTestId('conn').props.children).toBe('failed');

        await act(async () => {
          appCtl.emit('active');
          netCtl.emit(false);
          netCtl.emit(true);
          for (let j = 0; j < 8; j++) await Promise.resolve();
        });
        expect(screen.getByTestId('conn').props.children).toBe('failed');
        expect(renewDataPathToken).toHaveBeenCalledTimes(1);

        utils.unmount();
        renewDataPathToken.mockResolvedValue('fresh-token');
        const remount = freshSocketFactory();
        mountCredentialProvider({
          getAuthToken: async () => 'tok',
          factory: remount.factory,
          renewDataPathToken,
        });
        await flushDeep();
        expect(remount.sockets).toHaveLength(1);
        expect(screen.getByTestId('conn').props.children).not.toBe('failed');

        await act(async () => {
          remount.sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, tokenExpiredError());
          for (let j = 0; j < 8; j++) await Promise.resolve();
        });
        expect(renewDataPathToken).toHaveBeenCalledTimes(2);
        expect(remount.sockets).toHaveLength(2); // renew + rebuild — machinery alive again
      });
    });

    it('suppresses the never-connected E2E recovery while a token renewal is in flight (one rebuild, no zombie)', async () => {
      configureE2eSessions(e2eManagerConfig);
      const getE2eSession = jest.fn(async () => fakeSession);
      // Multi-RTT renewal: held pending so a retry error can land mid-renewal.
      let resolveRenew!: (v: string | null) => void;
      const renewDataPathToken = jest.fn(
        () =>
          new Promise<string | null>((r) => {
            resolveRenew = r;
          })
      );
      const { sockets, disconnects, factory } = freshSocketFactory();
      mountCredentialProvider({
        getAuthToken: async () => 'tok',
        factory,
        renewDataPathToken,
        getE2eSession,
      });
      await flushDeep();
      expect(sockets).toHaveLength(1);

      await act(async () => {
        sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, tokenExpiredError());
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });
      expect(renewDataPathToken).toHaveBeenCalledTimes(1);

      // A plain connect_error lands mid-renewal: the renewal owns the rebuild —
      // the never-connected E2E recovery must not double-build.
      await act(async () => {
        sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, new Error('websocket error'));
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });
      expect(sockets).toHaveLength(1);

      await act(async () => {
        resolveRenew('fresh-token');
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });

      // Exactly ONE new socket; the replaced one was torn down (no zombie).
      expect(sockets).toHaveLength(2);
      expect(disconnects).toEqual([0]);
      // The E2E recovery never launched: 1 initial handshake + 1 renewal rebuild.
      expect(getE2eSession).toHaveBeenCalledTimes(2);
    });

    it('serializes an E2E recovery with a queued token renewal — the intermediate socket is torn down, never leaked', async () => {
      configureE2eSessions(e2eManagerConfig);
      // Initial build handshakes immediately; every REBUILD handshake is held so
      // both rebuild paths are genuinely in flight together.
      const heldHandshakes: Array<(s: typeof fakeSession) => void> = [];
      const getE2eSession = jest.fn((): Promise<typeof fakeSession> => {
        if (getE2eSession.mock.calls.length === 1) return Promise.resolve(fakeSession);
        return new Promise((r) => {
          heldHandshakes.push(r);
        });
      });
      const renewDataPathToken = jest.fn(async (): Promise<string | null> => 'fresh-token');
      const { sockets, disconnects, factory } = freshSocketFactory();
      mountCredentialProvider({
        getAuthToken: async () => 'tok',
        factory,
        renewDataPathToken,
        getE2eSession,
      });
      await flushDeep();
      expect(sockets).toHaveLength(1);

      // A typed E2E rejection starts the recovery; its rebuild handshake hangs.
      await act(async () => {
        sockets[0].emitServerEvent(
          SERVER_EVENTS.CONNECT_ERROR,
          Object.assign(new Error('rejected'), { data: { code: 'e2e_session_required' } })
        );
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });
      // A token expiry mid-rebuild: the renewal must QUEUE behind it, not race it.
      await act(async () => {
        sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, tokenExpiredError());
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });

      // Release the recovery's handshake, then the renewal's queued one.
      await act(async () => {
        heldHandshakes[0](fakeSession);
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });
      await act(async () => {
        heldHandshakes[1]?.(fakeSession);
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });

      // Serialized: every replaced socket got disconnected, in order — no zombie.
      expect(sockets).toHaveLength(3);
      expect(disconnects).toEqual([0, 1]);
      expect(renewDataPathToken).toHaveBeenCalledTimes(1);
      expect(getE2eSession).toHaveBeenCalledTimes(3);
    });

    it('a renewal resolving after unmount never rebuilds — the queued rebuild is cancelled', async () => {
      // Renewal held pending so the provider can unmount mid-flight.
      let resolveRenew!: (v: string | null) => void;
      const renewDataPathToken = jest.fn(
        () =>
          new Promise<string | null>((r) => {
            resolveRenew = r;
          })
      );
      const { sockets, factory } = freshSocketFactory();
      const utils = mountCredentialProvider({
        getAuthToken: async () => 'tok',
        factory,
        renewDataPathToken,
      });
      await flushDeep();
      expect(sockets).toHaveLength(1);

      await act(async () => {
        sockets[0].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, tokenExpiredError());
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });
      expect(renewDataPathToken).toHaveBeenCalledTimes(1);

      utils.unmount();

      await act(async () => {
        resolveRenew('fresh-token');
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });

      expect(sockets).toHaveLength(1);
    });

    it("recovers the E2E session on the typed 'e2e_session_required' code (no message match needed)", async () => {
      configureE2eSessions(e2eManagerConfig);
      const getE2eSession = jest.fn(async () => fakeSession);
      const { sockets, factory } = freshSocketFactory();
      mountCredentialProvider({ getAuthToken: async () => 'tok', factory, getE2eSession });
      await flushDeep();
      // Connected once → the never-connected fallback cannot mask the typed path.
      act(() => sockets[0].setConnected(true));

      await act(async () => {
        sockets[0].emitServerEvent(
          SERVER_EVENTS.CONNECT_ERROR,
          Object.assign(new Error('rejected'), { data: { code: 'e2e_session_required' } })
        );
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });
      expect(getE2eSession).toHaveBeenCalledTimes(2);
      expect(sockets).toHaveLength(2);

      // Any OTHER post-connect failure: no recovery, no budget burn.
      await act(async () => {
        sockets[1].emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, new Error('transport closed'));
        for (let j = 0; j < 8; j++) await Promise.resolve();
      });
      expect(getE2eSession).toHaveBeenCalledTimes(2);
      expect(sockets).toHaveLength(2);
    });
  });

  // The terminal dead-pairing state must be VISIBLE — hiding on 'failed' leaves
  // a normal-looking app that never receives events.
  describe('ReconnectingBanner terminal state', () => {
    it('hides while connected', () => {
      act(() => {
        useSocketStore.getState().markConnected('sock-1');
      });
      render(<ReconnectingBanner />);
      expect(screen.queryByTestId('reconnecting-banner')).toBeNull();
      expect(screen.queryByTestId('connection-failed-banner')).toBeNull();
    });

    it('shows the reconnecting variant when the socket drops after a first connect', () => {
      act(() => {
        useSocketStore.getState().markConnected('sock-1');
        useSocketStore.getState().markDisconnected();
      });
      render(<ReconnectingBanner />);
      expect(screen.getByTestId('reconnecting-banner-text').props.children).toBe('Reconnecting…');
      expect(screen.queryByTestId('connection-failed-banner')).toBeNull();
    });

    it('renders the persistent terminal variant on the failed state — even before a first connect', () => {
      // Cold-start lockout: the first handshake fails, so hasConnectedOnce is still false.
      act(() => {
        useSocketStore.getState().setConnectionState('failed');
      });
      render(<ReconnectingBanner />);
      expect(useSocketStore.getState().hasConnectedOnce).toBe(false);
      const text = screen.getByTestId('connection-failed-banner-text').props.children;
      expect(String(text)).toMatch(/no longer authorized/i);
      expect(String(text)).toMatch(/Connect PC/);
      expect(screen.queryByTestId('reconnecting-banner')).toBeNull();
    });

    it('renders the terminal variant on failed after a connected session too', () => {
      act(() => {
        useSocketStore.getState().markConnected('sock-1');
        useSocketStore.getState().markDisconnected();
        useSocketStore.getState().setConnectionState('failed');
      });
      render(<ReconnectingBanner />);
      expect(screen.getByTestId('connection-failed-banner')).toBeTruthy();
      expect(screen.queryByTestId('reconnecting-banner')).toBeNull();
    });
  });
});
