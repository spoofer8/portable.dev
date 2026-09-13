import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

import { buildCodexProcessEnv } from './processEnv.js';

import type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';

export interface CodexTransportHandlers {
  onLine(line: string): void;
  onStderr(line: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  onError(error: Error): void;
}

export interface CodexProcessTransport {
  start(handlers: CodexTransportHandlers): void | Promise<void>;
  write(line: string): void;
  stop(): void | Promise<void>;
}

export interface CodexProcessOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  extraEnvAllowlist?: string[];
}

export type SpawnCodexProcess = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
  }
) => ChildProcessWithoutNullStreams;

export class StdioCodexTransport implements CodexProcessTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: ReadlineInterface | null = null;
  private stderrLines: ReadlineInterface | null = null;

  constructor(
    private readonly options: CodexProcessOptions = {},
    private readonly spawnProcess: SpawnCodexProcess = (command, args, spawnOptions) =>
      spawn(command, args, spawnOptions)
  ) {}

  start(handlers: CodexTransportHandlers): void {
    if (this.child) throw new Error('Codex transport is already running');

    const child = this.spawnProcess(
      this.options.command ?? 'codex',
      this.options.args ?? ['app-server'],
      {
        cwd: this.options.cwd,
        env: buildCodexProcessEnv(this.options.env ?? process.env, this.options.extraEnvAllowlist),
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    this.child = child;
    this.stdoutLines = createInterface({ input: child.stdout });
    this.stderrLines = createInterface({ input: child.stderr });
    this.stdoutLines.on('line', handlers.onLine);
    this.stderrLines.on('line', handlers.onStderr);
    child.stdin.once('error', handlers.onError);
    child.once('error', handlers.onError);
    child.once('exit', handlers.onExit);
  }

  write(line: string): void {
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error('Codex app-server transport is not running');
    }
    this.child.stdin.write(`${line}\n`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.stdoutLines?.close();
    this.stderrLines?.close();
    this.stdoutLines = null;
    this.stderrLines = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    child.stdin.end();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish();
      }, 2_000);
      forceTimer.unref?.();
      child.once('exit', finish);
      if (!child.kill('SIGTERM')) finish();
    });
  }
}

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerClientOptions extends CodexProcessOptions {
  transportFactory?: () => CodexProcessTransport;
  requestTimeoutMs?: number;
  clientInfo?: { name: string; title: string; version: string };
  experimentalApi?: boolean;
  onNotification?: (notification: JsonRpcNotification) => void;
  onServerRequest?: (request: JsonRpcRequest, generation: number) => void;
  onStderr?: (line: string) => void;
  onProtocolError?: (error: Error) => void;
  onExit?: (error: Error) => void;
}

const DEFAULT_CLIENT_INFO = { name: 'portable', title: 'Portable', version: '3.5.4' };

export class CodexAppServerClient {
  private transport: CodexProcessTransport | null = null;
  private initialization: Promise<unknown> | null = null;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private stopping = false;
  private generation = 0;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  async initialize(): Promise<unknown> {
    if (this.initialized && this.initialization) return this.initialization;
    if (this.initialization) return this.initialization;

    this.initialization = this.openAndInitialize();
    try {
      return await this.initialization;
    } catch (error) {
      this.initialization = null;
      throw error;
    }
  }

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!this.initialized) await this.initialize();
    return this.sendRequest<T>(method, params);
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.initialized || !this.transport) {
      throw new Error('Codex app-server is not initialized');
    }
    this.send({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (!this.initialized || !this.transport) {
      throw new Error('Codex app-server is not initialized');
    }
    this.send({ id, result });
  }

  respondWithError(id: JsonRpcId, error: JsonRpcError): void {
    if (!this.initialized || !this.transport) {
      throw new Error('Codex app-server is not initialized');
    }
    this.send({ id, error });
  }

  async restart(): Promise<unknown> {
    await this.closeCurrent(new Error('Codex app-server restarted'));
    return this.initialize();
  }

  async shutdown(): Promise<void> {
    await this.closeCurrent(new Error('Codex app-server shut down'));
  }

  getGeneration(): number {
    return this.generation;
  }

  private async openAndInitialize(): Promise<unknown> {
    const transport = this.options.transportFactory
      ? this.options.transportFactory()
      : new StdioCodexTransport(this.options);
    this.transport = transport;
    this.stopping = false;
    const generation = ++this.generation;

    try {
      await transport.start({
        onLine: (line) => this.handleLine(transport, generation, line),
        onStderr: (line) => this.options.onStderr?.(line),
        onExit: (code, signal) =>
          this.handleTransportFailure(
            transport,
            generation,
            new Error(
              `Codex app-server exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`
            )
          ),
        onError: (error) => this.handleTransportFailure(transport, generation, error),
      });

      const result = await this.sendRequest('initialize', {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: { experimentalApi: this.options.experimentalApi ?? false },
      });
      this.send({ method: 'initialized', params: {} });
      this.initialized = true;
      return result;
    } catch (error) {
      if (this.transport === transport) {
        this.transport = null;
        this.initialized = false;
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
        await transport.stop();
      }
      throw error;
    }
  }

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 30_000);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: object): void {
    if (!this.transport) throw new Error('Codex app-server transport is not running');
    this.transport.write(JSON.stringify(message));
  }

  private handleLine(transport: CodexProcessTransport, generation: number, line: string): void {
    if (transport !== this.transport) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.onProtocolError?.(new Error('Codex app-server sent malformed JSON'));
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.options.onProtocolError?.(new Error('Codex app-server sent an invalid message'));
      return;
    }
    const message = parsed as Record<string, unknown>;

    if ('id' in message && !('method' in message)) {
      this.handleResponse(message as unknown as JsonRpcResponse);
      return;
    }
    if (typeof message.method !== 'string') {
      this.options.onProtocolError?.(new Error('Codex app-server sent an invalid message'));
      return;
    }
    if ('id' in message) {
      this.options.onServerRequest?.(message as unknown as JsonRpcRequest, generation);
      return;
    }
    this.options.onNotification?.(message as unknown as JsonRpcNotification);
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(
        new CodexRpcError(response.error.message, response.error.code, response.error.data)
      );
      return;
    }
    pending.resolve(response.result);
  }

  private handleTransportFailure(
    transport: CodexProcessTransport,
    generation: number,
    error: Error
  ): void {
    if (transport !== this.transport || generation !== this.generation) return;
    this.transport = null;
    this.initialized = false;
    this.initialization = null;
    this.rejectPending(error);
    void Promise.resolve(transport.stop()).catch(() => undefined);
    if (!this.stopping) this.options.onExit?.(error);
  }

  private async closeCurrent(reason: Error): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.initialized = false;
    this.initialization = null;
    this.stopping = true;
    this.rejectPending(reason);
    try {
      await transport?.stop();
    } finally {
      this.stopping = false;
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
