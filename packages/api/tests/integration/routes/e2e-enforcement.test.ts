/**
 * E2E plaintext-rejection enforcement (portable.dev#13, hard cutover).
 *
 * When E2E is configured, a plaintext `/api/*` request to a protected route is
 * rejected 426 — even with a valid Bearer (closing the "malicious relay replays
 * the visible token" hole) — while the decrypted-tunnel loopback replay (which
 * carries the per-boot inner secret) and the exempt surfaces pass through.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { generateAuthToken } from '@vgit2/shared/jwt';
import { LocalSecretStore } from '@vgit2/shared/secrets';
import express, { type Application } from 'express';
import request from 'supertest';

import {
  createE2eEnforcementMiddleware,
  E2E_INNER_SECRET_HEADER,
} from '../../../src/middleware/e2eEnforcement.js';
import { createJwtAuthMiddleware } from '../../../src/middleware/jwtAuth.js';
import { DeviceTokenService } from '../../../src/services/DeviceTokenService.js';

const INNER_SECRET = 'boot-secret-abc';

function makeApp(configured: boolean): Application {
  const app = express();
  app.use('/api', createE2eEnforcementMiddleware({ isConfigured: () => configured }, INNER_SECRET));
  // A stand-in for whatever protected route would run next.
  app.use('/api', (_req, res) => res.status(200).json({ reached: true }));
  return app;
}

describe('E2E enforcement (configured)', () => {
  it('rejects a plaintext protected request with 426 e2e_required (even with a Bearer)', async () => {
    const res = await request(makeApp(true))
      .get('/api/chats')
      .set('Authorization', 'Bearer valid-looking-jwt');
    expect(res.status).toBe(426);
    expect(res.body.code).toBe('e2e_required');
  });

  it('allows the trusted loopback replay carrying the inner secret', async () => {
    const res = await request(makeApp(true))
      .get('/api/chats')
      .set(E2E_INNER_SECRET_HEADER, INNER_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it('rejects a forged inner-secret header (relay cannot guess it)', async () => {
    const res = await request(makeApp(true))
      .get('/api/chats')
      .set(E2E_INNER_SECRET_HEADER, 'wrong-secret');
    expect(res.status).toBe(426);
  });

  it('exempts a plaintext POST /api/e2e/renew (the sealed envelope is the auth — never 426)', async () => {
    const res = await request(makeApp(true)).post('/api/e2e/renew').send({});
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it('exempts health, e2e, internal, and native-loader media/raw routes', async () => {
    const app = makeApp(true);
    for (const path of [
      '/api/health',
      '/api/e2e/handshake',
      '/api/internal/sidecar/poll',
      '/api/video/octocat/repo/clip.mp4',
      '/api/uploads/file.png',
      '/api/repos/octocat/repo/raw/src/index.ts',
      '/api/upload',
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
    }
  });
});

describe('E2E enforcement (unconfigured — bare dev / tests)', () => {
  it('is a no-op: plaintext requests pass through', async () => {
    const res = await request(makeApp(false)).get('/api/chats');
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });
});

/**
 * jwtAuth PUBLIC_ROUTES proof: `/api/e2e/renew` must be reachable with NO
 * Authorization (the sealed envelope is the auth) — exercised through the
 * REAL jwt middleware with a device-token service wired.
 */
describe('jwtAuth — /api/e2e/renew is PUBLIC + machine-readable 401 codes', () => {
  let tmpDir: string;
  let jwtApp: Application;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-jwt-renew-'));
    const deviceTokenService = new DeviceTokenService(new LocalSecretStore({ dataDir: tmpDir }));
    jwtApp = express();
    jwtApp.use(express.json());
    // Mirror server.ts: the SAME middleware guards both mounts.
    const jwtMiddleware = createJwtAuthMiddleware(deviceTokenService);
    jwtApp.use('/api', jwtMiddleware);
    jwtApp.use('/auth', jwtMiddleware);
    jwtApp.post('/api/e2e/renew', (_req, res) => res.status(200).json({ renewReached: true }));
    jwtApp.get('/api/chats', (_req, res) => res.status(200).json({ reached: true }));
    jwtApp.post('/api/e2e/handshake', (_req, res) => res.status(200).json({ reached: true }));
    jwtApp.post('/api/e2e/renewX', (_req, res) => res.status(200).json({ reached: true }));
    jwtApp.get('/api/health', (_req, res) => res.status(200).json({ reached: true }));
    jwtApp.get('/api/healthcheck', (_req, res) => res.status(200).json({ reached: true }));
    jwtApp.get('/auth/github/callback', (_req, res) => res.status(200).json({ reached: true }));
    jwtApp.get('/auth/github-app/check-existing', (_req, res) =>
      res.status(200).json({ reached: true })
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lets a POST /api/e2e/renew through with NO Authorization header', async () => {
    const res = await request(jwtApp).post('/api/e2e/renew').send({});
    expect(res.status).toBe(200);
    expect(res.body.renewReached).toBe(true);
  });

  it('still hard-401s a protected route with NO Authorization (the bypass is renew-only)', async () => {
    const res = await request(jwtApp).get('/api/chats');
    expect(res.status).toBe(401);
    // Missing-token 401 deliberately carries no code.
    expect(res.body.code).toBeUndefined();
  });

  it("answers 401 code 'token_expired' for an EXPIRED Bearer on a protected route", async () => {
    const expired = generateAuthToken(
      { userId: 'pc_local_user', username: 'localhost', email: 'local@host' },
      // Module-captured default secret — a live process.env read diverges under full-suite runs.
      undefined,
      { expiresIn: '-10s' }
    );
    const res = await request(jwtApp).get('/api/chats').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_expired');
  });

  it("answers 401 code 'token_invalid' for a garbage Bearer", async () => {
    const res = await request(jwtApp).get('/api/chats').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_invalid');
  });

  it("answers 401 code 'token_invalid' for a tampered 2-part device token", async () => {
    const res = await request(jwtApp)
      .get('/api/chats')
      .set('Authorization', 'Bearer dGFtcGVyZWQ.ZGVhZGJlZWY');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_invalid');
  });

  it('keeps the public surface reachable with NO Authorization (boundary matches)', async () => {
    const publicProbes = [
      request(jwtApp).post('/api/e2e/handshake').send({}),
      request(jwtApp).get('/api/health'),
      request(jwtApp).get('/api/healthcheck'),
      request(jwtApp).get('/auth/github/callback'),
    ];
    for (const probe of publicProbes) {
      const res = await probe;
      expect(res.status).toBe(200);
      expect(res.body.reached).toBe(true);
    }
  });

  it("does NOT treat '/api/e2e/renewX' as public (no prefix bleed past the boundary)", async () => {
    const res = await request(jwtApp).post('/api/e2e/renewX').send({});
    expect(res.status).toBe(401);
  });

  it("does NOT treat '/auth/github-app/…' as public ('/auth/github' stops at the boundary)", async () => {
    const res = await request(jwtApp).get('/auth/github-app/check-existing');
    expect(res.status).toBe(401);
  });
});
