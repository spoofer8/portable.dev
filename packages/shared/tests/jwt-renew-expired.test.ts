/**
 * PSK-proven token renewal primitives: expired is acceptable, a bad signature
 * is not. All calls pass an explicit secret so the suite is hermetic (no
 * JWT_SECRET env / module-load coupling).
 */
import { describe, expect, it } from 'bun:test';

import {
  TokenExpiredAuthError,
  TokenInvalidAuthError,
  classifyJwtError,
  decodeAuthToken,
  generateAuthToken,
  renewAuthTokenAllowExpired,
  verifyAuthTokenAllowExpired,
} from '../src/jwt';

const SECRET = 'test-secret-for-renew-suite';
const OTHER_SECRET = 'a-completely-different-secret';

const IDENTITY = {
  userId: 'pc-1234',
  username: 'brunoccpires',
  email: 'local@brunos-mac',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1',
};

/** Mint a token whose exp is already in the past (no sleeping). */
function mintExpired(): string {
  return generateAuthToken(IDENTITY, SECRET, { expiresIn: '-10s' });
}

describe('verifyAuthTokenAllowExpired', () => {
  it('accepts an expired token and returns the full payload', () => {
    const payload = verifyAuthTokenAllowExpired(mintExpired(), SECRET);
    expect(payload.userId).toBe(IDENTITY.userId);
    expect(payload.username).toBe(IDENTITY.username);
    expect(payload.email).toBe(IDENTITY.email);
    expect(payload.exp! * 1000).toBeLessThan(Date.now());
  });

  it('still accepts a currently-valid token', () => {
    const token = generateAuthToken(IDENTITY, SECRET);
    const payload = verifyAuthTokenAllowExpired(token, SECRET);
    expect(payload.email).toBe(IDENTITY.email);
  });

  it('rejects a wrong-secret token with TokenInvalidAuthError (expired or not)', () => {
    const foreign = generateAuthToken(IDENTITY, OTHER_SECRET, { expiresIn: '-10s' });
    expect(() => verifyAuthTokenAllowExpired(foreign, SECRET)).toThrow(TokenInvalidAuthError);
  });

  it('rejects garbage with TokenInvalidAuthError keeping the legacy message shape', () => {
    try {
      verifyAuthTokenAllowExpired('not.a.jwt', SECRET);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TokenInvalidAuthError);
      expect((err as Error).message.startsWith('Invalid token:')).toBe(true);
    }
  });
});

describe('renewAuthTokenAllowExpired', () => {
  it('re-mints an expired token preserving identity with a fresh future exp and new jti', () => {
    const old = mintExpired();
    const oldPayload = decodeAuthToken(old)!;

    const fresh = renewAuthTokenAllowExpired(old, SECRET);
    const payload = verifyAuthTokenAllowExpired(fresh, SECRET);

    expect(payload.userId).toBe(IDENTITY.userId);
    expect(payload.username).toBe(IDENTITY.username);
    expect(payload.email).toBe(IDENTITY.email);
    expect(payload.avatarUrl).toBe(IDENTITY.avatarUrl);
    expect(payload.sub).toBe(IDENTITY.email);
    expect(payload.exp! * 1000).toBeGreaterThan(Date.now());
    expect(payload.jti).not.toBe(oldPayload.jti);
  });

  it('rejects a wrong-secret token — a rotated JWT_SECRET means genuine re-pair', () => {
    const foreign = generateAuthToken(IDENTITY, OTHER_SECRET, { expiresIn: '-10s' });
    expect(() => renewAuthTokenAllowExpired(foreign, SECRET)).toThrow(TokenInvalidAuthError);
  });

  it('refuses non-user tokens (webhook/service) — renew is for pairing tokens only', () => {
    const webhook = generateAuthToken(
      { ...IDENTITY, type: 'webhook', repoOwner: 'o', repoName: 'r' } as never,
      SECRET,
      { expiresIn: '-10s' }
    );
    expect(() => renewAuthTokenAllowExpired(webhook, SECRET)).toThrow(TokenInvalidAuthError);

    const service = generateAuthToken({ ...IDENTITY, serviceAccount: true } as never, SECRET);
    expect(() => renewAuthTokenAllowExpired(service, SECRET)).toThrow(TokenInvalidAuthError);
  });

  it('refuses sibling service-account markers alone (serviceAccountId / allowedUserIds)', () => {
    const byId = generateAuthToken({ ...IDENTITY, serviceAccountId: 'sa-1' } as never, SECRET);
    expect(() => renewAuthTokenAllowExpired(byId, SECRET)).toThrow(TokenInvalidAuthError);

    const byAllowlist = generateAuthToken({ ...IDENTITY, allowedUserIds: [] } as never, SECRET);
    expect(() => renewAuthTokenAllowExpired(byAllowlist, SECRET)).toThrow(TokenInvalidAuthError);
  });
});

describe('classifyJwtError', () => {
  it('maps the typed errors to their wire codes', () => {
    expect(classifyJwtError(new TokenExpiredAuthError())).toBe('token_expired');
    expect(classifyJwtError(new TokenInvalidAuthError('Invalid token: nope'))).toBe(
      'token_invalid'
    );
  });

  it('falls back to the legacy message match and defaults to token_invalid', () => {
    expect(classifyJwtError(new Error('Token has expired'))).toBe('token_expired');
    expect(classifyJwtError(new Error('anything else'))).toBe('token_invalid');
    expect(classifyJwtError('not-an-error')).toBe('token_invalid');
  });

  it('typed errors keep the exact legacy message strings (string-match contracts)', () => {
    expect(new TokenExpiredAuthError().message).toBe('Token has expired');
  });
});
