/**
 * PushPermissionPrompt — the one-time "Enable notifications" ask.
 *
 * Shown at most ONCE per device (guarded by `usePushRegistrationStore().
 * permissionAsked`, MMKV-persisted) to an authenticated, fully-provisioned user
 * (mounted by {@link PushSetupLayer} inside `ApiProvider`, AFTER the gate ladder —
 * NOT tied to onboarding, so returning users are asked too). Behavior on mount:
 *
 *  - **Already granted** → never show the modal; silently refresh this device's
 *    registration on every launch. This repairs token rotation, lost server
 *    rows, and registrations created by older builds.
 *  - **Undetermined / denied** AND not asked before → show the modal after a
 *    short settle delay, marking `permissionAsked` so it never reappears.
 *      - "Enable Notifications" → `vm.toggle()` (request OS permission → register).
 *      - "Not now" → just close.
 *
 * All `expo-notifications` access is behind the {@link PushAdapter} seam
 * (injectable for tests), so the native module never loads under Jest.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../../theme';
import { createExpoPushAdapter, type PushAdapter } from './pushAdapter';
import { usePushRegistrationStore } from './pushRegistrationStore';
import { useNotificationsViewModel } from './useNotificationsViewModel';

/** Settle delay before the modal pops, so it doesn't fight the first paint. */
const PROMPT_DELAY_MS = 500;

export interface PushPermissionPromptDeps {
  /** Override the PushAdapter (default: `createExpoPushAdapter()`). */
  adapter?: PushAdapter;
  /** Retry schedule for automatic registration migration. */
  migrationRetryDelaysMs?: readonly number[];
}

export interface PushPermissionPromptProps {
  deps?: PushPermissionPromptDeps;
}

/**
 * Renders the one-time push-permission modal (or registers silently when already
 * granted). Returns `null` whenever the modal is not visible.
 */
export function PushPermissionPrompt({ deps }: PushPermissionPromptProps) {
  const { theme } = useAppTheme();

  const vm = useNotificationsViewModel({ adapter: deps?.adapter });

  const [visible, setVisible] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const adapter = deps?.adapter ?? createExpoPushAdapter();

    void adapter.getPermissionState().then((state) => {
      if (cancelled) return;
      // Read the store at DECISION time (not a mount-time closure snapshot) so the
      // guard can't act on stale values after the async permission check resolves.
      const store = usePushRegistrationStore.getState();

      if (state === 'granted') {
        // Keep the prior local registration until the replacement POST succeeds.
        // A current token is refreshed too, so token rotation and lost server rows
        // self-heal without making Settings briefly report Disabled.
        const delays = deps?.migrationRetryDelaysMs ?? [0, 1_000, 5_000];
        void (async () => {
          for (const delayMs of delays) {
            if (cancelled) return;
            if (delayMs > 0) {
              await new Promise<void>((resolve) => {
                timer = setTimeout(resolve, delayMs);
              });
            }
            if (cancelled) return;
            try {
              await vm.ensureRegistered();
              return;
            } catch {
              // Retry on this mount; the ViewModel exposes `failed` in its store.
            }
          }
        })();
        return;
      }

      // Not granted yet (undetermined / denied) — show the one-time prompt.
      if (store.permissionAsked) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        // Mark at display time: a user who never sees it (e.g. backgrounded
        // during the delay) gets another chance next launch.
        usePushRegistrationStore.getState().markPermissionAsked();
        setVisible(true);
      }, PROMPT_DELAY_MS);
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Mount-only — store reads happen imperatively inside the callback; the seams
    // are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing to show until the (one-time) decision sets it visible.
  if (!visible) return null;

  async function handleEnable() {
    setRequesting(true);
    try {
      await vm.toggle();
    } finally {
      setRequesting(false);
      setVisible(false);
    }
  }

  function handleNotNow() {
    setVisible(false);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleNotNow}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View
          style={[
            styles.card,
            { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.title, { color: theme.colors.text }]}>Stay in the Loop</Text>
          <Text style={[styles.body, { color: theme.colors.textSecondary }]}>
            Get notified when Claude finishes tasks, even when the app is in the background.
          </Text>

          <Pressable
            testID="push-permission-enable"
            accessibilityRole="button"
            onPress={() => void handleEnable()}
            disabled={requesting}
            style={[
              styles.primaryButton,
              { backgroundColor: theme.colors.primary },
              requesting && styles.busy,
            ]}
          >
            {requesting ? <ActivityIndicator size="small" color="#ffffff" /> : null}
            <Text style={styles.primaryButtonText}>
              {requesting ? 'Enabling…' : 'Enable Notifications'}
            </Text>
          </Pressable>

          <Pressable
            testID="push-permission-not-now"
            accessibilityRole="button"
            onPress={handleNotNow}
            style={[styles.secondaryButton, { borderColor: theme.colors.border }]}
          >
            <Text style={[styles.secondaryButtonText, { color: theme.colors.textSecondary }]}>
              Not Now
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 4,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  busy: { opacity: 0.6 },
});
