import { existsSync, watch, type FSWatcher } from 'fs';
import path from 'path';

import type {
  DiscoveredChat,
  WorkspaceRepo,
} from '../../db/ClaudeProjects/ClaudeProjectsChatIndex.js';
import type { DiscoveredCodexChat } from '../../db/CodexProjects/CodexProjectsChatIndex.js';

export interface SessionCatalog {
  claude: DiscoveredChat[];
  codex: DiscoveredCodexChat[];
}

export interface SessionDiscoveryCoordinatorOptions {
  reposProvider: () => Promise<WorkspaceRepo[]>;
  scanClaude: (repos: WorkspaceRepo[]) => Promise<DiscoveredChat[]>;
  scanCodex: (repos: WorkspaceRepo[]) => Promise<DiscoveredCodexChat[]>;
  watchPaths?: string[];
  onCatalogChange?: (catalog: SessionCatalog) => void | Promise<void>;
  reconcileIntervalMs?: number;
  debounceMs?: number;
  watchFactory?: (path: string, listener: () => void) => FSWatcher;
}

function catalogKey(catalog: SessionCatalog): string {
  const rows = [
    ...catalog.claude.map((chat) => [
      'claude',
      chat.sessionId,
      chat.lastUpdated,
      chat.messageCount,
      chat.title,
    ]),
    ...catalog.codex.map((chat) => [
      'codex',
      chat.threadId,
      chat.lastUpdated,
      chat.messageCount,
      chat.title,
      chat.archived,
      chat.pinned,
    ]),
  ];
  return JSON.stringify(rows.sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
}

export class SessionDiscoveryCoordinator {
  private catalog: SessionCatalog = { claude: [], codex: [] };
  private catalogFingerprint = catalogKey(this.catalog);
  private watchers = new Map<string, FSWatcher>();
  private timer?: ReturnType<typeof setInterval>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private activeScan?: Promise<void>;
  private dirty = true;
  private stopped = true;

  constructor(private readonly options: SessionDiscoveryCoordinatorOptions) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.reconcile();
    const intervalMs = this.options.reconcileIntervalMs ?? 30_000;
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.reconcile(), intervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  markDirty(): void {
    this.dirty = true;
    if (this.stopped || this.activeScan || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.reconcile();
    }, this.options.debounceMs ?? 500);
    this.debounceTimer.unref?.();
  }

  async getCatalog(): Promise<SessionCatalog> {
    // Reconcile on reads as well as from watch hints. This closes the race where a
    // caller lists sessions before macOS has delivered the filesystem event.
    this.dirty = true;
    await this.reconcile();
    return { claude: [...this.catalog.claude], codex: [...this.catalog.codex] };
  }

  async reconcile(): Promise<void> {
    this.dirty = true;
    if (this.activeScan) return this.activeScan;
    this.activeScan = this.runReconciliation();
    try {
      await this.activeScan;
    } finally {
      this.activeScan = undefined;
      // Close the tiny hand-off window between the loop's final dirty check and
      // clearing activeScan. A watcher hint there must still schedule a new pass.
      if (this.dirty && !this.stopped) void this.reconcile();
    }
  }

  private async runReconciliation(): Promise<void> {
    do {
      this.dirty = false;
      let repos: WorkspaceRepo[];
      try {
        repos = await this.options.reposProvider();
      } catch {
        repos = [];
      }
      const [claude, codex] = await Promise.all([
        this.options.scanClaude(repos).catch(() => this.catalog.claude),
        this.options.scanCodex(repos).catch(() => this.catalog.codex),
      ]);
      const next = { claude, codex };
      const fingerprint = catalogKey(next);
      this.catalog = next;
      if (fingerprint !== this.catalogFingerprint) {
        this.catalogFingerprint = fingerprint;
        try {
          await this.options.onCatalogChange?.({ claude: [...claude], codex: [...codex] });
        } catch {
          // A notification failure must not stop discovery.
        }
      }
      this.refreshWatchers();
    } while (this.dirty && !this.stopped);
  }

  private nearestExistingPath(watchPath: string): string | null {
    let candidate = path.resolve(watchPath);
    while (!existsSync(candidate)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
    return candidate;
  }

  private refreshWatchers(): void {
    if (this.stopped) return;
    const makeWatcher =
      this.options.watchFactory ??
      ((watchPath: string, listener: () => void) =>
        watch(watchPath, { recursive: true }, listener));
    const targets = new Set(
      (this.options.watchPaths ?? [])
        .map((watchPath) => this.nearestExistingPath(watchPath))
        .filter((watchPath): watchPath is string => watchPath !== null)
    );
    if (
      targets.size === this.watchers.size &&
      [...targets].every((watchPath) => this.watchers.has(watchPath))
    ) {
      return;
    }
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const watchPath of targets) {
      try {
        const watcher = makeWatcher(watchPath, () => this.markDirty());
        watcher.on('error', () => {
          this.watchers.delete(watchPath);
          this.markDirty();
        });
        this.watchers.set(watchPath, watcher);
      } catch {
        // The nearest existing parent may disappear; polling retries from its new parent.
      }
    }
  }
}
