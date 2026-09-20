/**
 * Native push-notification device adapter — splits the two native concerns it
 * proxies and lazy-`require`s BOTH native modules, so importing this file — or
 * the ViewModel / screen that defaults to it — never pulls a native module into
 * the Jest/Metro graph:
 *
 *  - **Permission** (`getPermissionState` / `requestPermission`) → `expo-notifications`
 *    (UNUserNotificationCenter authorization). The rest of the push UX —
 *    foreground display handler, notification-tap deep-linking, the Android
 *    channel — also stays on `expo-notifications` (see `PushSetupLayer`).
 *  - **Device token** (`getDeviceToken`) → iOS uses `expo-notifications`
 *    `getExpoPushTokenAsync({ projectId })`, scoped to this fork's EAS project.
 *    Android retains the existing Firebase token path.
 *
 * The token is POSTed to `/api/push/subscribe` with the body
 * `subscription: { endpoint, platform, pushProvider, projectId, appId }` (plus
 * `fcmToken` on Android), which the backend accepts without VAPID keys.
 *
 * Device-only acceptance (a real Expo token from a physical iOS build plus an
 * APNs delivery) is deferred to the established final device pass. Jest and the
 * simulator cannot mint real push tokens, and tests
 * inject a fake {@link PushAdapter} so neither native module is ever loaded.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import {
  PORTABLE_ANDROID_APP_ID,
  PORTABLE_EXPO_PROJECT_ID,
  PORTABLE_IOS_APP_ID,
  isExpoPushToken,
} from '@vgit2/shared/pushConfig';

import type * as ExpoNotifications from 'expo-notifications';
import type * as RNFirebaseMessaging from '@react-native-firebase/messaging';

/** Static surface of the `expo-notifications` module (type-only). */
type NotificationsModule = typeof ExpoNotifications;

/** Tri-state device notification permission. */
export type PushPermissionState = 'granted' | 'denied' | 'undetermined';

export interface PushRegistrationIdentity {
  provider: 'expo' | 'fcm';
  projectId?: string;
  appId: string;
}

/** The seam the ViewModel consumes — fakeable in Jest with zero native code. */
export interface PushAdapter {
  /** Current permission state WITHOUT prompting. */
  getPermissionState(): Promise<PushPermissionState>;
  /** Prompt the OS permission dialog; resolves with the resulting state. */
  requestPermission(): Promise<PushPermissionState>;
  /** EAS-scoped Expo token on iOS; Firebase token on Android. */
  getDeviceToken(): Promise<string>;
  /** Stable identity persisted alongside the token for migration detection. */
  getRegistrationIdentity(): PushRegistrationIdentity;
}

/**
 * Lazily resolve `expo-notifications`. Kept out of module scope so the native
 * module never loads at import time (Jest / Metro graph stays clean).
 */
function getNotifications(): NotificationsModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('expo-notifications') as NotificationsModule;
}

function getMessaging(): typeof RNFirebaseMessaging {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('@react-native-firebase/messaging') as typeof RNFirebaseMessaging;
}

/**
 * Map an expo permission response to the tri-state. Structural param (`status`
 * is the expo-modules-core string enum, assignable to `string`) so no VALUE
 * import from the native module is needed.
 */
function toPermissionState(response: { granted: boolean; status: string }): PushPermissionState {
  if (response.granted || response.status === 'granted') return 'granted';
  if (response.status === 'denied') return 'denied';
  return 'undetermined';
}

interface ExpoPushAdapterOptions {
  projectId?: string;
  appId?: string;
}

function resolveProjectId(): string {
  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  return typeof projectId === 'string' && projectId.length > 0
    ? projectId
    : PORTABLE_EXPO_PROJECT_ID;
}

function resolveAppId(): string {
  const appId =
    Platform.OS === 'ios'
      ? Constants.expoConfig?.ios?.bundleIdentifier
      : Constants.expoConfig?.android?.package;
  if (typeof appId === 'string' && appId.length > 0) return appId;
  return Platform.OS === 'ios' ? PORTABLE_IOS_APP_ID : PORTABLE_ANDROID_APP_ID;
}

/** The production adapter over `expo-notifications`. */
export function createExpoPushAdapter(options: ExpoPushAdapterOptions = {}): PushAdapter {
  const identity: PushRegistrationIdentity = {
    provider: Platform.OS === 'ios' ? 'expo' : 'fcm',
    projectId: Platform.OS === 'ios' ? (options.projectId ?? resolveProjectId()) : undefined,
    appId: options.appId ?? resolveAppId(),
  };

  return {
    async getPermissionState() {
      return toPermissionState(await getNotifications().getPermissionsAsync());
    },
    async requestPermission() {
      return toPermissionState(await getNotifications().requestPermissionsAsync());
    },
    async getDeviceToken() {
      if (identity.provider === 'expo') {
        const token = await getNotifications().getExpoPushTokenAsync({
          projectId: identity.projectId,
        });
        if (!isExpoPushToken(token.data)) {
          throw new Error('Expo returned an invalid push token');
        }
        return token.data;
      }
      const messaging = getMessaging();
      return await messaging.getToken(messaging.getMessaging());
    },
    getRegistrationIdentity: () => identity,
  };
}
