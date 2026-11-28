import { createServer, type Server, type Socket } from 'node:net';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IdempotencyGateway } from './manager.ts';
import {
  GatewayError,
  InvalidInputError,
  asGatewayError,
} from './errors.ts';
import type { ExecutionAdapter, InvokeInput, ReconciliationProof } from './types.ts';

/**
 * Wire protocol (NDJSON, one JSON object per line).
 *
 * Request:  { "id": string, "op": Op, ...args }
 * Response: { "id": string, "ok": true, "result": unknown }
 *        or { "id": string, "ok": false, "error": { code, message, details } }
 *
 * Request bytes are carried as base64 so the digest is computed over the
 * exact caller bytes, never over a re-serialization.
 */
export type Op =
  | 'invoke'
  | 'reconcile'
  | 'reclaim'
  | 'reclaimExpired'
  | 'inspect'
  | 'tickets'
  | 'status'
  | 'ping'
  | 'cancel'
  | 'shutdown';

export interface AdapterFactoryContext {
  stateDirectory: string;
  workDirectory: string;
  config: Record<string, unknown>;
  logger: (line: string) => void;
}

export type AdapterFactory = (ctx: AdapterFactoryContext) =>
  | ExecutionAdapter
  | Promise<ExecutionAdapter>;

export interface ServerOptions {
  stateDirectory: string;
  adapter: ExecutionAdapter;
  /** Writes {transport, host, port|path} here so clients can connect. */
  endpointFile?: string;
  transport?: 'tcp' | 'unix';
  /** Unix socket path (transport 'unix'). */
  socketPath?: string;
  /** TCP port; 0 picks a free port (transport 'tcp'). */
  port?: number;
  host?: string;
  outcomeTtlMs?: number;
  /** Optional shared secret; when set, every request must carry it. */
  token?: string;
  workDirectory?: string;
  /** Testing aid: crash before the (n+1)-th durable write. */
  faultAfterWrites?: number;
  logger?: (line: string) => void;
}

