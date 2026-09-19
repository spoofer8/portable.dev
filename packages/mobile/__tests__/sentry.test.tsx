/**
 * Sentry error monitoring.
 *
 * Covers the framework-free DSN resolution, `initSentry` (reuses the shared
 * `buildSentryConfig`; leaves release/dist unset), the app-wide error boundary
 * passthrough + fallback, the dev-mode test-page ViewModel (every error seam
 * injected so the suite never actually throws), and the test screen. `@sentry/
 * react-native` is globally stubbed in `jest.setup.js` (the native module is
 * absent under jest-expo); `react-native-mmkv` is mocked because `SentryTestScreen`
 * → settings chrome → `useAppTheme` → themeStore touches it at import.
 */

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Sentry from '@sentry/react-native';

jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string | number | boolean) => store.set(k, String(v)),
    getString: (k: string) => (store.has(k) ? store.get(k) : undefined),
    remove: (k: string) => store.delete(k),
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

import {
  resolveSentryDsn,
  isSentryTestEnabled,
  redactSentryText,
  sanitizeSentryAttributes,
  type SentryEnv,
} from '../src/features/observability/sentryConfig';
import { initSentry, getSentryRuntimeInfo } from '../src/features/observability/initSentry';
import { AppErrorBoundary, ErrorFallback } from '../src/features/observability/AppErrorBoundary';
import { useSentryTest } from '../src/features/observability/useSentryTest';
import { SentryTestScreen } from '../src/features/observability/SentryTestScreen';
import { socketLog } from '../src/features/socket/socketLog';

const SAFE_AREA_METRICS = {
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
  frame: { x: 0, y: 0, width: 390, height: 844 },
};

const env = (over: Partial<SentryEnv> = {}): SentryEnv => ({ enableTest: false, ...over });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveSentryDsn', () => {
  it('an explicit EXPO_PUBLIC_SENTRY_DSN always wins (even in dev)', () => {
    expect(resolveSentryDsn(true, env({ dsn: 'https://ci@example/9' }))).toBe(
      'https://ci@example/9'
    );
  });

  it('plain dev (no flag, no override) → undefined (Sentry stays off — no flood)', () => {
    expect(resolveSentryDsn(true, env())).toBeUndefined();
  });

  it('dev test mode still requires an explicit DSN', () => {
    expect(resolveSentryDsn(true, env({ enableTest: true }))).toBeUndefined();
  });

  it('a release build without a configured DSN stays disabled', () => {
    expect(resolveSentryDsn(false, env())).toBeUndefined();
  });

  it('a blank/whitespace override is treated as missing', () => {
    expect(resolveSentryDsn(true, env({ dsn: '   ' }))).toBeUndefined();
    expect(resolveSentryDsn(false, env({ dsn: '' }))).toBeUndefined();
  });

  it('isSentryTestEnabled reads the flag', () => {
    expect(isSentryTestEnabled(env({ enableTest: true }))).toBe(true);
    expect(isSentryTestEnabled(env())).toBe(false);
  });
});

describe('initSentry', () => {
  it('calls Sentry.init with a configured DSN and reports active', () => {
    const dsn = 'https://public@example.invalid/1';
    const started = initSentry('mobile', dsn);
    expect(started).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const opts = (Sentry.init as jest.Mock).mock.calls[0][0];
    // release/dist are deliberately UNSET (auto-detected from the native build).
    expect(opts.release).toBeUndefined();
    expect(opts.dist).toBeUndefined();
    expect(opts.dsn).toBe(dsn);
    expect(opts.initialScope.tags.service).toBe('mobile');
    expect(opts.enableLogs).toBe(true);
    expect(opts.enableAutoConsoleLogs).toBe(false);
    expect(
      opts.beforeSendLog({
        level: 'warn',
        message: 'retrying https://private.example/path',
        attributes: { attempt: 2, token: 'secret-token' },
      })
    ).toEqual({
      level: 'warn',
      message: 'retrying [url]',
      attributes: { attempt: 2 },
    });
    // beforeSend drops non-error levels.
    expect(opts.beforeSend({ level: 'info' })).toBeNull();
    expect(opts.beforeSend({ level: 'error', extra: { a: 1 } })).toMatchObject({ level: 'error' });

    const event = opts.beforeSend({
      level: 'error',
      message: 'failed for user@example.com at /Users/example/repo',
      exception: { values: [{ type: 'Error', value: 'token=secret-token' }] },
      breadcrumbs: [
        {
          message: 'request https://private.example/path',
          data: { status: 'failed', token: 'secret-token' },
        },
      ],
      tags: { service: 'mobile', token: 'secret-token' },
      user: { id: 'private-user' },
      request: { url: 'https://private.example/path' },
      contexts: { device: { name: 'Umair Phone' } },
      extra: { prompt: 'private prompt' },
    });

    expect(event).toMatchObject({
      message: 'failed for [email] at [path]',
      exception: { values: [{ type: 'Error', value: 'token=[redacted]' }] },
      breadcrumbs: [{ message: 'request [url]', data: { status: 'failed' } }],
      tags: { service: 'mobile' },
    });
    expect(event).not.toHaveProperty('user');
    expect(event).not.toHaveProperty('request');
    expect(event).not.toHaveProperty('contexts');
    expect(event).not.toHaveProperty('extra');
  });

  it('redacts sensitive log fields while preserving operational state', () => {
    expect(
      sanitizeSentryAttributes({
        attempt: 2,
        reconnect: true,
        token: 'secret-token',
        path: '/Users/example/private/repo',
        reason: 'transport closed at https://private.example/path',
      })
    ).toEqual({
      attempt: 2,
      reconnect: true,
      reason: 'transport closed at [url]',
    });
    expect(redactSentryText('Bearer secret-token at /Users/example/private/repo')).toBe(
      'Bearer [redacted] at [path]'
    );
    expect(redactSentryText('email=user@example.com token=secret-token password: hunter2')).toBe(
      'email=[email] token=[redacted] password=[redacted]'
    );
  });

  it('getSentryRuntimeInfo reflects the active client options', () => {
    (Sentry.getClient as jest.Mock).mockReturnValueOnce({
      getOptions: () => ({
        environment: 'ios',
        release: 'dev.portable.app@1.5.0+1042',
        dist: '1042',
      }),
    });
    expect(getSentryRuntimeInfo()).toEqual({
      active: true,
      environment: 'ios',
      release: 'dev.portable.app@1.5.0+1042',
      dist: '1042',
    });
  });
});

