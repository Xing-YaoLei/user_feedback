import { CursorExpiredError } from './types.ts';
import { Registry, WatchHandle } from './registry.ts';
import type {
  Instance,
  RebuildBasis,
  WatchMessage,
} from './types.ts';

export interface ClientOptions {
  prefix?: string;
  pageSize?: number;
  /** Max watch messages drained per {@link DiscoveryClient.pumpWatch} call. */
  pumpBatchSize?: number;
}

export interface PageTrace {
  pageNumber: number;
  baselineRevision: number;
  count: number;
  keys: string[];
  tokenReused: boolean;
}

export type TraceEntry =
  | { kind: 'page'; page: PageTrace }
  | { kind: 'snapshot'; baselineRevision: number; instanceCount: number }
  | { kind: 'watch-started'; startRevision: number; prefix: string }
  | {
      kind: 'watch-rebuild';
      reason: RebuildBasis['reason'];
      basis: RebuildBasis;
      baselineRevision: number;
      resumeAfterRevision: number;
      watchStartRevision: number;
    }
  | { kind: 'batch'; revision: number; puts: string[]; deletes: string[] }
  | { kind: 'progress'; progress: number }
  | { kind: 'rebuild-basis'; reason: RebuildBasis['reason']; basis: RebuildBasis };

/**
 * Caller-side adapter: full paged snapshot followed by a revision-based
 * incremental watch, with explicit rebuild on every expired-cursor signal.
 */
export class DiscoveryClient {
  readonly #registry: Registry;
  readonly #prefix: string;
  readonly #pageSize: number;
  readonly #pumpBatchSize: number;
  readonly #directory = new Map<string, Instance>();
  #watch: WatchHandle | null = null;
  #syncedRevision = 0;
  #trace: TraceEntry[] = [];
  #rebuildCount = 0;

  constructor(registry: Registry, options: ClientOptions = {}) {
    this.#registry = registry;
    this.#prefix = options.prefix ?? '';
    this.#pageSize = options.pageSize ?? 100;
    this.#pumpBatchSize = options.pumpBatchSize ?? 64;
  }

  get trace(): readonly TraceEntry[] {
    return this.#trace;
  }

  get syncedRevision(): number {
    return this.#syncedRevision;
  }

  get rebuildCount(): number {
    return this.#rebuildCount;
  }

  get watchId(): number | null {
    return this.#watch ? this.#watch.id : null;
  }

  get watchProgress(): number {
    return this.#watch ? this.#watch.progress : this.#syncedRevision;
  }

  /** Local materialized directory. */
  getInstance(key: string): Instance | undefined {
    return this.#directory.get(key);
  }

  listInstances(): Instance[] {
    return [...this.#directory.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Immutable snapshot of the local directory keyed by instance key. */
  snapshot(): Map<string, Instance> {
    return new Map(this.#directory);
  }

  /** Bootstrap: read the full paged snapshot, then start the watch after it. */
  start(): void {
    this.resync(null);
  }

  /**
   * Re-read a complete snapshot and start a fresh watch strictly after the
   * snapshot revision. `basis` is recorded when the rebuild was forced by an
   * expired pagination cursor / stalled watch.
   */
  resync(basis: RebuildBasis | null): {
    baselineRevision: number;
    resumeAfterRevision: number;
    pages: PageTrace[];
  } {
    const pages: PageTrace[] = [];
    this.#directory.clear();

    let pageToken: string | undefined;
    let baselineRevision = -1;
    let pageNumber = 0;
    do {
      const page = this.#registry.list({
        prefix: this.#prefix,
        pageSize: this.#pageSize,
        pageToken,
      });
      pageNumber += 1;
      if (baselineRevision === -1) baselineRevision = page.revision;
      // Every page must belong to the same immutable snapshot.
      if (page.revision !== baselineRevision) {
        throw new Error('snapshot revision changed across pages');
      }
      for (const instance of page.instances) this.#directory.set(instance.key, instance);
      pages.push({
        pageNumber,
        baselineRevision: page.revision,
        count: page.instances.length,
        keys: page.instances.map((i) => i.key),
        tokenReused: pageNumber > 1,
      });
      this.#trace.push({
        kind: 'page',
        page: {
          pageNumber,
          baselineRevision: page.revision,
          count: page.instances.length,
          keys: page.instances.map((i) => i.key),
          tokenReused: pageNumber > 1,
        },
      });
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);

    const resumeAfterRevision = baselineRevision;
    this.#syncedRevision = baselineRevision;
    this.#watch?.close();
    this.#watch = this.#registry.watch({
      prefix: this.#prefix,
      startRevision: resumeAfterRevision + 1,
    });
    this.#trace.push({
      kind: 'snapshot',
      baselineRevision,
      instanceCount: this.#directory.size,
    });
    this.#trace.push({
      kind: 'watch-started',
      startRevision: resumeAfterRevision + 1,
      prefix: this.#prefix,
    });
    if (basis) {
      this.#rebuildCount += 1;
      this.#trace.push({
        kind: 'watch-rebuild',
        reason: basis.reason,
        basis,
        baselineRevision,
        resumeAfterRevision,
        watchStartRevision: resumeAfterRevision + 1,
      });
    }
    return { baselineRevision, resumeAfterRevision, pages };
  }

  /**
   * Drain watch messages once. Returns the number of messages handled.
   * A stalled watch triggers exactly one full rebuild in this call.
   */
  pumpWatch(): number {
    if (!this.#watch) throw new Error('client has not been started');
    let messages: WatchMessage[];
    try {
      messages = this.#watch.consume(this.#pumpBatchSize);
    } catch (error) {
      if (error instanceof CursorExpiredError) {
        this.#trace.push({
          kind: 'rebuild-basis',
          reason: error.reason,
          basis: error.rebuildBasis,
        });
        this.resync(error.rebuildBasis);
        return 0;
      }
      throw error;
    }
    for (const message of messages) {
      if (message.type === 'progress') {
        // Heartbeats are only synthesized when no change is buffered, so this
        // confirms every revision up to the registry head at consume time.
        this.#syncedRevision = Math.max(this.#syncedRevision, message.progress);
        this.#trace.push({ kind: 'progress', progress: message.progress });
        continue;
      }
      const puts: string[] = [];
      const deletes: string[] = [];
      for (const event of message.events) {
        if (event.kind === 'put' && event.instance) {
          this.#directory.set(event.key, event.instance);
          puts.push(event.key);
        } else if (event.kind === 'delete') {
          this.#directory.delete(event.key);
          deletes.push(event.key);
        }
      }
      this.#syncedRevision = message.revision;
      this.#trace.push({ kind: 'batch', revision: message.revision, puts, deletes });
    }
    return messages.length;
  }

  /** Renew the watch liveness window; returns the current progress. */
  keepalive(): number {
    if (!this.#watch) throw new Error('client has not been started');
    return this.#watch.keepalive();
  }

  close(): void {
    this.#watch?.close();
    this.#watch = null;
  }
}
