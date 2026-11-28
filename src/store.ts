import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StoreCorruptError, StoreLockedError } from './errors.ts';
import type {
  AttestationRecord,
  EntryRecord,
  ExecutionIntentRecord,
  ProofRecord,
  TicketRecord,
} from './types.ts';

export interface StoreOptions {
  directory: string;
  /** When false, skip the single-owner lock (used by read-only tools). */
  acquireOwnerLock?: boolean;
  /**
   * Testing aid: hard-exit the process immediately before the (n+1)-th
   * atomic write, after n writes have been fsynced. This reproduces a crash
   * at an exact persistence boundary without touching production paths.
   */
  faultAfterWrites?: number;
  logger?: (line: string) => void;
}

const OWNER_FILE = 'OWNER.json';
const KEY_DIR = 'keys';
const TMP_DIR = 'tmp';
const PROOF_DIR = 'proofs';

interface OwnerRecord {
  pid: number;
  hostname: string;
  startedAt: string;
  nonce: string;
}

/**
 * Durable, crash-safe local state.
 *
 * Every mutation goes through {@link writeJsonAtomic}: write a temp file in
 * the store's `tmp/`, fsync it, rename it over the target, fsync the target
 * directory. A crash leaves either the old file or the new file, never a
 * truncated one. Temporary files from an interrupted write are ignored and
 * can be swept with {@link sweepTmp}.
 */
export class TicketStore {
  readonly directory: string;
  readonly owner: OwnerRecord | null;
  private readonly logger: (line: string) => void;
  private readonly faultAfterWrites: number | null;
  private writes = 0;

  constructor(options: StoreOptions) {
    if (!options?.directory) throw new StoreCorruptError('<none>', 'store directory is required');
    this.directory = options.directory;
    this.logger = options.logger ?? (() => {});
    this.faultAfterWrites = options.faultAfterWrites ?? null;
    mkdirSync(this.directory, { recursive: true });
    mkdirSync(join(this.directory, KEY_DIR), { recursive: true });
    mkdirSync(join(this.directory, TMP_DIR), { recursive: true });
    mkdirSync(join(this.directory, PROOF_DIR), { recursive: true });

    this.owner = options.acquireOwnerLock === false ? null : this.acquireOwnerLock();
  }

  // ---------------------------------------------------------------------
  // Single-owner lock
  // ---------------------------------------------------------------------

