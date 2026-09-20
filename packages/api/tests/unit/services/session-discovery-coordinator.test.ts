import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import { SessionDiscoveryCoordinator } from '../../../src/services/session-discovery/SessionDiscoveryCoordinator';

describe('SessionDiscoveryCoordinator', () => {
  it('rescans when a filesystem hint arrives during an active scan', async () => {
    let releaseFirstScan!: () => void;
    const firstScan = new Promise<void>((resolve) => {
      releaseFirstScan = resolve;
    });
    let scans = 0;
    const changes: number[] = [];
    const coordinator = new SessionDiscoveryCoordinator({
      reposProvider: async () => [],
      scanClaude: async () => {
        scans++;
        if (scans === 1) await firstScan;
        return [];
      },
      scanCodex: async () => [],
      reconcileIntervalMs: 0,
      onCatalogChange: (catalog) => changes.push(catalog.claude.length + catalog.codex.length),
    });

    const starting = coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    coordinator.markDirty();
    releaseFirstScan();
    await starting;

    expect(scans).toBe(2);
    expect(changes).toEqual([]);
    coordinator.stop();
  });

  it('notifies only when the catalog identity changes', async () => {
    let version = 0;
    let notifications = 0;
    const coordinator = new SessionDiscoveryCoordinator({
      reposProvider: async () => [],
      scanClaude: async () =>
        version === 0
          ? []
          : [
              {
                sessionId: 'new',
                repoPath: '/tmp/repo',
                cwd: '/tmp/repo',
                repoFullName: 'repo',
                title: 'New',
                lastUpdated: 1,
                messageCount: 1,
                firstMessageData: {},
                lastMessageData: {},
              },
            ],
      scanCodex: async () => [],
      reconcileIntervalMs: 0,
      onCatalogChange: () => notifications++,
    });

    await coordinator.start();
    await coordinator.getCatalog();
    expect(notifications).toBe(0);
    version = 1;
    const catalog = await coordinator.getCatalog();
    expect(catalog.claude).toHaveLength(1);
    expect(notifications).toBe(1);
    await coordinator.getCatalog();
    expect(notifications).toBe(1);
    coordinator.stop();
  });

  it('notifies when a Codex writer changes the discovered session status', async () => {
    let status: 'completed' | 'running' = 'completed';
    const notifications: string[] = [];
    const coordinator = new SessionDiscoveryCoordinator({
      reposProvider: async () => [],
      scanClaude: async () => [],
      scanCodex: async () => [
        {
          id: 'codex:thread-1',
          threadId: 'thread-1',
          repoPath: '/tmp/repo',
          cwd: '/tmp/repo',
          repoFullName: 'me/repo',
          rolloutPath: '/tmp/thread-1.jsonl',
          title: 'Codex thread',
          lastUpdated: 1,
          createdAt: 1,
          messageCount: 1,
          firstMessageData: {},
          lastMessageData: {},
          archived: false,
          pinned: false,
          model: 'gpt-5',
          source: 'cli',
          status,
        },
      ],
      reconcileIntervalMs: 0,
      onCatalogChange: (catalog) => notifications.push(catalog.codex[0].status),
    });

    await coordinator.start();
    expect(notifications).toEqual(['completed']);

    status = 'running';
    await coordinator.getCatalog();
    expect(notifications).toEqual(['completed', 'running']);

    status = 'completed';
    await coordinator.getCatalog();
    expect(notifications).toEqual(['completed', 'running', 'completed']);
    coordinator.stop();
  });

  it('watches an existing parent and upgrades when a missing discovery root appears', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-watch-'));
    const desired = path.join(root, 'missing', 'sessions');
    const watched: string[] = [];
    const listeners = new Map<string, () => void>();
    const coordinator = new SessionDiscoveryCoordinator({
      reposProvider: async () => [],
      scanClaude: async () => [],
      scanCodex: async () => [],
      reconcileIntervalMs: 0,
      debounceMs: 0,
      watchPaths: [desired],
      watchFactory: (watchPath, listener) => {
        watched.push(watchPath);
        listeners.set(watchPath, listener);
        const watcher = new EventEmitter() as any;
        watcher.close = () => undefined;
        return watcher;
      },
    });

    try {
      await coordinator.start();
      expect(watched).toEqual([root]);
      await fs.mkdir(desired, { recursive: true });
      listeners.get(root)!();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(watched).toContain(desired);
    } finally {
      coordinator.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
