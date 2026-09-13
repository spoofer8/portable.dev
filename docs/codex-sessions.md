# Codex session support

## Scope

This fork adds Codex as a first-class local agent provider while preserving the existing Claude behavior and hosted relay protocol. The first supported host platform is macOS.

The product contract is:

- show Claude and Codex sessions in one directory with visible provider identity;
- discover every primary session whose working directory is under `~/projects`;
- discover new sessions from filesystem events, with startup and periodic reconciliation as recovery paths;
- start, resume, stream, interrupt, approve, fork, and archive Codex sessions;
- use the local Codex CLI configuration and credentials, including custom model providers;
- prevent two clients from writing to the same externally active session;
- keep Codex state databases and rollout files read-only;
- preserve compatibility with older Portable mobile clients by making new wire fields optional and retaining the existing event names.

Wake-on-LAN is intentionally deferred until the session integration has been tested on a device.

## Provider model

Chats retain the existing `type` field for compatibility. A separate `provider` field identifies `claude` or `codex`; an absent provider is interpreted as `claude`.

External Codex chat identifiers use `codex:<thread-id>` so a native Codex UUID cannot collide with a legacy Claude transcript identifier. A provider is immutable after a chat is created.

The built-in Codex presets mirror the operator's current CLI aliases without invoking an interactive shell:

- `supersol`: `gpt-5.6-sol`, ultra reasoning, and `cliproxy`;
- `superastra`: `gpt-6-astra`, ultra reasoning, and `cliproxy`.

New Codex chats default to approval prompts and workspace-write isolation. Full filesystem access
is used only after the user explicitly selects Portable's bypass-permissions mode.

Additional presets can be supplied through configuration. Credentials and provider environment variables are inherited by the local Codex process and are never sent through Portable's relay.

The Codex child receives a strict environment allowlist rather than Portable's complete process
environment. Extra provider-specific keys can be named with `PORTABLE_CODEX_ENV_ALLOWLIST`;
Portable authentication, relay, GitHub, and Anthropic secrets remain blocked.

## Discovery

Claude and Codex discovery are independent provider adapters behind one coordinator.

The coordinator performs an awaited startup scan, listens to provider source roots for changes, coalesces bursts, serializes scans, and runs a periodic reconciliation. A change received during a scan schedules one follow-up scan. Scan failure or cancellation retains the last complete catalog.

The Codex discovery adapter reads the local SQLite catalog and rollout files through a bounded, read-only path. Runtime mutations use the app-server protocol. Discovery filters canonical working directories to `~/projects` and never relies on `session_index.jsonl`, which is not a complete catalog.

File watches are hints rather than truth. The watched Codex sources include the sessions tree, the state database and its WAL, and the session index. Claude watches its project transcript root. Reconciliation repairs dropped or coalesced filesystem events.

Rollout reads are bounded to avoid loading unbounded command output into memory, and every path is
realpath-checked beneath Codex's session roots before and after opening.

Chat history uses a larger 64 MiB bound than discovery. If byte, record, or message limits are
exceeded, Portable shows an explicit "Earlier history omitted" block rather than silently
presenting an incomplete transcript.

## Runtime

One supervised `codex app-server --stdio` process serves Portable-owned Codex sessions. Portable completes the initialize handshake before issuing requests, tolerates unknown notifications, correlates server requests by JSON-RPC id, and restarts after transport failure.

The runtime uses `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/interrupt`, and `thread/archive`. Notifications are normalized into Portable's existing message block and `claude:*` event contract so the hosted relay remains unchanged.

A Codex writer lock owned by another process means the thread is externally active. Portable forks by default rather than creating a second writer. Stop-and-adopt is allowed only after positive evidence that the external writer exited.

## Data migration

The local chats table gains additive provider and source metadata columns. Existing rows are backfilled as Claude and remain behaviorally unchanged. Migration is idempotent and preserves existing chat and message data.

Discovered source stores are never modified. Archive and other mutations use official provider commands. Tests use synthetic fixtures; real local histories may be read for smoke verification but their content is never printed or committed.

## Verification

Required checks for this fork are:

- shared, API, launcher, and mobile typechecks;
- focused provider, discovery, migration, execution, socket, and mobile tests;
- full package test suites, with upstream baseline failures reported separately;
- Expo export for the custom iOS client;
- live read-only Claude and Codex discovery smoke tests;
- a disposable Codex thread start, streamed response, interrupt or completion, resume, and archive smoke test.
