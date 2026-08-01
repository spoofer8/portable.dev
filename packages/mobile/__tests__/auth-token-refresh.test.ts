/**
 * Token refresh.
 *
 * Verifies the RN client refreshes the Portable `authToken` REACTIVELY on a 401
 * (it must NOT rely on the `X-Renewed-Token` response header), persists the
 * fresh sliding-72h token to expo-secure-store, and replays the original request
 * with the new `Bearer`.
 *
 * The gateway `POST /auth/mobile/react-native/refresh` endpoint already exists
 * (re-checks the blacklist, mints via `renewAuthToken`), so
 * this is purely a client-side flow — mocked here via the shared
 * `createMockGateway` harness + an in-memory SecureStore.
 */

// In-memory mock keychain for expo-secure-store (the ONLY token persistence).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

import * as SecureStore from 'expo-secure-store';

import { createAuthedFetch, NoAuthTokenError } from '../src/features/auth/authedFetch';
import { refreshAuthToken } from '../src/features/auth/refreshAuthToken';
import { AUTH_TOKEN_KEY, getAuthToken } from '../src/features/auth/secureAuthStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

import type { MobileRnRefreshResponse } from '@vgit2/shared/types';

interface SecureStoreMock {
  __store: Map<string, string>;
  setItemAsync: jest.Mock;
  getItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
}

const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

// A protected sandbox API endpoint (a different base URL from the gateway).
const SANDBOX_API = 'https://sandbox.portable.test/api/me';

