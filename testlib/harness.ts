import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { GatewayClient, type Endpoint } from '../src/client.ts';
import type { ReconciliationProof, TicketView } from '../src/types.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');
export { REPO_ROOT };
export const SERVER_ENTRY = join(REPO_ROOT, 'src', 'main.ts');
export const ADAPTER_ENTRY = join(REPO_ROOT, 'adapters', 'local-effect-adapter.ts');
export const OPS_ENTRY = join(REPO_ROOT, 'src', 'ops.ts');

/** Every temp artefact lives under the workspace's own .tmp directory. */
export const TMP_ROOT = join(REPO_ROOT, '.tmp');

let counter = 0;
let processRoot: string | null = null;

/**
 * Per-test-process temp root. Test files run in parallel workers, so sharing
 * a single directory would let one file's cleanup delete another's state.
 */
function tempRoot(): string {
  if (!processRoot) {
    processRoot = join(TMP_ROOT, `proc-${process.pid}`);
    mkdirSync(processRoot, { recursive: true });
  }
  return processRoot;
}

export function makeTempDir(label: string): string {
  counter += 1;
  const dir = join(tempRoot(), `run-${counter}-${label}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Removes only this test process's temp data; shared root goes if empty. */
export function cleanupTmpRoot(): void {
  if (process.env.PRO117_KEEP_TMP) return;
  if (processRoot) rmSync(processRoot, { recursive: true, force: true });
  try {
    if (readdirSync(TMP_ROOT).length === 0) rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* root already gone or still in use by another worker */
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${options.label ?? 'condition'}`);
    }
    await sleep(intervalMs);
  }
}

export function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function countEffects(effectFile: string): number {
  return readJsonl(effectFile).length;
}

export function readTicketFile(stateDir: string, ticketId: string, keyHash: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(stateDir, 'keys', keyHash, 'tickets', `${ticketId}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

export function listTicketIdsOnDisk(stateDir: string, keyHash: string): string[] {
  const dir = join(stateDir, 'keys', keyHash, 'tickets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

export function listIntentIdsOnDisk(stateDir: string, keyHash: string): string[] {
  const dir = join(stateDir, 'keys', keyHash, 'intents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

export function listKeyHashesOnDisk(stateDir: string): string[] {
  const dir = join(stateDir, 'keys');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Mirrors src/util.ts#keyHashFor so tests can address files directly. */
export function keyHashOf(tenant: string, method: string, idempotencyKey: string): string {
  const h = createHash('sha256');
  h.update('pro117-idempotency-key-v1');
  for (const part of [tenant, method, idempotencyKey]) {
    const buf = Buffer.from(part, 'utf8');
    h.update(
      Buffer.from([buf.length >>> 24, (buf.length >>> 16) & 0xff, (buf.length >>> 8) & 0xff, buf.length & 0xff]),
    );
    h.update(buf);
  }
  return h.digest('hex');
}

export interface StartServerOptions {
  stateDir: string;
  workDir: string;
  effectFile: string;
  adapterConfig?: Record<string, unknown>;
  outcomeTtlMs?: number;
  transport?: 'tcp' | 'unix';
  /** Testing aid: crash before the (n+1)-th durable write in the manager. */
  faultAfterWrites?: number;
}

export interface ServerProc {
  child: ChildProcessWithoutNullStreams;
  endpointFile: string;
  endpoint: Endpoint;
  stateDir: string;
  workDir: string;
  effectFile: string;
  pid: number;
  logs: () => string;
  newClient: () => Promise<GatewayClient>;
  killHard: () => Promise<void>;
  /** Resolves with the manager's exit code once it has exited. */
  waitExit: () => Promise<number | null>;
  stop: () => Promise<void>;
}

function endpointFromFile(file: string): Endpoint {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    transport: string;
    host?: string;
    port?: number;
    path?: string;
  };
  return raw.transport === 'unix'
    ? { transport: 'unix', path: raw.path! }
    : { transport: 'tcp', host: raw.host!, port: raw.port! };
}

/**
 * Starts one manager process against real files. Each call owns its own
 * endpoint file, so a restart reuses the same state directory only.
 */
export async function startServer(options: StartServerOptions): Promise<ServerProc> {
  const transport = options.transport ?? 'tcp';
  const endpointFile = join(options.workDir, 'endpoint.json');
  // A stale endpoint file from a killed manager would be read as live.
  if (existsSync(endpointFile)) unlinkSync(endpointFile);

  const args = [
    SERVER_ENTRY,
    '--state',
    options.stateDir,
    '--adapter',
    ADAPTER_ENTRY,
    '--adapter-config',
    JSON.stringify({ effectFile: options.effectFile, ...(options.adapterConfig ?? {}) }),
    '--endpoint',
    endpointFile,
    '--transport',
    transport,
    '--work',
    options.workDir,
  ];
  if (options.outcomeTtlMs !== undefined) args.push('--outcome-ttl-ms', String(options.outcomeTtlMs));
  if (options.faultAfterWrites !== undefined) {
    args.push('--fault-after-writes', String(options.faultAfterWrites));
  }
  if (transport === 'unix') {
    // Unix socket paths are short on macOS (~104 bytes). Use a compact path
    // under the OS temp dir, tagged with the store directory's unique name so
    // parallel test workers cannot collide.
    const tag = createHash('sha256').update(resolve(options.stateDir)).digest('hex').slice(0, 12);
    const shortPath = join(tmpdir(), `pro117-${process.pid}-${tag}.sock`);
    args.push('--socket', shortPath);
  }

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let logs = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    logs += d;
  });
  child.stderr.on('data', (d: string) => {
    logs += d;
  });

  let exitCode: number | null = null;
  const exited = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code, signal) => {
      exitCode = code ?? (signal ? 128 : null);
      resolveExit(exitCode);
    });
  });

  await waitFor(
    () => {
      if (exitCode !== null) throw new Error(`manager exited early with code ${exitCode}\n${logs}`);
      return existsSync(endpointFile);
    },
    { timeoutMs: 20_000, label: 'manager endpoint file' },
  );
  const endpoint = endpointFromFile(endpointFile);

  const clients: GatewayClient[] = [];
  const proc: ServerProc = {
    child,
    endpointFile,
    endpoint,
    stateDir: options.stateDir,
    workDir: options.workDir,
    effectFile: options.effectFile,
    pid: child.pid!,
    logs: () => logs,
    newClient: async () => {
      const client = new GatewayClient({ endpoint, timeoutMs: 60_000 });
      await client.ping();
      clients.push(client);
      return client;
    },
    killHard: async () => {
      for (const c of clients) c.close();
      child.kill('SIGKILL');
      await exited;
    },
    waitExit: () => exited,
    stop: async () => {
      for (const c of clients) c.close();
      if (exitCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
  return proc;
}

/**
 * Waits until the state directory shows that the adapter has durably written
 * an effect for the given key, then returns. Used to kill the manager inside
 * the "effect happened, result not saved" window.
 */
export async function waitForEffect(effectFile: string, minCount = 1): Promise<void> {
  await waitFor(() => countEffects(effectFile) >= minCount, {
    label: `effect count >= ${minCount}`,
  });
}

export function ticketOf(keyViewTickets: TicketView[], status?: string): TicketView | undefined {
  return status ? keyViewTickets.find((t) => t.status === status) : keyViewTickets[0];
}

export type { GatewayClient, ReconciliationProof, TicketView };