export interface GatewayServer {
  readonly gateway: IdempotencyGateway;
  readonly endpoint: { transport: 'tcp'; host: string; port: number } | { transport: 'unix'; path: string };
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface WireRequest {
  id?: unknown;
  op?: unknown;
  token?: unknown;
  [key: string]: unknown;
}

export function createGatewayServer(options: ServerOptions): GatewayServer {
  const logger = options.logger ?? (() => {});
  const gateway = new IdempotencyGateway({
    stateDirectory: options.stateDirectory,
    adapter: options.adapter,
    outcomeTtlMs: options.outcomeTtlMs,
    faultAfterWrites: options.faultAfterWrites,
    logger,
  });

  const transport = options.transport ?? 'tcp';
  const host = options.host ?? '127.0.0.1';
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let endpoint: GatewayServer['endpoint'];
  let closing = false;
  // Waiter cancellation is per-request and per-connection: two clients may
  // legitimately use the same request id. Aborting one waiter never stops the
  // shared execution and never deletes the ledger entry.
  const waiters = new Map<Socket, Map<string, AbortController>>();

  const handle = async (req: WireRequest, signal: AbortSignal, socket: Socket): Promise<unknown> => {
    if (options.token !== undefined && req.token !== options.token) {
      throw new GatewayError('INTERNAL', 'unauthorized', { reason: 'bad-token' });
    }
    switch (req.op) {
      case 'ping':
        return { pong: true, pid: process.pid };
      case 'status':
        return {
          pid: process.pid,
          startedAt: gateway.startupReport?.recoveredAt ?? null,
          startupReport: gateway.startupReport,
          stateDirectory: options.stateDirectory,
          ticketCount: gateway.listTickets().length,
        };
      case 'invoke': {
        const input: InvokeInput = {
          tenant: requireString(req.tenant, 'tenant'),
          method: requireString(req.method, 'method'),
          idempotencyKey: requireString(req.idempotencyKey, 'idempotencyKey'),
          body: decodeBody(req),
          signal,
        };
        return gateway.invoke(input);
      }
      case 'reconcile':
        return gateway.reconcile({
          ticketId: requireString(req.ticketId, 'ticketId'),
          proof: requireObject(req.proof, 'proof') as unknown as ReconciliationProof,
          tenant: optionalString(req.tenant, 'tenant'),
          method: optionalString(req.method, 'method'),
          idempotencyKey: optionalString(req.idempotencyKey, 'idempotencyKey'),
        });
      case 'reclaim':
        return gateway.reclaim(requireString(req.ticketId, 'ticketId'), {
          reason: req.reason === 'ttl' ? 'ttl' : 'admin',
        });
      case 'reclaimExpired':
        return gateway.reclaimExpired();
      case 'inspect': {
        const view = gateway.inspectKey({
          tenant: requireString(req.tenant, 'tenant'),
          method: requireString(req.method, 'method'),
          idempotencyKey: requireString(req.idempotencyKey, 'idempotencyKey'),
        });
        return view ?? { absent: true };
      }
      case 'tickets':
        return gateway.listTickets();
      case 'cancel': {
        const target = requireString(req.target, 'target');
        const controller = waiters.get(socket)?.get(target);
        if (!controller) return { cancelled: false };
        controller.abort();
        return { cancelled: true };
      }
      case 'shutdown':
        setImmediate(() => {
          void close().then(() => process.exit(0));
        });
        return { closing: true };
      default:
        throw new InvalidInputError(`unknown op ${String(req.op)}`);
    }
  };

  const onConnection = (socket: Socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // Process every complete line independently so two requests can be in
      // flight concurrently on one connection.
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line === '') continue;
        void dispatchLine(socket, line);
      }
    });
    socket.on('error', (err) => logger(`connection error: ${err.message}`));
    socket.on('close', () => {
      sockets.delete(socket);
      // Closing a connection cancels only that connection's waiters.
      const owned = waiters.get(socket);
      if (owned) {
        for (const controller of owned.values()) controller.abort();
        waiters.delete(socket);
      }
    });
  };

  const neverAborted = (): AbortSignal => NEVER_ABORTED.signal;
  const NEVER_ABORTED = new AbortController();

  const dispatchLine = async (socket: Socket, line: string) => {
    let request: WireRequest;
    try {
      request = JSON.parse(line) as WireRequest;
    } catch (err) {
      writeLine(socket, {
        id: null,
        ok: false,
        error: { code: 'INVALID_INPUT', message: `malformed JSON: ${(err as Error).message}`, details: null },
      });
      return;
    }
    const id = request.id ?? null;
    const isInvoke = request.op === 'invoke';
    const controller = isInvoke ? new AbortController() : null;
    if (isInvoke && typeof id === 'string') {
      const owned = waiters.get(socket) ?? new Map<string, AbortController>();
      owned.set(id, controller!);
      waiters.set(socket, owned);
    }
    try {
      const result = await handle(request, controller?.signal ?? neverAborted(), socket);
      writeLine(socket, { id, ok: true, result });
    } catch (err) {
      const gatewayError = asGatewayError(err);
      writeLine(socket, { id, ok: false, error: gatewayError.toJSON() });
    } finally {
      if (isInvoke && typeof id === 'string') {
        const owned = waiters.get(socket);
        if (owned) {
          owned.delete(id);
          if (owned.size === 0) waiters.delete(socket);
        }
      }
    }
  };

  const writeLine = (socket: Socket, payload: unknown) => {
    if (socket.destroyed || !socket.writable) return;
    socket.write(`${JSON.stringify(payload)}\n`);
  };

  const listen = async (): Promise<void> => {
    if (transport === 'unix') {
      const socketPath = resolve(options.socketPath ?? `${options.stateDirectory}/gateway.sock`);
      assertUnixSocketPathFits(socketPath);
      prepareUnixSocket(socketPath);
      server = createServer(onConnection);
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server!.once('error', rejectPromise);
        server!.listen(socketPath, () => {
          server!.off('error', rejectPromise);
          resolvePromise();
        });
      });
      endpoint = { transport: 'unix', path: socketPath };
    } else {
      server = createServer(onConnection);
      const port = options.port ?? 0;
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server!.once('error', rejectPromise);
        server!.listen(port, host, () => {
          server!.off('error', rejectPromise);
          resolvePromise();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new GatewayError('INTERNAL', 'failed to bind TCP port');
      endpoint = { transport: 'tcp', host, port: address.port };
    }

    if (options.endpointFile) {
      const file = resolve(options.endpointFile);
      mkdirSync(dirname(file), { recursive: true });
      // The endpoint file is advisory: clients may also be told the endpoint
      // directly. Write + rename + fsync so a reader never sees half a file.
      const tmp = `${file}.${process.pid}.tmp`;
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, `${JSON.stringify({ ...endpoint, pid: process.pid }, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    }
    logger(`gateway listening on ${JSON.stringify(endpoint)}`);
  };

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await new Promise<void>((resolvePromise) => {
      if (!server) return resolvePromise();
      server.close(() => resolvePromise());
    });
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    gateway.close();
    if (endpoint?.transport === 'unix' && existsSync(endpoint.path)) {
      try {
        unlinkSync(endpoint.path);
      } catch {
        /* ignore */
      }
    }
    if (options.endpointFile && existsSync(options.endpointFile)) {
      try {
        unlinkSync(options.endpointFile);
      } catch {
        /* ignore */
      }
    }
  };

  return {
    gateway,
    get endpoint() {
      if (!endpoint) throw new GatewayError('INTERNAL', 'server is not listening yet');
      return endpoint;
    },
    listen,
    close,
  };
}

/** Unix socket paths are limited to ~104 bytes on macOS and ~108 on Linux. */
const MAX_UNIX_SOCKET_PATH = 100;

function assertUnixSocketPathFits(path: string): void {
  if (Buffer.byteLength(path, 'utf8') > MAX_UNIX_SOCKET_PATH) {
    throw new GatewayError(
      'INVALID_INPUT',
      `unix socket path is too long (${Buffer.byteLength(path, 'utf8')} bytes, max ${MAX_UNIX_SOCKET_PATH}); pass a shorter --socket path`,
      { path },
    );
  }
}

function prepareUnixSocket(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return; // nothing there
  }
  // Only a leftover *socket* is safe to remove. Anything else at that path is
  // a misconfiguration and must not be silently deleted.
  if (!stats.isSocket()) {
    throw new GatewayError('INVALID_INPUT', `refusing to replace non-socket path ${path}`);
  }
  // A live manager holds the store's owner lock, so the gateway constructor
  // has already refused to start in that case; a socket here is stale.
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidInputError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function decodeBody(req: WireRequest): Uint8Array {
  if (typeof req.bodyB64 === 'string') {
    return new Uint8Array(Buffer.from(req.bodyB64, 'base64'));
  }
  if (typeof req.body === 'string') return new TextEncoder().encode(req.body);
  throw new InvalidInputError('invoke requires bodyB64 (base64) or body (string)');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  state: string;
  adapter: string;
  adapterConfig: Record<string, unknown>;
  endpointFile?: string;
  transport: 'tcp' | 'unix';
  socketPath?: string;
  port: number;
  host: string;
  outcomeTtlMs?: number;
  token?: string;
  workDirectory: string;
  faultAfterWrites?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new InvalidInputError(`unexpected argument ${arg}`);
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      values.set(key, 'true');
      continue;
    }
    values.set(key, next);
    i += 1;
  }
  const state = values.get('state');
  if (!state) throw new InvalidInputError('--state <directory> is required');
  const adapter = values.get('adapter');
  if (!adapter) throw new InvalidInputError('--adapter <module> is required');
  const transport = (values.get('transport') ?? 'tcp') as 'tcp' | 'unix';
  if (transport !== 'tcp' && transport !== 'unix') {
    throw new InvalidInputError("--transport must be 'tcp' or 'unix'");
  }
  const configRaw = values.get('adapter-config');
  let adapterConfig: Record<string, unknown> = {};
  if (configRaw) {
    try {
      adapterConfig = JSON.parse(configRaw) as Record<string, unknown>;
    } catch (err) {
      throw new InvalidInputError(`--adapter-config must be JSON: ${(err as Error).message}`);
    }
  }
  const ttlRaw = values.get('outcome-ttl-ms');
  const faultRaw = values.get('fault-after-writes');
  return {
    state: resolve(state),
    adapter,
    adapterConfig,
    endpointFile: values.get('endpoint') ? resolve(values.get('endpoint')!) : undefined,
    transport,
    socketPath: values.get('socket') ? resolve(values.get('socket')!) : undefined,
    port: values.get('port') ? Number(values.get('port')) : 0,
    host: values.get('host') ?? '127.0.0.1',
    outcomeTtlMs: ttlRaw !== undefined ? Number(ttlRaw) : undefined,
    token: values.get('token'),
    workDirectory: resolve(values.get('work') ?? process.cwd()),
    faultAfterWrites: faultRaw !== undefined ? Number(faultRaw) : undefined,
  };
}

export async function loadAdapterFactory(
  modulePath: string,
  ctx: AdapterFactoryContext,
): Promise<ExecutionAdapter> {
  const url = pathToFileURL(resolve(modulePath)).href;
  const mod = (await import(url)) as {
    createAdapter?: AdapterFactory;
    adapter?: ExecutionAdapter;
    default?: AdapterFactory | ExecutionAdapter;
  };
  let candidate: ExecutionAdapter | undefined;
  if (typeof mod.createAdapter === 'function') {
    candidate = await mod.createAdapter(ctx);
  } else if (mod.default && typeof (mod.default as AdapterFactory) === 'function') {
    candidate = await (mod.default as AdapterFactory)(ctx);
  } else if (mod.adapter) {
    candidate = mod.adapter;
  } else if (mod.default && typeof (mod.default as ExecutionAdapter).execute === 'function') {
    candidate = mod.default as ExecutionAdapter;
  }
  if (!candidate || typeof candidate.execute !== 'function') {
    throw new InvalidInputError(
      `adapter module ${modulePath} must export createAdapter(ctx), adapter, or a default factory`,
    );
  }
  return candidate;
}

export async function runServerCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const logger = (line: string) => process.stderr.write(`[gateway ${process.pid}] ${line}\n`);
  const adapter = await loadAdapterFactory(args.adapter, {
    stateDirectory: args.state,
    workDirectory: args.workDirectory,
    config: args.adapterConfig,
    logger,
  });
  const server = createGatewayServer({
    stateDirectory: args.state,
    adapter,
    endpointFile: args.endpointFile,
    transport: args.transport,
    socketPath: args.socketPath,
    port: args.port,
    host: args.host,
    outcomeTtlMs: args.outcomeTtlMs,
    token: args.token,
    workDirectory: args.workDirectory,
    faultAfterWrites: args.faultAfterWrites,
    logger,
  });
  await server.listen();

  const shutdown = (signal: string) => {
    logger(`received ${signal}, closing`);
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