describe('Token refresh', () => {
  let gateway: MockGateway;
  let client: GatewayClient;

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    gateway = createMockGateway();
    client = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  });

  it('refreshes reactively on 401, persists the new token, and replays with the new Bearer', async () => {
    // Seed a stale (still-valid-looking) token.
    secureStore.__store.set(AUTH_TOKEN_KEY, 'stale-token');

    // The protected endpoint: 401 (with a decoy X-Renewed-Token header that the
    // client must IGNORE) for the stale token, 200 once the refreshed Bearer is
    // presented.
    gateway.on('GET', SANDBOX_API, (req) => {
      const auth = req.headers.Authorization ?? req.headers.authorization ?? '';
      if (auth === 'Bearer mock-refreshed-token') {
        return { body: { user: 'octocat' } };
      }
      return {
        status: 401,
        headers: { 'X-Renewed-Token': 'header-token-MUST-be-ignored' },
        body: { error: 'token expired' },
      };
    });

    const authedFetch = createAuthedFetch({ gateway: client, fetchImpl: gateway.fetchImpl });

    const res = await authedFetch(SANDBOX_API);

    // Original request replayed and succeeded with the refreshed Bearer.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ user: 'octocat' });

    // The client called POST /refresh reactively (Bearer was the stale token).
    const refreshReq = gateway.requests.find((r) => r.path.endsWith('/refresh'));
    expect(refreshReq).toBeDefined();
    expect(refreshReq?.method).toBe('POST');
    expect(refreshReq?.headers.Authorization).toBe('Bearer stale-token');
    expect(refreshReq?.credentials).toBe('omit');

    // The fresh token (from /refresh, NOT the X-Renewed-Token header) is
    // persisted to expo-secure-store and picked up by getAuthToken().
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, 'mock-refreshed-token');
    expect(secureStore.__store.get(AUTH_TOKEN_KEY)).toBe('mock-refreshed-token');
    await expect(getAuthToken()).resolves.toBe('mock-refreshed-token');

    // The original request was sent twice: once (401) then a replay (200), and
    // the replay carried the new Bearer (not the ignored header value).
    const apiReqs = gateway.requests.filter((r) => r.url === SANDBOX_API);
    expect(apiReqs).toHaveLength(2);
    expect(apiReqs[0].headers.Authorization).toBe('Bearer stale-token');
    expect(apiReqs[1].headers.Authorization).toBe('Bearer mock-refreshed-token');
  });

  it('passes a non-401 response through untouched (no refresh)', async () => {
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    gateway.on('GET', SANDBOX_API, () => ({ body: { ok: true } }));

    const authedFetch = createAuthedFetch({ gateway: client, fetchImpl: gateway.fetchImpl });
    const res = await authedFetch(SANDBOX_API);

    expect(res.status).toBe(200);
    expect(gateway.requests.some((r) => r.path.endsWith('/refresh'))).toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('coalesces concurrent 401s into a single refresh (single-flight)', async () => {
    secureStore.__store.set(AUTH_TOKEN_KEY, 'stale-token');
    gateway.on('GET', SANDBOX_API, (req) => {
      const auth = req.headers.Authorization ?? '';
      return auth === 'Bearer mock-refreshed-token'
        ? { body: { ok: true } }
        : { status: 401, body: { error: 'expired' } };
    });

    const authedFetch = createAuthedFetch({ gateway: client, fetchImpl: gateway.fetchImpl });

    const [a, b, c] = await Promise.all([
      authedFetch(SANDBOX_API),
      authedFetch(SANDBOX_API),
      authedFetch(SANDBOX_API),
    ]);

    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    // Three 401s, but only ONE refresh call was made.
    const refreshCalls = gateway.requests.filter((r) => r.path.endsWith('/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('surfaces the refreshed sliding-72h token from refreshAuthToken()', async () => {
    secureStore.__store.set(AUTH_TOKEN_KEY, 'stale-token');
    const fresh: MobileRnRefreshResponse = { authToken: 'sliding-72h-token' };
    gateway.onRn('POST', '/refresh', (req) => {
      // Bearer is required (gateway re-checks the blacklist on the old token).
      const auth = req.headers.Authorization ?? '';
      if (!auth.startsWith('Bearer ')) return { status: 401, body: { error: 'Unauthorized' } };
      return { body: fresh };
    });

    const token = await refreshAuthToken(client);
    expect(token).toBe('sliding-72h-token');
    await expect(getAuthToken()).resolves.toBe('sliding-72h-token');
  });

  it('throws NoAuthTokenError when there is no stored token to refresh', async () => {
    const authedFetch = createAuthedFetch({ gateway: client, fetchImpl: gateway.fetchImpl });
    gateway.on('GET', SANDBOX_API, () => ({ status: 401, body: { error: 'expired' } }));

    await expect(authedFetch(SANDBOX_API)).rejects.toBeInstanceOf(NoAuthTokenError);
    expect(gateway.requests.some((r) => r.path.endsWith('/refresh'))).toBe(false);
  });
});

describe('device-path X-Renewed-Token persistence', () => {
  let gateway: MockGateway;
  let client: GatewayClient;

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    gateway = createMockGateway();
    client = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  });

  it('honors X-Renewed-Token for the device path: persists it + notifies, and skips /refresh', async () => {
    const persistRenewedToken = jest.fn().mockResolvedValue(undefined);
    const onTokenRefreshed = jest.fn();
    // The PC slides the JWT and returns the fresh one in X-Renewed-Token (200 OK).
    gateway.on('GET', SANDBOX_API, () => ({
      status: 200,
      headers: { 'X-Renewed-Token': 'pc-renewed-jwt' },
      body: { ok: true },
    }));

    const authedFetch = createAuthedFetch({
      gateway: client,
      fetchImpl: gateway.fetchImpl,
      getToken: async () => 'current-device-jwt',
      persistRenewedToken,
      onTokenRefreshed,
    });

    const res = await authedFetch(SANDBOX_API);

    expect(res.status).toBe(200);
    // The renewed JWT is persisted via the device-path seam (keyed by pcId) + notified.
    expect(persistRenewedToken).toHaveBeenCalledWith('pc-renewed-jwt');
    expect(onTokenRefreshed).toHaveBeenCalledWith('pc-renewed-jwt');
    // There is NO /refresh on the PC — it must never be hit on the device path.
    expect(gateway.requests.some((r) => r.path.endsWith('/refresh'))).toBe(false);
    // The original request carried the current device JWT.
    const apiReq = gateway.requests.find((r) => r.url === SANDBOX_API);
    expect(apiReq?.headers.Authorization).toBe('Bearer current-device-jwt');
  });

  it('returns a 401 to the caller on the device path WITHOUT calling /refresh', async () => {
    const persistRenewedToken = jest.fn().mockResolvedValue(undefined);
    gateway.on('GET', SANDBOX_API, () => ({ status: 401, body: { error: 'expired' } }));

    const authedFetch = createAuthedFetch({
      gateway: client,
      fetchImpl: gateway.fetchImpl,
      getToken: async () => 'current-device-jwt',
      persistRenewedToken,
    });

    const res = await authedFetch(SANDBOX_API);

    // A 401 on the device path is the death/re-pair signal — surfaced as-is.
    expect(res.status).toBe(401);
    expect(persistRenewedToken).not.toHaveBeenCalled();
    expect(gateway.requests.some((r) => r.path.endsWith('/refresh'))).toBe(false);
    // Exactly ONE attempt (no replay).
    expect(gateway.requests.filter((r) => r.url === SANDBOX_API)).toHaveLength(1);
  });

  it('passes a normal response through untouched when no X-Renewed-Token is present', async () => {
    const persistRenewedToken = jest.fn().mockResolvedValue(undefined);
    gateway.on('GET', SANDBOX_API, () => ({ body: { ok: true } }));

    const authedFetch = createAuthedFetch({
      gateway: client,
      fetchImpl: gateway.fetchImpl,
      getToken: async () => 'current-device-jwt',
      persistRenewedToken,
    });

    const res = await authedFetch(SANDBOX_API);
    expect(res.status).toBe(200);
    expect(persistRenewedToken).not.toHaveBeenCalled();
  });
});

