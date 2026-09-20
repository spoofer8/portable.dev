/**
 * Per-DEVICE push-registration slice. The backend's `GET /api/push/settings`
 * `enabled` flag is USER-level (true whenever ANY subscription row exists), so
 * it can NOT tell whether THIS device registered its APNs/FCM token. Native RN
 * has no OS-level lookup, so the device's registered endpoint is persisted HERE
 * after a successful `POST /api/push/subscribe` and cleared on
 * `POST /api/push/unsubscribe` — the Notifications settings status derives from
 * this, never from the user-level flag (a fresh install must show "Disabled"
 * even when the user has another subscription active). Provider/project/app
 * identity lets startup replace registrations created by older FCM builds.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../../../state/storage';

/** MMKV persist key for the per-device push registration. */
export const PUSH_REGISTRATION_PERSIST_KEY = 'portable.pushRegistration';

export interface PushRegistrationState {
  /** The device token registered with `POST /api/push/subscribe`, or null. */
  registeredEndpoint: string | null;
  registeredProvider: 'expo' | 'fcm' | null;
  registeredProjectId: string | null;
  registeredAppId: string | null;
  registrationSyncStatus: 'idle' | 'syncing' | 'current' | 'failed';
  setRegisteredEndpoint: (endpoint: string) => void;
  setRegistration: (registration: {
    endpoint: string;
    provider: 'expo' | 'fcm';
    projectId?: string;
    appId: string;
  }) => void;
  clearRegisteredEndpoint: () => void;
  markRegistrationSyncing: () => void;
  markRegistrationFailed: () => void;
  /**
   * Whether the one-time push-permission prompt has already been shown to this
   * device. Set `true` when {@link PushPermissionPrompt} actually displays the
   * modal, so the prompt never appears more than once — even across app
   * restarts. Persisted to MMKV alongside `registeredEndpoint`.
   */
  permissionAsked: boolean;
  markPermissionAsked: () => void;
}

export const usePushRegistrationStore = create<PushRegistrationState>()(
  persist(
    (set) => ({
      registeredEndpoint: null,
      registeredProvider: null,
      registeredProjectId: null,
      registeredAppId: null,
      registrationSyncStatus: 'idle',
      setRegisteredEndpoint: (endpoint) =>
        set({
          registeredEndpoint: endpoint,
          registeredProvider: null,
          registeredProjectId: null,
          registeredAppId: null,
          registrationSyncStatus: 'idle',
        }),
      setRegistration: ({ endpoint, provider, projectId, appId }) =>
        set({
          registeredEndpoint: endpoint,
          registeredProvider: provider,
          registeredProjectId: projectId ?? null,
          registeredAppId: appId,
          registrationSyncStatus: 'current',
        }),
      clearRegisteredEndpoint: () =>
        set({
          registeredEndpoint: null,
          registeredProvider: null,
          registeredProjectId: null,
          registeredAppId: null,
          registrationSyncStatus: 'idle',
        }),
      markRegistrationSyncing: () => set({ registrationSyncStatus: 'syncing' }),
      markRegistrationFailed: () => set({ registrationSyncStatus: 'failed' }),
      permissionAsked: false,
      markPermissionAsked: () => set({ permissionAsked: true }),
    }),
    {
      name: PUSH_REGISTRATION_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
    }
  )
);
