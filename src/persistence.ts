/**
 * File-backed durable storage for one Raft node.
 *
 * Persisted state (per Raft §5.1):
 *   currentTerm, votedFor  → state.json
 *   log[]                  → log.json
 *
 * Volatile state that must survive a *process* restart together with the
 * applied state machine snapshot (so committed entries are never applied
 * twice):
 *   commitIndex, lastApplied, appliedState → snapshot.json
 *
 * All writes use a temp-file + rename and fsync the parent directory where
 * possible, giving atomic, crash-safe replacement on the local filesystem.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, NodeId, RaftConfig } from './types.ts';
export interface PersistedState {
  currentTerm: number;
  votedFor: NodeId | null;
}

export interface SnapshotData<S> {
  commitIndex: number;
  lastApplied: number;
  appliedState: S;
}

const STATE_FILE = 'state.json';
const LOG_FILE = 'log.json';
const SNAPSHOT_FILE = 'snapshot.json';

export class PersistentStore<S> {
  private readonly dir: string;
  private state: PersistedState;
  private log: LogEntry[];
  private snapshot: SnapshotData<S> | null;
  private readonly initialStateFn: () => S;
  private readonly bootstrapConfig: RaftConfig;

  constructor(
    dataDir: string,
    initialStateFn: () => S,
    bootstrapConfig: RaftConfig,
  ) {
    this.dir = dataDir;
    this.initialStateFn = initialStateFn;
    this.bootstrapConfig = bootstrapConfig;
    mkdirSync(dataDir, { recursive: true });

    this.state = this.readOr(STATE_FILE, { currentTerm: 0, votedFor: null });
    this.log = this.readOr<LogEntry[]>(LOG_FILE, []);
    if (this.log.length === 0) {
      // Synthesise the index-0 sentinel carrying the bootstrap configuration.
      this.log = [{ term: 0, index: 0, command: null, config: this.bootstrapConfig }];
      this.flushLog();
    }
    this.snapshot = existsSync(join(dataDir, SNAPSHOT_FILE))
      ? (readJson(join(dataDir, SNAPSHOT_FILE)) as SnapshotData<S>)
      : null;
  }

  private readOr<T>(file: string, fallback: T): T {
    const path = join(this.dir, file);
    if (!existsSync(path)) return fallback;
    return readJson(path) as T;
  }

  private atomicWrite(file: string, data: unknown): void {
    const finalPath = join(this.dir, file);
    const tmpPath = join(this.dir, `.${file}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(data));
    renameSync(tmpPath, finalPath);
  }

  private flushState(): void {
    this.atomicWrite(STATE_FILE, this.state);
  }

  private flushLog(): void {
    this.atomicWrite(LOG_FILE, this.log);
  }

  /* -------------------------------------------------------------- */
  /* Persistent state                                               */
  /* -------------------------------------------------------------- */

  get currentTerm(): number {
    return this.state.currentTerm;
  }

  get votedFor(): NodeId | null {
    return this.state.votedFor;
  }

  /** Persist a term change, clearing the vote (Raft: term and vote are written together). */
  saveTerm(term: number): void {
    this.state = { currentTerm: term, votedFor: null };
    this.flushState();
  }

  saveVote(term: number, candidateId: NodeId): void {
    this.state = { currentTerm: term, votedFor: candidateId };
    this.flushState();
  }

  /* -------------------------------------------------------------- */
  /* Log                                                            */
  /* -------------------------------------------------------------- */

  getLog(): readonly LogEntry[] {
    return this.log;
  }

  entryAt(index: number): LogEntry | undefined {
    return this.log.find((e) => e.index === index);
  }

  lastEntry(): LogEntry {
    return this.log[this.log.length - 1];
  }

  lastIndex(): number {
    return this.log[this.log.length - 1].index;
  }

  lastTerm(): number {
    return this.log[this.log.length - 1].term;
  }

  /**
   * Append entries starting at `startIndex`, truncating any conflicting suffix.
   * `startIndex` may be one past the current last index (a pure extension) and
   * must be greater than the sentinel index 0.
   */
  appendEntries(startIndex: number, entries: LogEntry[]): void {
    if (entries.length === 0) return;
    if (startIndex <= 0) {
      throw new Error(`appendEntries: cannot overwrite the sentinel (startIndex ${startIndex})`);
    }
    const existingOffset = this.log.findIndex((e) => e.index === startIndex);
    if (existingOffset < 0) {
      // Pure extension: the entry immediately preceding the batch must exist.
      if (this.lastIndex() !== startIndex - 1) {
        throw new Error(
          `appendEntries: gap at index ${startIndex}, stored last index is ${this.lastIndex()}`,
        );
      }
      this.log = [...this.log, ...entries];
      this.flushLog();
      return;
    }
    // Overlap: truncate at the first conflicting entry (different term/config).
    let cut = existingOffset;
    for (const incoming of entries) {
      const existing = this.log[cut];
      if (existing && existing.index === incoming.index) {
        if (existing.term !== incoming.term || !sameConfig(existing.config, incoming.config)) {
          this.log = this.log.slice(0, cut);
          break;
        }
        cut += 1;
      } else {
        this.log = this.log.slice(0, cut);
        break;
      }
    }
    const keep = entries.filter((e) => e.index > this.lastIndex());
    this.log = [...this.log, ...keep];
    this.flushLog();
  }

  /* -------------------------------------------------------------- */
  /* Volatile snapshot (commit / applied state)                     */
  /* -------------------------------------------------------------- */

  loadSnapshot(): SnapshotData<S> {
    if (this.snapshot) return this.snapshot;
    return {
      commitIndex: 0,
      lastApplied: 0,
      appliedState: this.initialStateFn(),
    };
  }

  saveSnapshot(data: SnapshotData<S>): void {
    this.snapshot = data;
    this.atomicWrite(SNAPSHOT_FILE, data);
  }

  /** Remove every durable file — used by tests that want a truly fresh node. */
  reset(): void {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function sameConfig(a: RaftConfig | undefined, b: RaftConfig | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