describe('device-path 401 renewal (renewOnUnauthorized — portable.dev#24)', () => {
  let gateway: MockGateway;
  let client: GatewayClient;

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    gateway = createMockGateway();
    client = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  });

  /** The endpoint answers 401 for the expired JWT, 200 for the re-minted one. */
  function serveUntilRenewed(freshToken: string): void {
    gateway.on('GET', SANDBOX_API, (req) => {
      const auth = req.headers.Authorization ?? req.headers.authorization ?? '';
      if (auth === `Bearer ${freshToken}`) return { body: { ok: true } };
      return { status: 401, body: { error: 'jwt expired' } };
    });
  }

  it('renews on 401, replays once with the fresh Bearer, and returns the replay', async () => {
    serveUntilRenewed('psk-minted-jwt');
    const renewOnUnauthorized = jest.fn().mockResolvedValue('psk-minted-jwt');
    const onTokenRefreshed = jest.fn();

    const authedFetch = createAuthedFetch({
      gateway: client,
      fetchImpl: gateway.fetchImpl,
      getToken: async () => 'expired-device-jwt',
      persistRenewedToken: jest.fn().mockResolvedValue(undefined),
      renewOnUnauthorized,
      onTokenRefreshed,
    });

    const res = await authedFetch(SANDBOX_API);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(renewOnUnauthorized).toHaveBeenCalledTimes(1);
    expect(onTokenRefreshed).toHaveBeenCalledWith('psk-minted-jwt');
    const apiReqs = gateway.requests.filter((r) => r.url === SANDBOX_API);
    expect(apiReqs).toHaveLength(2);
    expect(apiReqs[0].headers.Authorization).toBe('Bearer expired-device-jwt');
    expect(apiReqs[1].headers.Authorization).toBe('Bearer psk-minted-jwt');
    expect(gateway.requests.some((r) => r.path.endsWith('/refresh'))).toBe(false);
  });

  it('returns the ORIGINAL 401 when renew resolves null (PC rejected recovery)', async () => {
    gateway.on('GET', SANDBOX_API, () => ({ status: 401, body: { error: 'jwt expired' } }));
    const renewOnUnauthorized = jest.fn().mockResolvedValue(null);
    const onTokenRefreshed = jest.fn();

    const authedFetch = createAuthedFetch({
      gateway: client,
      fetchImpl: gateway.fetchImpl,
      getToken: async () => 'expired-device-jwt',
      persistRenewedToken: jest.fn().mockResolvedValue(undefined),
      renewOnUnauthorized,
      onTokenRefreshed,
    });

    const res = await authedFetch(SANDBOX_API);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'jwt expired' });
    expect(renewOnUnauthorized).toHaveBeenCalledTimes(1);
    expect(onTokenRefreshed).not.toHaveBeenCalled();
    expect(gateway.requests.filter((r) => r.url === SANDBOX_API)).toHaveLength(1);
  });

  it('returns the ORIGINAL 401 when renew throws (transport failure)', async () => {
    gateway.on('GET', SANDBOX_API, () => ({ status: 401, body: { error: 'jwt expired' } }));
    const renewOnUnauthorized = jest.fn().mockRejectedValue(new Error('network down'));

    const authedFetch = createAuthedFetch({
      gateway: client,
      fetchImpl: gateway.fetchImpl,
      getToken: async () => 'expired-device-jwt',
      persistRenewedToken: jest.fn().mockResolvedValue(undefined),
      renewOnUnauthorized,
    });

    const res = await authedFetch(SANDBOX_API);

    expect(res.status).toBe(401);
    expect(renewOnUnauthorized).toHaveBeenCalledTimes(1);
    expect(gateway.requests.filter((r) => r.url === SANDBOX_API)).toHaveLength(1);
  });

  it('never calls renew on a non-401 response', async () => {
    gateway.on('GET', SANDBOX_API, () => ({ body: { ok: true } }));
    const renewOnUnauthorized = jest.fn().mockResolvedValue('psk-minted-jwt');

    const authedFetch = createAuthedFetch({
      gateway: client,
      fetchImpl: gateway.fetchImpl,
      getToken: async () => 'current-device-jwt',
      persistRenewedToken: jest.fn().mockResolvedValue(undefined),
      renewOnUnauthorized,
    });

    const res = await authedFetch(SANDBOX_API);
    expect(res.status).toBe(200);
    expect(renewOnUnauthorized).not.toHaveBeenCalled();
  });

  it('ignores renewOnUnauthorized on the legacy gateway path (no persistRenewedToken)', async () => {
    secureStore.__store.set(AUTH_TOKEN_KEY, 'stale-token');
    gateway.on('GET', SANDBOX_API, (req) => {
      const auth = req.headers.Authorization ?? '';
      return auth === 'Bearer mock-refreshed-token'
        ? { body: { ok: true } }
        : { status: 401, body: { error: 'expired' } };
    });
    const renewOnUnauthorized = jest.fn().mockResolvedValue('psk-minted-jwt');

    const authedFetch = createAuthedFetch({
      gateway: client,
      fetchImpl: gateway.fetchImpl,
      renewOnUnauthorized,
    });

    const res = await authedFetch(SANDBOX_API);

    expect(res.status).toBe(200);
    expect(renewOnUnauthorized).not.toHaveBeenCalled();
    expect(gateway.requests.some((r) => r.path.endsWith('/refresh'))).toBe(true);
  });

  it('two concurrent 401s replay with the same fresh token (single-flight lives in the renew module)', async () => {
    serveUntilRenewed('psk-minted-jwt');

    // Fake renew module: counts calls but single-flights the work, like the real renewDataPathToken.
    let renewWorkCount = 0;
    let inflight: Promise<string | null> | null = null;
    let release!: (token: string | null) => void;
    const gate = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const renewOnUnauthorized = jest.fn(() => {
      if (!inflight) {
        renewWorkCount += 1;
        inflight = gate.finally(() => {
          inflight = null;
        });
      }
      return inflight;
    });

    const authedFetch = createAuthedFetch({
      gateway: client,
      fetchImpl: gateway.fetchImpl,
      getToken: async () => 'expired-device-jwt',
      persistRenewedToken: jest.fn().mockResolvedValue(undefined),
      renewOnUnauthorized,
    });

    const pending = Promise.all([authedFetch(SANDBOX_API), authedFetch(SANDBOX_API)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release('psk-minted-jwt');
    const [a, b] = await pending;

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(renewOnUnauthorized).toHaveBeenCalledTimes(2);
    expect(renewWorkCount).toBe(1);
    const replays = gateway.requests.filter(
      (r) => r.url === SANDBOX_API && r.headers.Authorization === 'Bearer psk-minted-jwt'
    );
    expect(replays).toHaveLength(2);
  });
});
