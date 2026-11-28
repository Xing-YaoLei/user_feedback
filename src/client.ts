import { connect, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { GatewayError, InvalidInputError } from './errors.ts';
import type {
  InvokeResult,
  KeyView,
  ReclaimExpiredResult,
  ReclaimResult,
  ReconciliationProof,
  TerminalOutcome,
  TicketView,
} from './types.ts';

export type Endpoint = { transport: 'tcp'; host: string; port: number } | { transport: 'unix'; path: string };

export interface ClientOptions {
  endpoint: Endpoint;
  token?: string;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
}

export interface WireErrorShape {
  name: string;
  code: string;
  message: string;
  details: unknown;
}

/** Raised for gateway-level rejections returned by the server. */
export class RemoteGatewayError extends GatewayError {
  constructor(shape: WireErrorShape) {
    super(
      (shape.code as GatewayError['code']) ?? 'INTERNAL',
      shape.message || 'remote gateway error',
      shape.details,
    );
    this.name = shape.name || 'RemoteGatewayError';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal NDJSON RPC client. One socket multiplexes independent requests by
 * id, so two concurrent `invoke` calls really are concurrent on the server.
 */
export class GatewayClient {
  private readonly options: ClientOptions;
  private socket: Socket | null = null;
  private connectPromise: Promise<Socket> | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  static fromFile(path: string, options: Omit<ClientOptions, 'endpoint'> = {}): GatewayClient {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    let endpoint: Endpoint;
    if (parsed.transport === 'unix' && typeof parsed.path === 'string') {
      endpoint = { transport: 'unix', path: parsed.path };
    } else if (parsed.transport === 'tcp' && typeof parsed.host === 'string' && typeof parsed.port === 'number') {
      endpoint = { transport: 'tcp', host: parsed.host, port: parsed.port };
    } else {
      throw new InvalidInputError(`endpoint file ${path} does not describe a tcp or unix endpoint`);
    }
    return new GatewayClient({ endpoint, ...options });
  }

  private async connect(): Promise<Socket> {
    if (this.closed) throw new GatewayError('INTERNAL', 'client is closed');
    if (this.connectPromise) return this.connectPromise;
    if (this.socket && !this.socket.destroyed) return this.socket;
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async openSocket(): Promise<Socket> {
    const socket =
      this.options.endpoint.transport === 'tcp'
        ? connect(this.options.endpoint.port, this.options.endpoint.host)
        : connect(this.options.endpoint.path);
    socket.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }).catch((err: Error) => {
      socket.destroy();
      throw new GatewayError('INTERNAL', `cannot connect to gateway: ${err.message}`);
    });
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const idx = this.buffer.indexOf('\n');
        if (idx === -1) break;
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line !== '') this.onLine(line);
      }
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.settlePending(new GatewayError('INTERNAL', 'gateway connection closed'));
    });
    socket.on('error', () => {
      /* surfaced via close */
    });
    this.socket = socket;
    return socket;
  }

  private settlePending(err: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id !== 'string') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message.ok === true) {
      entry.resolve(message.result);
    } else {
      entry.reject(new RemoteGatewayError((message.error ?? {}) as WireErrorShape));
    }
  }

  private async request(op: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const { id, promise } = await this.send(op, payload);
    void id;
    return promise;
  }

  private async send(
    op: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ id: string; promise: Promise<unknown> }> {
    const socket = await this.connect();
    const id = `r${this.nextId++}`;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const body = JSON.stringify({
      id,
      op,
      ...(this.options.token !== undefined ? { token: this.options.token } : {}),
      ...payload,
    });
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError('INTERNAL', `request ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${body}\n`, (err) => {
        if (!err) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(new GatewayError('INTERNAL', `write failed: ${err.message}`));
      });
    });
    return { id, promise };
  }

  async ping(): Promise<{ pong: boolean; pid: number }> {
    return (await this.request('ping')) as { pong: boolean; pid: number };
  }

  async invoke(input: {
    tenant: string;
    method: string;
    idempotencyKey: string;
    body: Uint8Array | string;
  }): Promise<InvokeResult> {
    const bytes = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body);
    return (await this.request('invoke', {
      tenant: input.tenant,
      method: input.method,
      idempotencyKey: input.idempotencyKey,
      bodyB64: bytes.toString('base64'),
    })) as InvokeResult;
  }

  /**
   * Starts an invoke without awaiting it and returns the wire request id plus
   * the pending result. `cancelWaiter(id)` aborts only this caller; the
   * shared execution and its ledger entry survive.
   */
  async startInvoke(input: {
    tenant: string;
    method: string;
    idempotencyKey: string;
    body: Uint8Array | string;
  }): Promise<{ requestId: string; result: Promise<InvokeResult> }> {
    const bytes = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body);
    const { id, promise } = await this.send('invoke', {
      tenant: input.tenant,
      method: input.method,
      idempotencyKey: input.idempotencyKey,
      bodyB64: bytes.toString('base64'),
    });
    return { requestId: id, result: promise as Promise<InvokeResult> };
  }

  /** Aborts one waiter by its wire request id (as returned by startInvoke). */
  async cancelWaiter(requestId: string): Promise<{ cancelled: boolean }> {
    return (await this.request('cancel', { target: requestId })) as { cancelled: boolean };
  }

  async reconcile(input: {
    ticketId: string;
    proof: ReconciliationProof;
    tenant?: string;
    method?: string;
    idempotencyKey?: string;
  }): Promise<TicketView> {
    return (await this.request('reconcile', {
      ticketId: input.ticketId,
      proof: input.proof,
      ...(input.tenant !== undefined ? { tenant: input.tenant } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    })) as TicketView;
  }

  async reclaim(ticketId: string, reason: 'ttl' | 'admin' = 'admin'): Promise<ReclaimResult> {
    return (await this.request('reclaim', { ticketId, reason })) as ReclaimResult;
  }

  async reclaimExpired(): Promise<ReclaimExpiredResult> {
    return (await this.request('reclaimExpired')) as ReclaimExpiredResult;
  }

  async inspect(identity: {
    tenant: string;
    method: string;
    idempotencyKey: string;
  }): Promise<KeyView | { absent: true }> {
    return (await this.request('inspect', identity)) as KeyView | { absent: true };
  }

  async tickets(): Promise<TicketView[]> {
    return (await this.request('tickets')) as TicketView[];
  }

  async status(): Promise<Record<string, unknown>> {
    return (await this.request('status')) as Record<string, unknown>;
  }

  async shutdown(): Promise<void> {
    try {
      await this.request('shutdown');
    } catch {
      /* connection may close before the reply lands */
    }
    this.close();
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
    this.settlePending(new GatewayError('INTERNAL', 'client closed'));
  }
}

export type { TerminalOutcome };
