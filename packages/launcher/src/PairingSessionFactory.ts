/**
 * PairingSessionFactory — mint a FRESH pairing QR on demand from a separate,
 * short-lived `portable` process (PRD §8).
 *
 * The QR the daemon shows was minted at boot; its JWT has a 72h sliding window,
 * so a long-running daemon eventually presents an EXPIRED token. The fix: when
 * the operator opens "Show / refresh pairing QR" on the dashboard, we re-mint a
 * brand-new token here — the api already holds the same `JWT_SECRET` and accepts
 * ANY token signed by it (proven by {@link notifyRunningInstanceOfRepoChange}),
 * so nothing needs to be sent to the daemon.
 *
 * The effective context (dataDir, pcId, relay base) comes from the
 * {@link ServiceInstallManifest} so a dashboard launched from ANY cwd opens the
 * RIGHT `LocalSecretStore` and rebuilds the SAME `{gatewayBase, pcId, e2eKey}`
 * (PRD §5); it falls back to the ambient env when no manifest exists.
 *
 * Security (PRD §8.3): each open/refresh mints a NEW token (fresh `iat`/`exp`/
 * `jti`); the token is NEVER persisted or logged; the ephemeral fallback page
 * binds ONLY `127.0.0.1` (never tunneled — the token would leak through the
 * relay) and is torn down on {@link close}.
 */
import { decodeAuthToken } from '@vgit2/shared/jwt';
import { LocalSecretStore, resolveDataDir } from '@vgit2/shared/secrets';

import { resolveRelayBaseUrl, resolveWakeCapability } from './config.js';
import {
  ensureE2ePsk,
  ensureJwtSecret,
  mintPairingToken,
  resolvePairingIdentity,
} from './PairingIdentity.js';
import { PairingServer } from './PairingServer.js';
import { readServiceInstallManifest } from './ServiceInstallManifest.js';
import { renderTerminalQr } from './TerminalUi.js';

import type { DashboardPairingSession, DashboardPairingView } from './ServiceDashboardUi.js';

/**
 * Best-effort read of the connected GitHub login from the store (the same record
 * `LocalGitHubAuthService` persists). Inlined here — mirrors
 * `Launcher.readStoredGitHubLogin` — to avoid importing the heavy Launcher module.
 */
function storedGitHubLogin(store: Pick<LocalSecretStore, 'get'>): string | undefined {
  try {
    const raw = store.get('github-oauth:token');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { login?: unknown };
    const login = typeof parsed.login === 'string' ? parsed.login.trim() : '';
    return login.length > 0 ? login : undefined;
  } catch {
    return undefined;
  }
}

/** The effective, cwd-independent pairing context (PRD §5). */
export interface FreshPairingContext {
  dataDir: string;
  pcId: string;
  /** The relay base — `gatewayBase` in the payload. */
  gatewayBase: string;
  /** Optional out-of-band wake endpoint and bearer. */
  wakeCapability?: { wakeUrl: string; wakeToken: string };
}

/** A freshly-minted pairing session (superset of {@link DashboardPairingView}). */
export interface FreshPairingSession extends DashboardPairingView {
  /** The QR payload string `{ gatewayBase, pcId, token, e2eKey }`. */
  payload: string;
}

/**
 * Resolve the effective pairing context: prefer the frozen
 * {@link ServiceInstallManifest} (so any cwd rebuilds the daemon's real config),
 * else the ambient env. `pcId` falls back to the persisted store value.
 */
export function resolveFreshPairingContext(
  options: {
    env?: NodeJS.ProcessEnv;
    store?: Pick<LocalSecretStore, 'get' | 'set'>;
    readManifest?: () => ReturnType<typeof readServiceInstallManifest>;
  } = {}
): FreshPairingContext {
  const readManifest =
    options.readManifest ??
    (() => {
      try {
        return readServiceInstallManifest();
      } catch {
        // A version-mismatch is surfaced elsewhere — the factory falls back to env.
        return null;
      }
    });
  const manifest = readManifest();
  if (manifest) {
    return {
      dataDir: manifest.dataDir,
      pcId: manifest.pcId,
      gatewayBase: manifest.relayBaseUrl,
      wakeCapability: resolveWakeCapability(options.env ?? process.env, options.store),
    };
  }
  const env = options.env ?? process.env;
  const dataDir = resolveDataDir();
  const store = (options.store as LocalSecretStore) ?? new LocalSecretStore({ dataDir });
  // Lazy import avoidance: resolvePcId lives in TunnelRegistrationAgent — read the
  // same way ensureJwtSecret does. Prefer the env override, else the stored id.
  const pcId = env.PORTABLE_PC_ID?.trim() || store.get('tunnel:pc-id')?.trim() || '';
  return {
    dataDir,
    pcId,
    gatewayBase: resolveRelayBaseUrl(env),
    wakeCapability: resolveWakeCapability(env, store),
  };
}