  private acquireOwnerLock(): OwnerRecord {
    const path = join(this.directory, OWNER_FILE);
    const owner: OwnerRecord = {
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      nonce: randomBytes(8).toString('hex'),
    };
    try {
      // `wx` is atomic: exactly one manager creates the owner file.
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, `${JSON.stringify(owner, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.fsyncDirectory(this.directory);
      return owner;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = this.readOwner(path);
      if (existing && this.isLiveOwner(existing)) {
        throw new StoreLockedError(
          this.directory,
          `${existing.hostname}:${existing.pid} since ${existing.startedAt}`,
        );
      }
      this.logger(`store: taking over stale owner record (${existing?.hostname ?? '?'}:${existing?.pid ?? '?'})`);
      this.writeJsonAtomic(path, owner);
      return owner;
    }
  }

  private readOwner(path: string): OwnerRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as OwnerRecord;
      if (typeof parsed?.pid !== 'number' || typeof parsed?.hostname !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private isLiveOwner(record: OwnerRecord): boolean {
    // A foreign hostname means a shared directory: honour the lock.
    if (record.hostname !== hostname()) return true;
    if (record.pid === process.pid) return true;
    try {
      process.kill(record.pid, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
      // EPERM etc.: process exists but cannot be signalled.
      return true;
    }
  }

  close(): void {
    if (!this.owner) return;
    const path = join(this.directory, OWNER_FILE);
    try {
      const current = this.readOwner(path);
      if (current && current.nonce === this.owner.nonce && current.pid === this.owner.pid) {
        unlinkSync(path);
        this.fsyncDirectory(this.directory);
      }
    } catch {
      // Best effort; a leftover owner file is treated as stale unless its pid
      // is alive, so a failed unlink is recoverable on the next start.
    }
  }

  // ---------------------------------------------------------------------
  // Paths
  // ---------------------------------------------------------------------

  private keyDir(keyHash: string): string {
    return join(this.directory, KEY_DIR, keyHash);
  }

  entryPath(keyHash: string): string {
    return join(this.keyDir(keyHash), 'entry.json');
  }

  ticketPath(keyHash: string, ticketId: string): string {
    return join(this.keyDir(keyHash), 'tickets', `${ticketId}.json`);
  }

  intentPath(keyHash: string, ticketId: string): string {
    return join(this.keyDir(keyHash), 'intents', `${ticketId}.json`);
  }

  /** The first-attestation binding for a ticket (single, overwrite-proof). */
  attestationPath(keyHash: string, ticketId: string): string {
    return join(this.keyDir(keyHash), 'attestations', `${ticketId}.json`);
  }

  /** Proof records are global so a proof id cannot be reused for another key. */
  proofPath(proofIdHash: string): string {
    return join(this.directory, PROOF_DIR, `${proofIdHash}.json`);
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  readEntry(keyHash: string): EntryRecord | null {
    return this.readJson<EntryRecord>(this.entryPath(keyHash));
  }

  readTicket(keyHash: string, ticketId: string): TicketRecord | null {
    return this.readJson<TicketRecord>(this.ticketPath(keyHash, ticketId));
  }

  readIntent(keyHash: string, ticketId: string): ExecutionIntentRecord | null {
    return this.readJson<ExecutionIntentRecord>(this.intentPath(keyHash, ticketId));
  }

  readAttestation(keyHash: string, ticketId: string): AttestationRecord | null {
    return this.readJson<AttestationRecord>(this.attestationPath(keyHash, ticketId));
  }

  readProof(proofIdHash: string): ProofRecord | null {
    return this.readJson<ProofRecord>(this.proofPath(proofIdHash));
  }

  private readJson<T>(path: string): T | null {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new StoreCorruptError(path, (err as Error).message);
    }
  }

  listKeyHashes(): string[] {
    const dir = join(this.directory, KEY_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  listTicketIds(keyHash: string): string[] {
    const dir = join(this.keyDir(keyHash), 'tickets');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .sort();
  }

  listIntentTicketIds(keyHash: string): string[] {
    const dir = join(this.keyDir(keyHash), 'intents');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .sort();
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  writeEntry(entry: EntryRecord): void {
    this.ensureKeyLayout(entry.keyHash);
    this.writeJsonAtomic(this.entryPath(entry.keyHash), entry);
  }

  writeTicket(ticket: TicketRecord): void {
    this.ensureKeyLayout(ticket.keyHash);
    this.writeJsonAtomic(this.ticketPath(ticket.keyHash, ticket.ticketId), ticket);
  }

  writeIntent(intent: ExecutionIntentRecord): void {
    this.ensureKeyLayout(intent.keyHash);
    this.writeJsonAtomic(this.intentPath(intent.keyHash, intent.ticketId), intent);
  }

  writeAttestation(record: AttestationRecord): void {
    this.ensureKeyLayout(record.keyHash);
    this.writeJsonAtomic(this.attestationPath(record.keyHash, record.ticketId), record);
  }

  writeProof(proof: ProofRecord): void {
    this.writeJsonAtomic(this.proofPath(proof.proofIdHash), proof);
  }

  deleteIntent(keyHash: string, ticketId: string): void {
    const path = this.intentPath(keyHash, ticketId);
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    this.fsyncDirectory(join(this.keyDir(keyHash), 'intents'));
  }

  private ensureKeyLayout(keyHash: string): void {
    const base = this.keyDir(keyHash);
    if (!existsSync(base)) {
      mkdirSync(base, { recursive: true });
      this.fsyncDirectory(join(this.directory, KEY_DIR));
    }
    for (const sub of ['tickets', 'intents', 'attestations']) {
      const dir = join(base, sub);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        this.fsyncDirectory(base);
      }
    }
  }

  /** Atomic JSON write with file + directory fsync. */
  writeJsonAtomic(path: string, value: unknown): void {
    if (this.faultAfterWrites !== null && this.writes >= this.faultAfterWrites) {
      // Simulated hard crash at an exact persistence boundary. `_exit` skips
      // flush/finalizers/cleanup handlers, exactly like SIGKILL.
      this.logger(`fault injection: exiting before write #${this.writes + 1} (${path})`);
      process.stderr.write(`fault-injection: crash before write #${this.writes + 1}\n`);
      process.exit(87);
    }
    this.writes += 1;
    const dir = join(path, '..');
    const tmpName = join(this.directory, TMP_DIR, `${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    const fd = openSync(tmpName, 'w');
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmpName, path);
    } catch (err) {
      try {
        unlinkSync(tmpName);
      } catch {
        /* ignore */
      }
      throw err;
    }
    this.fsyncDirectory(dir);
  }

  fsyncDirectory(dir: string): void {
    let fd: number | null = null;
    try {
      fd = openSync(dir, 'r');
      fsyncSync(fd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') {
        this.logger(`store: directory fsync failed for ${dir}: ${(err as Error).message}`);
      }
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Deletes temp files left behind by a crash during a write. */
  sweepTmp(): string[] {
    const dir = join(this.directory, TMP_DIR);
    if (!existsSync(dir)) return [];
    const removed: string[] = [];
    for (const name of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, name));
        removed.push(name);
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  /** Removes the whole state directory. Intended for tests/tools. */
  destroy(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