describe('structured Sentry logs', () => {
  it('sends allowlisted socket state without identifiers or paths', () => {
    socketLog('connect', {
      reconnect: true,
      id: 'socket-secret',
      path: '/t/private-machine',
    });

    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith({
      category: 'socket',
      message: 'connect',
      level: 'info',
      data: { reconnect: true },
    });
    expect(Sentry.logger.info).toHaveBeenCalledWith('[socket] connect', {
      reconnect: true,
    });
  });
});

describe('AppErrorBoundary', () => {
  it('renders children (passthrough) and the fallback shows a recovery screen', () => {
    render(
      <AppErrorBoundary>
        <Text testID="boundary-child">ok</Text>
      </AppErrorBoundary>
    );
    expect(screen.getByTestId('boundary-child')).toBeTruthy();

    const resetError = jest.fn();
    render(<ErrorFallback error={new Error('boom')} resetError={resetError} />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    fireEvent.press(screen.getByTestId('app-error-boundary-reset'));
    expect(resetError).toHaveBeenCalledTimes(1);
  });
});

describe('useSentryTest', () => {
  it('manual capture calls Sentry.captureException and surfaces the event id', () => {
    const captureException = jest.fn((_e: unknown) => 'evt-1');
    const { result } = renderHook(() =>
      useSentryTest({ captureException, now: () => 'T', runtimeInfo: () => ({ active: true }) })
    );
    act(() => result.current.captureManually());
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(result.current.status).toContain('evt-1');
  });

  it('throwUncaught schedules the throw WITHOUT invoking it (no crash)', () => {
    const scheduleUncaught = jest.fn(); // records the throwFn, never calls it
    const { result } = renderHook(() =>
      useSentryTest({ scheduleUncaught, runtimeInfo: () => ({ active: true }) })
    );
    act(() => result.current.throwUncaught());
    expect(scheduleUncaught).toHaveBeenCalledTimes(1);
    expect(typeof scheduleUncaught.mock.calls[0][0]).toBe('function');
    expect(result.current.status).toContain('UNCAUGHT');
  });

  it('arms/resets the render bomb and records a caught render error', () => {
    const { result } = renderHook(() => useSentryTest({ runtimeInfo: () => ({ active: true }) }));
    expect(result.current.bombArmed).toBe(false);
    act(() => result.current.armBomb());
    expect(result.current.bombArmed).toBe(true);
    act(() => result.current.resetBomb());
    expect(result.current.bombArmed).toBe(false);
    act(() => result.current.onBombCaught('evt-2'));
    expect(result.current.status).toContain('evt-2');
  });

  it('exposes the active state + a runtime label', () => {
    const { result } = renderHook(() =>
      useSentryTest({ runtimeInfo: () => ({ active: true, environment: 'android' }) })
    );
    expect(result.current.sentryActive).toBe(true);
    expect(result.current.runtimeLabel).toContain('env: android');
    expect(result.current.runtimeLabel).toContain('release: (native auto)');
  });
});

describe('SentryTestScreen', () => {
  it('renders the dev page and the Capture button fires captureException', () => {
    const captureException = jest.fn((_e: unknown) => 'evt-9');
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <SentryTestScreen captureException={captureException} />
      </SafeAreaProvider>
    );
    expect(screen.getByTestId('sentry-test-screen')).toBeTruthy();
    expect(screen.getByTestId('sentry-test-active')).toBeTruthy();
    // NB: never press the throw/render buttons here — they intentionally crash.
    fireEvent.press(screen.getByTestId('sentry-test-capture'));
    expect(captureException).toHaveBeenCalledTimes(1);
    // RNTL `toHaveTextContent` with a bare string is exact-ish for symbol-adjacent
    // text ("… → event id: evt-9") — assert with a regex (documented gotcha).
    expect(screen.getByTestId('sentry-test-status')).toHaveTextContent(/evt-9/);
  });
});
