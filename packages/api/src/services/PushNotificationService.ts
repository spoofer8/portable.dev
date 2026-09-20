import {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT,
  debugLog,
} from '@vgit2/shared/constants';
import {
  EXPO_PUSH_API_URL,
  EXPO_PUSH_RECEIPTS_URL,
  isTrustedPortableExpoSubscription,
} from '@vgit2/shared/pushConfig';
import webpush from 'web-push';

import type { DbAdapter } from '../db/DbAdapter.js';
import type { NotifyPayload, NotifyRequest, NotifyResponse } from '@vgit2/shared/types';

/**
 * Whether a gateway per-token error string marks the device token as gone, so it
 * should be pruned locally. The FCM analogue of an HTTP 410/404 web-push removal:
 * firebase-admin reports a stale/unknown token with one of the `messaging/*`
 * registration-token codes (or the legacy `NotRegistered`). Matched loosely +
 * case-insensitively so a wrapped/prefixed gateway error string still prunes.
 */
export function isUnregisteredPushError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    e.includes('registration-token-not-registered') ||
    e.includes('invalid-registration-token') ||
    e.includes('invalid-argument') ||
    e.includes('not-registered') ||
    e.includes('notregistered') ||
    e.includes('unregistered')
  );
}

type PushSubscription = {
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

export interface ExpoDeliveryOptions {
  requestTimeoutMs?: number;
  sendAttempts?: number;
  receiptAttempts?: number;
  retryDelayMs?: number;
  receiptDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  schedule?: (task: () => Promise<void>, delayMs: number) => void;
}

type ResolvedExpoDeliveryOptions = Required<ExpoDeliveryOptions>;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultSchedule(task: () => Promise<void>, delayMs: number): void {
  const timer = setTimeout(() => void task().catch(() => undefined), delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Push Notification Service
 *
 * Owns the PC's push subscriptions (SQLite) and delivers background
 * notifications when the app is closed. Three delivery paths:
 *
 * - **PRIMARY (live): Expo Push API** — fork builds register EAS-scoped Expo
 *   tokens and the PC sends them directly to Expo. This binds APNs delivery to
 *   the fork's bundle ID without requiring a Firebase Admin secret.
 * - **LEGACY NATIVE: FCM via the gateway** — retained for Android and older
 *   registrations. Once an Expo iOS token exists, iOS FCM rows are ignored and
 *   removed during registration.
 * - **DORMANT FALLBACK: Web Push / VAPID** — {@link sendNotification} (Web Push
 *   Protocol RFC 8030 + VAPID) is RETAINED but effectively dead: it self-disables
 *   when VAPID keys are unset (the local-first common case → early return), and the
 *   legacy client that used to subscribe with `p256dh`/`auth` keys + read
 *   `GET /api/push/vapid-public-key` was removed, so there are no
 *   web-push subscribers and no live caller of the VAPID public-key endpoint. Kept as
 *   a non-throwing fallback only; do NOT treat the browser/VAPID flow as a live client.
 *
 * Features (apply to both paths): multi-device support, automatic cleanup of stale
 * subscriptions (web-push 410/404 ⇔ FCM unregistered-token pruning), and graceful
 * degradation when not configured (logs but never crashes).
 */
export class PushNotificationService {
  private configured: boolean = false;
  private readonly expoDelivery: ResolvedExpoDeliveryOptions;

  /**
   * @param dbAdapter - persistence for push subscriptions (the PC owns subscriptions).
   * @param fetchImpl - injectable fetch seam (gateway delegation + tests). Defaults to
   *   the global `fetch`.
   */
  constructor(
    private dbAdapter: DbAdapter,
    private fetchImpl: typeof fetch = fetch,
    expoDelivery: ExpoDeliveryOptions = {}
  ) {
    this.expoDelivery = {
      requestTimeoutMs: expoDelivery.requestTimeoutMs ?? 8_000,
      sendAttempts: expoDelivery.sendAttempts ?? 3,
      receiptAttempts: expoDelivery.receiptAttempts ?? 3,
      retryDelayMs: expoDelivery.retryDelayMs ?? 500,
      receiptDelayMs: expoDelivery.receiptDelayMs ?? 15 * 60_000,
      sleep: expoDelivery.sleep ?? defaultSleep,
      schedule: expoDelivery.schedule ?? defaultSchedule,
    };
    console.log('[PushNotificationService] Initializing push notification service...');

    // Validate configuration
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
      console.warn(
        '[PushNotificationService] ⚠️  VAPID keys not configured - push notifications disabled'
      );
      console.warn(
        '[PushNotificationService] Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT in .env'
      );
      this.configured = false;
      return;
    }

    try {
      // Configure web-push with VAPID keys
      console.log('[PushNotificationService] Configuring web-push with VAPID details...');
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

      this.configured = true;
      console.log(
        '[PushNotificationService] ✓ Successfully initialized with VAPID subject:',
        VAPID_SUBJECT
      );
      debugLog('[PushNotificationService] Initialized with VAPID subject:', VAPID_SUBJECT);
    } catch (error) {
      console.error('[PushNotificationService] ✗ Failed to initialize web-push:', error);
      console.error('[PushNotificationService] Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.configured = false;
    }
  }

  /**
   * Save a push subscription for a user
   */
  async saveSubscription(
    userId: string,
    subscription: {
      endpoint: string;
      keys?: {
        p256dh: string;
        auth: string;
      };
      platform?: 'web' | 'ios' | 'android';
      fcmToken?: string;
      pushProvider?: 'web' | 'fcm' | 'expo';
      projectId?: string;
      appId?: string;
      deviceInfo?: any;
    },
    authToken?: string
  ): Promise<boolean> {
    return await this.dbAdapter.savePushSubscription(userId, subscription, authToken);
  }

  /**
   * Remove a push subscription
   */
  async removeSubscription(userId: string, endpoint: string, authToken?: string): Promise<boolean> {
    return await this.dbAdapter.removePushSubscription(userId, endpoint, authToken);
  }

  /**
   * Get all push subscriptions for a user
   */
  async getUserSubscriptions(userId: string, authToken?: string): Promise<PushSubscription[]> {
    return await this.dbAdapter.getUserPushSubscriptions(userId, authToken);
  }

  /**
   * Send a push notification to all of a user's devices
   *
   * @param userId - User to notify
   * @param payload - Notification data
   * @param authToken - JWT token for RLS authentication
   */
  async sendNotification(
    userId: string,
    payload: {
      title: string;
      body: string;
      chatId?: string;
      tag?: string;
      icon?: string;
      badge?: string;
    },
    authToken?: string
  ): Promise<void> {
    try {
      // Early return if not configured - graceful degradation
      if (!this.configured) {
        console.log(
          '[PushNotificationService] Service not configured - skipping push notification'
        );
        return;
      }

      console.log(`[PushNotificationService] Sending notification for user ${userId}`, {
        title: payload.title,
        chatId: payload.chatId,
        tag: payload.tag,
      });

      let subscriptions;
      try {
        subscriptions = await this.getUserSubscriptions(userId, authToken);
      } catch (error) {
        console.error('[PushNotificationService] Failed to get user subscriptions:', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (subscriptions.length === 0) {
        console.log(`[PushNotificationService] No push subscriptions for user ${userId}`);
        return;
      }

      console.log(
        `[PushNotificationService] Sending notification to ${subscriptions.length} device(s) for user ${userId}`
      );

      const notificationPayload = JSON.stringify(payload);

      // Send to all user's devices (multi-device support)
      const webSubscriptions = subscriptions.filter(
        (subscription) =>
          subscription.pushProvider === 'web' ||
          (!subscription.pushProvider && !subscription.fcmToken)
      );
      const sendPromises = webSubscriptions.map(async (subscription) => {
        try {
          console.log('[PushNotificationService] Attempting web-push delivery');

          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
            },
            notificationPayload
          );

          console.log('[PushNotificationService] ✓ Successfully sent web-push notification');
        } catch (error: any) {
          // Handle expired subscriptions
          if (error.statusCode === 410 || error.statusCode === 404) {
            console.log(
              `[PushNotificationService] Subscription expired (${error.statusCode}), removing it`
            );
            try {
              await this.removeSubscription(userId, subscription.endpoint, authToken);
            } catch (removeError) {
              console.error('[PushNotificationService] Failed to remove expired subscription:', {
                error: removeError instanceof Error ? removeError.message : String(removeError),
              });
            }
          } else {
            // Log detailed error information
            console.error('[PushNotificationService] ✗ Failed to send push notification:', {
              errorName: error.name || 'Unknown',
              errorMessage: error.message || String(error),
              statusCode: error.statusCode,
              body: error.body,
              headers: error.headers,
            });

            // If error has stack trace, log it separately for better debugging
            if (error.stack) {
              console.error('[PushNotificationService] Error stack trace:', error.stack);
            }
          }
        }
      });

      await Promise.allSettled(sendPromises);
      console.log(`[PushNotificationService] Completed sending notifications for user ${userId}`);
    } catch (error) {
      // Top-level error handler - should never crash the application
      console.error('[PushNotificationService] ✗ CRITICAL: Unexpected error in sendNotification:', {
        userId,
        payload: JSON.stringify(payload),
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Log to stdout for production monitoring
      process.stdout.write(
        `[PushNotificationService] CRITICAL ERROR: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  /**
   * Deliver a push notification to the user's native devices. Expo tokens go
   * directly to the Expo Push API; remaining FCM tokens go through the relay.
   *
   * Both providers return per-token results. Tokens reported as unregistered
   * are pruned locally, matching the local 410/404 web-push cleanup.
   *
   * Best-effort by contract — NEVER throws. Missing relay configuration disables
   * only legacy FCM delivery; Expo delivery remains available.
   */
  async notifyViaGateway(
    userId: string,
    payload: NotifyPayload,
    authToken?: string
  ): Promise<void> {
    try {
      let subscriptions;
      try {
        subscriptions = await this.getUserSubscriptions(userId, authToken);
      } catch (error) {
        console.error('[PushNotificationService] notifyViaGateway: failed to read subscriptions:', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const expoSubscriptions = subscriptions.filter((subscription) =>
        isTrustedPortableExpoSubscription(subscription)
      );
      await this.notifyViaExpo(userId, expoSubscriptions, payload, authToken);

      const relayBase = process.env.PORTABLE_RELAY_URL?.trim();
      const pcId = process.env.PORTABLE_PC_ID?.trim();
      if (!relayBase || !pcId) {
        return;
      }

      const hasExpoIos = expoSubscriptions.some((subscription) => subscription.platform === 'ios');

      // Collect distinct FCM tokens and remember which endpoint(s) each maps to,
      // so a token the gateway reports as dead can be pruned by endpoint.
      const endpointsByToken = new Map<string, string[]>();
      for (const sub of subscriptions) {
        if (sub.pushProvider === 'expo') continue;
        if (hasExpoIos && sub.platform === 'ios') continue;
        const token = sub.fcmToken?.trim();
        if (!token) continue;
        const endpoints = endpointsByToken.get(token) ?? [];
        endpoints.push(sub.endpoint);
        endpointsByToken.set(token, endpoints);
      }

      const tokens = [...endpointsByToken.keys()];
      if (tokens.length === 0) {
        // No native FCM device registered → nothing to delegate.
        return;
      }

      const requestBody: NotifyRequest = { pcId, tokens, payload };
      const url = `${relayBase.replace(/\/+$/, '')}/api/notify`;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
      } catch (error) {
        // Gateway unreachable — swallow (push is best-effort, must not crash chat exec).
        console.warn('[PushNotificationService] notifyViaGateway: gateway unreachable:', {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (!response.ok) {
        console.warn(
          `[PushNotificationService] notifyViaGateway: gateway returned ${response.status}`
        );
        return;
      }

      let result: NotifyResponse;
      try {
        result = (await response.json()) as NotifyResponse;
      } catch (error) {
        console.warn('[PushNotificationService] notifyViaGateway: invalid gateway response:', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      // Prune tokens the gateway reports as unregistered (FCM equivalent of a
      // 410/404 web-push subscription) so they don't pile up on the PC.
      for (const tokenResult of result.results ?? []) {
        if (tokenResult.ok || !isUnregisteredPushError(tokenResult.error)) {
          continue;
        }
        const endpoints = endpointsByToken.get(tokenResult.token) ?? [];
        for (const endpoint of endpoints) {
          try {
            await this.removeSubscription(userId, endpoint, authToken);
            console.log('[PushNotificationService] notifyViaGateway: pruned unregistered device');
          } catch (removeError) {
            console.error(
              '[PushNotificationService] notifyViaGateway: failed to prune dead subscription:',
              {
                error: removeError instanceof Error ? removeError.message : String(removeError),
              }
            );
          }
        }
      }
    } catch (error) {
      // Top-level guard: notifyViaGateway must NEVER throw (push is best-effort).
      console.error('[PushNotificationService] notifyViaGateway: unexpected error:', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notifyViaExpo(
    userId: string,
    subscriptions: PushSubscription[],
    payload: NotifyPayload,
    authToken?: string
  ): Promise<void> {
    const uniqueSubscriptions = [
      ...new Map(
        subscriptions.map((subscription) => [subscription.endpoint, subscription])
      ).values(),
    ];

    for (let offset = 0; offset < uniqueSubscriptions.length; offset += 100) {
      const batch = uniqueSubscriptions.slice(offset, offset + 100);
      let response: Response | undefined;
      try {
        response = await this.fetchExpoWithRetry(EXPO_PUSH_API_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip, deflate',
          },
          body: JSON.stringify(
            batch.map((subscription) => ({
              to: subscription.endpoint,
              title: payload.title,
              body: payload.body,
              sound: 'default',
              data: payload.chatId ? { chatId: payload.chatId } : {},
            }))
          ),
        });
      } catch (error) {
        console.warn('[PushNotificationService] Expo Push API unreachable:', {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (!response) continue;

      if (!response.ok) {
        console.warn(`[PushNotificationService] Expo Push API returned ${response.status}`);
        continue;
      }

      let tickets: Array<{
        status?: string;
        id?: string;
        details?: { error?: string };
      }>;
      try {
        const result = (await response.json()) as {
          data?:
            | { status?: string; id?: string; details?: { error?: string } }
            | Array<{ status?: string; id?: string; details?: { error?: string } }>;
        };
        tickets = result.data ? (Array.isArray(result.data) ? result.data : [result.data]) : [];
      } catch (error) {
        console.warn('[PushNotificationService] Expo Push API returned invalid JSON:', {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const receipts = new Map<string, string>();
      for (const [index, ticket] of tickets.entries()) {
        const subscription = batch[index];
        if (!subscription) continue;
        if (ticket.status === 'ok' && ticket.id) {
          receipts.set(ticket.id, subscription.endpoint);
          continue;
        }
        if (ticket.status !== 'error' || ticket.details?.error !== 'DeviceNotRegistered') {
          continue;
        }
        try {
          await this.removeSubscription(userId, subscription.endpoint, authToken);
          console.log('[PushNotificationService] Pruned an unregistered Expo device');
        } catch (error) {
          console.error('[PushNotificationService] Failed to prune an Expo device:', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (receipts.size > 0) {
        this.expoDelivery.schedule(
          () => this.pollExpoReceipts(userId, receipts, authToken, 1),
          this.expoDelivery.receiptDelayMs
        );
      }
    }
  }

  private async fetchExpoWithRetry(
    url: string,
    init: Omit<RequestInit, 'signal'>
  ): Promise<Response | undefined> {
    for (let attempt = 1; attempt <= this.expoDelivery.sendAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.expoDelivery.requestTimeoutMs);
      if (typeof timeout.unref === 'function') timeout.unref();
      try {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
        if (response.status !== 429 && response.status < 500) return response;
        if (attempt === this.expoDelivery.sendAttempts) return response;
      } catch (error) {
        if (attempt === this.expoDelivery.sendAttempts) {
          console.warn('[PushNotificationService] Expo request failed after retries:', {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      } finally {
        clearTimeout(timeout);
      }
      await this.expoDelivery.sleep(this.expoDelivery.retryDelayMs * attempt);
    }
    return undefined;
  }

  private async pollExpoReceipts(
    userId: string,
    receipts: Map<string, string>,
    authToken: string | undefined,
    attempt: number
  ): Promise<void> {
    const pending = new Map(receipts);
    let response: Response | undefined;
    try {
      response = await this.fetchExpoWithRetry(EXPO_PUSH_RECEIPTS_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: [...pending.keys()] }),
      });
    } catch {
      response = undefined;
    }

    if (response?.ok) {
      try {
        const result = (await response.json()) as {
          data?: Record<string, { status?: string; details?: { error?: string } }>;
        };
        for (const [ticketId, receipt] of Object.entries(result.data ?? {})) {
          const endpoint = pending.get(ticketId);
          if (!endpoint) continue;
          pending.delete(ticketId);
          if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
            try {
              await this.removeSubscription(userId, endpoint, authToken);
              console.log('[PushNotificationService] Pruned an unregistered Expo device');
            } catch (error) {
              console.error('[PushNotificationService] Failed to prune an Expo device:', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      } catch {
        // Missing receipts are retried below; malformed responses are best-effort.
      }
    }

    if (pending.size === 0 || attempt >= this.expoDelivery.receiptAttempts) return;
    this.expoDelivery.schedule(
      () => this.pollExpoReceipts(userId, pending, authToken, attempt + 1),
      this.expoDelivery.receiptDelayMs
    );
  }

  /**
   * Get the VAPID public key for client subscription
   */
  getVapidPublicKey(): string | undefined {
    return VAPID_PUBLIC_KEY;
  }

  /**
   * Check if push notifications are configured
   */
  isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Get notification settings for a user
   */
  async getNotificationSettings(
    userId: string,
    authToken?: string
  ): Promise<{ enabled: boolean; taskComplete: boolean; notifyWhen: 'always' | 'offline' }> {
    const settings = await this.dbAdapter.getNotificationSettings(userId, authToken);
    if (!settings) {
      return { enabled: false, taskComplete: true, notifyWhen: 'always' };
    }
    return settings;
  }

  /**
   * Update notification settings for a user
   */
  async updateNotificationSettings(
    userId: string,
    settings: Partial<{
      enabled: boolean;
      taskComplete: boolean;
      notifyWhen: 'always' | 'offline';
    }>,
    authToken?: string
  ): Promise<boolean> {
    return this.dbAdapter.updateNotificationSettings(userId, settings, authToken);
  }

  /**
   * Send push notification only if user is offline (no active Socket.IO connections)
   *
   * @param userId - User to notify
   * @param payload - Notification data
   * @param authToken - JWT token for RLS authentication
   * @param isUserOnline - Optional callback to check if user has active connections
   */
  async sendIfOffline(
    userId: string,
    payload: {
      title: string;
      body: string;
      chatId?: string;
      data?: any;
    },
    authToken?: string,
    isUserOnline?: (userId: string) => boolean
  ): Promise<void> {
    try {
      // Get user's notification settings to check notifyWhen preference
      const settings = await this.dbAdapter.getNotificationSettings(userId, authToken);
      const notifyWhen = settings?.notifyWhen || 'always';

      // If notifyWhen is 'offline', check online status before sending
      if (notifyWhen === 'offline' && isUserOnline) {
        const online = isUserOnline(userId);
        if (online) {
          console.log(
            `[PushNotificationService] User ${userId} is online (notifyWhen=offline), skipping push notification`
          );
          return;
        }
        console.log(
          `[PushNotificationService] User ${userId} is offline, sending push notification`
        );
      } else if (notifyWhen === 'always') {
        console.log(
          `[PushNotificationService] User ${userId} notifyWhen=always, sending push notification`
        );
      }

      const notifyPayload: NotifyPayload = {
        title: payload.title,
        body: payload.body,
        chatId: payload.chatId,
        tag: payload.chatId ? `claude-${payload.chatId}` : 'claude-notification',
        icon: '/icons/icon-192.png',
      };

      // Native delivery: iOS Expo tokens go directly to Expo; legacy FCM
      // (including Android) uses the relay when it is configured.
      await this.notifyViaGateway(userId, notifyPayload, authToken);

      // Dormant fallback: local web-push/VAPID. Self-disables when VAPID keys are
      // unset (the local-first common case → sendNotification early-returns).
      await this.sendNotification(
        userId,
        {
          title: payload.title,
          body: payload.body,
          chatId: payload.chatId,
          tag: payload.chatId ? `claude-${payload.chatId}` : 'claude-notification',
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
        },
        authToken
      );
    } catch (error) {
      console.error('[PushNotificationService] Error in sendIfOffline:', error);
    }
  }
}
