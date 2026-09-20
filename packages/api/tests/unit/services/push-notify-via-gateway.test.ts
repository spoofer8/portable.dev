/**
 * PushNotificationService.notifyViaGateway Unit Tests (rev10, D31/D33)
 *
 * Local-first push: the PC owns the subscriptions but the FCM credential lives on
 * the public gateway (the only online service). `notifyViaGateway` reads the
 * user's stored fcm tokens and POSTs `{ pcId, tokens, payload }` to
 * `<PORTABLE_RELAY_URL>/api/notify`; the gateway fans out and returns a per-token
 * result, so dead tokens can be pruned locally.
 *
 * Behaviour under test:
 * - POST body shape (pcId from env, distinct fcm tokens, payload passthrough)
 * - dead-token pruning (only unregistered tokens are removed, good ones kept)
 * - graceful no-op when PORTABLE_RELAY_URL / PORTABLE_PC_ID are unset
 * - graceful no-op when the user has no FCM-tokened device
 * - never throws (gateway unreachable / non-2xx)
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

import type { NotifyPayload, NotifyRequest, NotifyResponse } from '@vgit2/shared/types';
import {
  EXPO_PUSH_API_URL,
  EXPO_PUSH_RECEIPTS_URL,
  PORTABLE_EXPO_PROJECT_ID,
  PORTABLE_IOS_APP_ID,
} from '@vgit2/shared/pushConfig';

import type { DbAdapter } from '../../../src/db/DbAdapter';
import {
  PushNotificationService,
  isUnregisteredPushError,
} from '../../../src/services/PushNotificationService';

type Sub = {
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  fcmToken?: string;
  platform?: 'web' | 'ios' | 'android';
  pushProvider?: 'web' | 'fcm' | 'expo';
  projectId?: string;
  appId?: string;
  deviceInfo?: any;
};

const RELAY = 'https://relay.example.com';
const PC_ID = 'pc-abc-123';
const PAYLOAD: NotifyPayload = {
  title: 'Chat completed',
  body: 'Claude has finished responding',
  chatId: 'chat-1',
  tag: 'claude-chat-1',
};

function sub(endpoint: string, fcmToken?: string): Sub {
  return {
    userId: 'user@example.com',
    endpoint,
    keys: { p256dh: '', auth: '' },
    fcmToken,
    platform: fcmToken ? 'android' : 'web',
    pushProvider: fcmToken ? 'fcm' : 'web',
  };
}

function expoSub(token: string): Sub {
  return {
    userId: 'user@example.com',
    endpoint: token,
    keys: { p256dh: '', auth: '' },
    platform: 'ios',
    pushProvider: 'expo',
    projectId: PORTABLE_EXPO_PROJECT_ID,
    appId: PORTABLE_IOS_APP_ID,
  };
}

/** A Response-like value good enough for `notifyViaGateway`. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function makeService(opts: {
  subscriptions: Sub[];
  fetchImpl: typeof fetch;
  expoDelivery?: ConstructorParameters<typeof PushNotificationService>[2];
}) {
  const getUserPushSubscriptions = mock(async () => opts.subscriptions);
  const removePushSubscription = mock(async () => true);
  const dbAdapter = {
    getUserPushSubscriptions,
    removePushSubscription,
  } as unknown as DbAdapter;
  const service = new PushNotificationService(dbAdapter, opts.fetchImpl, opts.expoDelivery);
  return { service, getUserPushSubscriptions, removePushSubscription };
}

describe('PushNotificationService.notifyViaGateway (rev10 D31/D33)', () => {
  let prevRelay: string | undefined;
  let prevPcId: string | undefined;

  beforeEach(() => {
    prevRelay = process.env.PORTABLE_RELAY_URL;
    prevPcId = process.env.PORTABLE_PC_ID;
    process.env.PORTABLE_RELAY_URL = RELAY;
    process.env.PORTABLE_PC_ID = PC_ID;
  });

  afterEach(() => {
    if (prevRelay === undefined) delete process.env.PORTABLE_RELAY_URL;
    else process.env.PORTABLE_RELAY_URL = prevRelay;
    if (prevPcId === undefined) delete process.env.PORTABLE_PC_ID;
    else process.env.PORTABLE_PC_ID = prevPcId;
  });

  it('POSTs { pcId, tokens, payload } to <relay>/api/notify with the stored fcm tokens', async () => {
    const allOk: NotifyResponse = {
      results: [
        { token: 'fcm-A', ok: true },
        { token: 'fcm-B', ok: true },
      ],
    };
    const fetchImpl = mock(async () => jsonResponse(allOk)) as unknown as typeof fetch;
    const { service, removePushSubscription } = makeService({
      subscriptions: [sub('ep-a', 'fcm-A'), sub('ep-b', 'fcm-B')],
      fetchImpl,
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD, 'jwt');

    expect((fetchImpl as any).mock.calls.length).toBe(1);
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(`${RELAY}/api/notify`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body) as NotifyRequest;
    expect(body.pcId).toBe(PC_ID);
    expect(body.tokens).toEqual(['fcm-A', 'fcm-B']);
    expect(body.payload).toEqual(PAYLOAD);

    // all tokens healthy → nothing pruned
    expect((removePushSubscription as any).mock.calls.length).toBe(0);
  });

  it('sends Expo tokens directly to the Expo Push API without a Firebase credential', async () => {
    const expoToken = 'ExpoPushToken[fork-ios]';
    const fetchImpl = mock(async (url: string | URL | Request) => {
      if (String(url) === EXPO_PUSH_API_URL) {
        return jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] });
      }
      return jsonResponse({ results: [] });
    }) as unknown as typeof fetch;
    const { service } = makeService({ subscriptions: [expoSub(expoToken)], fetchImpl });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((fetchImpl as any).mock.calls.length).toBe(1);
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(EXPO_PUSH_API_URL);
    expect(JSON.parse(init.body)).toEqual([
      expect.objectContaining({
        to: expoToken,
        title: PAYLOAD.title,
        body: PAYLOAD.body,
        data: expect.objectContaining({ chatId: PAYLOAD.chatId }),
      }),
    ]);
  });

  it('prunes Expo tokens rejected as DeviceNotRegistered', async () => {
    const expoToken = 'ExpoPushToken[dead-ios]';
    const fetchImpl = mock(async () =>
      jsonResponse({
        data: [
          {
            status: 'error',
            message: 'Device is not registered',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      })
    ) as unknown as typeof fetch;
    const { service, removePushSubscription } = makeService({
      subscriptions: [expoSub(expoToken)],
      fetchImpl,
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD, 'jwt');

    expect((removePushSubscription as any).mock.calls).toEqual([
      ['user@example.com', expoToken, 'jwt'],
    ]);
  });

  it('handles Expo single-ticket responses and prunes DeviceNotRegistered', async () => {
    const expoToken = 'ExpoPushToken[single-dead-ios]';
    const fetchImpl = mock(async () =>
      jsonResponse({
        data: {
          status: 'error',
          details: { error: 'DeviceNotRegistered' },
        },
      })
    ) as unknown as typeof fetch;
    const { service, removePushSubscription } = makeService({
      subscriptions: [expoSub(expoToken)],
      fetchImpl,
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((removePushSubscription as any).mock.calls[0][1]).toBe(expoToken);
  });

  it('retries Expo sends on 429 before succeeding', async () => {
    let attempts = 0;
    const fetchImpl = mock(async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({}, { ok: false, status: 429 })
        : jsonResponse({ data: [{ status: 'ok' }] });
    }) as unknown as typeof fetch;
    const sleep = mock(async () => undefined);
    const { service } = makeService({
      subscriptions: [expoSub('ExpoPushToken[retry-ios]')],
      fetchImpl,
      expoDelivery: { retryDelayMs: 1, sleep },
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect(attempts).toBe(2);
    expect((sleep as any).mock.calls.length).toBe(1);
  });

  it('times out stalled Expo sends and stops after the configured attempt bound', async () => {
    const fetchImpl = mock(
      async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    ) as unknown as typeof fetch;
    const { service } = makeService({
      subscriptions: [expoSub('ExpoPushToken[timeout-ios]')],
      fetchImpl,
      expoDelivery: {
        requestTimeoutMs: 1,
        sendAttempts: 2,
        retryDelayMs: 1,
        sleep: async () => undefined,
      },
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((fetchImpl as any).mock.calls.length).toBe(2);
  });

  it('polls Expo receipts in the background and prunes a rejected device', async () => {
    const token = 'ExpoPushToken[receipt-dead-ios]';
    const scheduledTasks: Array<{ task: () => Promise<void>; delayMs: number }> = [];
    const schedule = (task: () => Promise<void>, delayMs: number) => {
      scheduledTasks.push({ task, delayMs });
    };
    let receiptCalls = 0;
    const fetchImpl = mock(async (url: string | URL | Request) => {
      if (String(url) === EXPO_PUSH_API_URL) {
        return jsonResponse({ data: [{ status: 'ok', id: 'ticket-receipt' }] });
      }
      expect(String(url)).toBe(EXPO_PUSH_RECEIPTS_URL);
      receiptCalls += 1;
      return receiptCalls === 1
        ? jsonResponse({ data: {} })
        : jsonResponse({
            data: {
              'ticket-receipt': {
                status: 'error',
                details: { error: 'DeviceNotRegistered' },
              },
            },
          });
    }) as unknown as typeof fetch;
    const { service, removePushSubscription } = makeService({
      subscriptions: [expoSub(token)],
      fetchImpl,
      expoDelivery: { schedule },
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD);
    expect(scheduledTasks[0]?.delayMs).toBe(15 * 60_000);
    expect(receiptCalls).toBe(0);
    await scheduledTasks.shift()?.task();

    expect(receiptCalls).toBe(1);
    expect(scheduledTasks[0]?.delayMs).toBe(15 * 60_000);
    expect((removePushSubscription as any).mock.calls.length).toBe(0);
    await scheduledTasks.shift()?.task();

    expect(receiptCalls).toBe(2);
    expect((removePushSubscription as any).mock.calls).toContainEqual([
      'user@example.com',
      token,
      undefined,
    ]);
  });

  it('ignores stored Expo tokens whose project or app identity is not trusted', async () => {
    const fetchImpl = mock(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    const { service } = makeService({
      subscriptions: [
        { ...expoSub('ExpoPushToken[wrong-project]'), projectId: 'upstream-project' },
        { ...expoSub('ExpoPushToken[wrong-app]'), appId: 'dev.portable.app' },
      ],
      fetchImpl,
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((fetchImpl as any).mock.calls.length).toBe(0);
  });

  it('does not send a legacy iOS FCM token to the official gateway when Expo iOS exists', async () => {
    const legacyIos = {
      ...sub('legacy-ios-endpoint', 'legacy-official-fcm'),
      platform: 'ios' as const,
    };
    const android = sub('android-endpoint', 'android-fcm');
    const fetchImpl = mock(async (url: string | URL | Request) => {
      if (String(url).includes('exp.host')) {
        return jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] });
      }
      return jsonResponse({ results: [{ token: 'android-fcm', ok: true }] });
    }) as unknown as typeof fetch;
    const { service } = makeService({
      subscriptions: [legacyIos, expoSub('ExpoPushToken[fork-ios]'), android],
      fetchImpl,
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    const gatewayCall = (fetchImpl as any).mock.calls.find(([url]: [string]) =>
      url.endsWith('/api/notify')
    );
    expect(JSON.parse(gatewayCall[1].body).tokens).toEqual(['android-fcm']);
  });

  it('sends Expo tokens even when the legacy relay environment is absent', async () => {
    delete process.env.PORTABLE_RELAY_URL;
    delete process.env.PORTABLE_PC_ID;
    const fetchImpl = mock(async () =>
      jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] })
    ) as unknown as typeof fetch;
    const { service } = makeService({
      subscriptions: [expoSub('ExpoPushToken[fork-ios]')],
      fetchImpl,
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((fetchImpl as any).mock.calls[0][0]).toBe(EXPO_PUSH_API_URL);
  });

  it('strips a trailing slash on the relay base when building the URL', async () => {
    process.env.PORTABLE_RELAY_URL = `${RELAY}/`;
    const fetchImpl = mock(async () =>
      jsonResponse({ results: [{ token: 'fcm-A', ok: true }] } as NotifyResponse)
    ) as unknown as typeof fetch;
    const { service } = makeService({ subscriptions: [sub('ep-a', 'fcm-A')], fetchImpl });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((fetchImpl as any).mock.calls[0][0]).toBe(`${RELAY}/api/notify`);
  });

  it('de-duplicates fcm tokens (one entry per distinct token)', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ results: [{ token: 'fcm-A', ok: true }] } as NotifyResponse)
    ) as unknown as typeof fetch;
    const { service } = makeService({
      // same token registered under two endpoints
      subscriptions: [sub('ep-a', 'fcm-A'), sub('ep-b', 'fcm-A')],
      fetchImpl,
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body) as NotifyRequest;
    expect(body.tokens).toEqual(['fcm-A']);
  });

  it('prunes ONLY the unregistered token (by its endpoint), keeping healthy ones', async () => {
    const mixed: NotifyResponse = {
      results: [
        { token: 'fcm-good', ok: true },
        { token: 'fcm-dead', ok: false, error: 'messaging/registration-token-not-registered' },
      ],
    };
    const fetchImpl = mock(async () => jsonResponse(mixed)) as unknown as typeof fetch;
    const { service, removePushSubscription } = makeService({
      subscriptions: [sub('ep-good', 'fcm-good'), sub('ep-dead', 'fcm-dead')],
      fetchImpl,
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD, 'jwt');

    expect((removePushSubscription as any).mock.calls.length).toBe(1);
    expect((removePushSubscription as any).mock.calls[0]).toEqual([
      'user@example.com',
      'ep-dead',
      'jwt',
    ]);
  });

  it('does NOT prune a token whose error is transient (not an unregistered code)', async () => {
    const transient: NotifyResponse = {
      results: [{ token: 'fcm-A', ok: false, error: 'messaging/internal-error' }],
    };
    const fetchImpl = mock(async () => jsonResponse(transient)) as unknown as typeof fetch;
    const { service, removePushSubscription } = makeService({
      subscriptions: [sub('ep-a', 'fcm-A')],
      fetchImpl,
    });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((removePushSubscription as any).mock.calls.length).toBe(0);
  });

  it('no-ops (no fetch) when PORTABLE_RELAY_URL is unset (non-launcher run)', async () => {
    delete process.env.PORTABLE_RELAY_URL;
    const fetchImpl = mock(async () => jsonResponse({ results: [] })) as unknown as typeof fetch;
    const { service } = makeService({ subscriptions: [sub('ep-a', 'fcm-A')], fetchImpl });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((fetchImpl as any).mock.calls.length).toBe(0);
  });

  it('no-ops (no fetch) when PORTABLE_PC_ID is unset', async () => {
    delete process.env.PORTABLE_PC_ID;
    const fetchImpl = mock(async () => jsonResponse({ results: [] })) as unknown as typeof fetch;
    const { service } = makeService({ subscriptions: [sub('ep-a', 'fcm-A')], fetchImpl });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((fetchImpl as any).mock.calls.length).toBe(0);
  });

  it('no-ops (no fetch) when the user has no FCM-tokened device', async () => {
    const fetchImpl = mock(async () => jsonResponse({ results: [] })) as unknown as typeof fetch;
    // web-push-only subs (no fcmToken)
    const { service } = makeService({ subscriptions: [sub('ep-web', undefined)], fetchImpl });

    await service.notifyViaGateway('user@example.com', PAYLOAD);

    expect((fetchImpl as any).mock.calls.length).toBe(0);
  });

  it('never throws when the gateway is unreachable (best-effort)', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { service, removePushSubscription } = makeService({
      subscriptions: [sub('ep-a', 'fcm-A')],
      fetchImpl,
    });

    await expect(service.notifyViaGateway('user@example.com', PAYLOAD)).resolves.toBeUndefined();
    expect((removePushSubscription as any).mock.calls.length).toBe(0);
  });

  it('never throws and does not prune on a non-2xx gateway response', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ results: [] }, { ok: false, status: 503 })
    ) as unknown as typeof fetch;
    const { service, removePushSubscription } = makeService({
      subscriptions: [sub('ep-a', 'fcm-A')],
      fetchImpl,
    });

    await expect(service.notifyViaGateway('user@example.com', PAYLOAD)).resolves.toBeUndefined();
    expect((removePushSubscription as any).mock.calls.length).toBe(0);
  });
});

describe('isUnregisteredPushError', () => {
  it('matches the FCM unregistered/invalid-token codes (case-insensitive)', () => {
    for (const e of [
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
      'messaging/invalid-argument',
      'NotRegistered',
      'Requested entity was not found (UNREGISTERED)',
      'DeviceNotRegistered',
    ]) {
      expect(isUnregisteredPushError(e)).toBe(true);
    }
  });

  it('does not match transient / unrelated errors or undefined', () => {
    expect(isUnregisteredPushError(undefined)).toBe(false);
    expect(isUnregisteredPushError('messaging/internal-error')).toBe(false);
    expect(isUnregisteredPushError('messaging/server-unavailable')).toBe(false);
  });
});