export interface PairingSessionFactoryDeps {
  /** Override the resolved context (tests / explicit dataDir). */
  context?: FreshPairingContext;
  /** Env (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Secret store seam — defaults to a real {@link LocalSecretStore} on the context dataDir. */
  store?: Pick<LocalSecretStore, 'get' | 'set'>;
  /** Token mint seam (defaults to {@link mintPairingToken} over the resolved identity). */
  mintToken?: (jwtSecret: string) => string;
  /** QR render seam (defaults to {@link renderTerminalQr}). */
  renderQr?: (payload: string) => Promise<string>;
  /** Ephemeral loopback page factory (defaults to a real {@link PairingServer}). */
  makePairingServer?: (payload: string, endpoint: string) => PairingServer;
  /** Log sink (defaults to a no-op — a token must NEVER be logged, §8.3). */
  log?: (line: string) => void;
}

/**
 * Mints fresh pairing sessions and manages ONE ephemeral loopback page at a time.
 * Implements {@link DashboardPairingSession} so it plugs straight into the
 * dashboard: `refresh()` re-mints + (re)serves the page; `close()` tears the page
 * down when leaving the QR screen.
 */
export class PairingSessionFactory implements DashboardPairingSession {
  private readonly deps: PairingSessionFactoryDeps;
  private readonly context: FreshPairingContext;
  private readonly store: Pick<LocalSecretStore, 'get' | 'set'>;
  private server: PairingServer | null = null;

  constructor(deps: PairingSessionFactoryDeps = {}) {
    this.deps = deps;
    this.context = deps.context ?? resolveFreshPairingContext({ env: deps.env, store: deps.store });
    this.store =
      deps.store ?? (new LocalSecretStore({ dataDir: this.context.dataDir }) as LocalSecretStore);
  }

  /** Build the QR payload string `{ gatewayBase, pcId, token, e2eKey }`. */
  private buildPayload(token: string, e2ePsk: string): string {
    return JSON.stringify({
      gatewayBase: this.context.gatewayBase,
      pcId: this.context.pcId,
      token,
      e2eKey: e2ePsk,
      ...this.context.wakeCapability,
    });
  }

  /** Mint a fresh token, render the QR, and (re)serve the ephemeral loopback page. */
  async refresh(): Promise<FreshPairingSession> {
    // Tear down any previous ephemeral page before minting a new session.
    await this.close();

    const jwtSecret = ensureJwtSecret(this.store as LocalSecretStore, this.deps.env);
    const e2ePsk = ensureE2ePsk(this.store as LocalSecretStore, this.deps.env);
    const githubLogin = storedGitHubLogin(this.store);
    const mint =
      this.deps.mintToken ??
      ((secret: string) =>
        mintPairingToken(resolvePairingIdentity({ pcId: this.context.pcId, githubLogin }), secret));
    // A NEW token every call (generateAuthToken stamps a fresh iat/exp/jti).
    const token = mint(jwtSecret);
    const payload = this.buildPayload(token, e2ePsk);
    const qr = await (this.deps.renderQr ?? renderTerminalQr)(payload);

    const decoded = decodeAuthToken(token);
    const expiresAt =
      decoded && typeof decoded.exp === 'number'
        ? new Date(decoded.exp * 1000).toISOString()
        : undefined;

    const endpoint = `${this.context.gatewayBase}/t/${this.context.pcId}`;
    let loopbackUrl: string | undefined;
    try {
      const makeServer =
        this.deps.makePairingServer ??
        ((p, e) => new PairingServer({ payload: p, endpoint: e, log: this.deps.log }));
      this.server = makeServer(payload, endpoint);
      loopbackUrl = await this.server.start();
    } catch {
      // The loopback page is a fallback — the QR still works without it.
      this.server = null;
    }

    return { payload, qr, expiresAt, loopbackUrl };
  }

  /** Stop the ephemeral loopback page (idempotent). */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      try {
        await server.stop();
      } catch {
        // best-effort teardown
      }
    }
  }
}
