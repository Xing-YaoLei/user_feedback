import type {
  ChangeListener,
  ChangeNotification,
  LogAdapter,
  LogRecord,
  PartitionSnapshot,
  Unsubscribe,
} from '../types.ts';

interface PartitionLog {
  /** Trimmable bottom offset: records below this are no longer retained. */
  startOffset: number;
  /** Offset just past the last appended record. */
  nextOffset: number;
  /** Retained records; `records[0]` has offset `startOffset`. */
  records: LogRecord[];
  /** `nextOffset` after each commit that touched this partition. */
  trail: { revision: number; offset: number }[];
}

interface ChangeEvent {
  revision: number;
  partitions: string[];
}

interface Subscriber {
  listener: ChangeListener;
  /** Highest revision already delivered to this subscriber. */
  deliveredUpTo: number;
}

export interface InMemoryLogAdapterOptions {
  /**
   * Runs while a subscription is being established: after the adapter has
   * recorded the subscription but before it delivers any replay. Tests use
   * this to append inside the decide-then-subscribe window.
   */
  onSubscribe?: (adapter: InMemoryLogAdapter, sinceRevision: number | undefined) => void;
  /** Runs after a revision is committed and before subscribers are notified. */
  onAppend?: (adapter: InMemoryLogAdapter, revision: number, partitions: string[]) => void;
  /**
   * Runs at the start of every `snapshot` call, after the pinned revision has
   * been validated. Tests use this to append while a pack is being built, to
   * prove the pack stays pinned to the revision it started at.
   */
  onSnapshot?: (adapter: InMemoryLogAdapter, partition: string, revision: number) => void;
}

/**
 * In-memory {@link LogAdapter} used for local verification.
 *
 * Every commit is exactly one revision. A batch commit that appends to
 * several partitions publishes one notification naming all of them, so the
 * snapshots pinned at that revision are consistent across partitions.
 * Subscribers registered with `sinceRevision` receive a replay of every
 * commit after it: this models an adapter that cannot lose changes in the
 * decide-then-subscribe window.
 */
export class InMemoryLogAdapter implements LogAdapter {
  #partitions = new Map<string, PartitionLog>();
  #changes: ChangeEvent[] = [];
  #revision = 0;
  #subscribers = new Set<Subscriber>();
  #options: InMemoryLogAdapterOptions;
  #trimmedRecords = 0;

  constructor(partitionNames: readonly string[] = [], options: InMemoryLogAdapterOptions = {}) {
    for (const name of partitionNames) this.createPartition(name);
    this.#options = options;
  }

  /** Add a partition that did not exist at construction time. */
  createPartition(name: string): void {
    if (this.#partitions.has(name)) throw new Error(`partition already exists: ${name}`);
    this.#partitions.set(name, { startOffset: 0, nextOffset: 0, records: [], trail: [] });
  }

  partitions(): readonly string[] {
    return [...this.#partitions.keys()];
  }

  snapshotRevision(): number {
    return this.#revision;
  }

  /** Append one record to one partition and commit one revision. */
  append(partition: string, value: unknown, bytes?: number): number {
    return this.appendBatch([{ partition, value, bytes }]);
  }

  /**
   * Append several records and publish them as a single revision.
   *
   * Within a batch, per-partition order follows the batch entry order. A
   * batch with no entries still commits a revision, with no notification.
   */
  appendBatch(entries: readonly { partition: string; value: unknown; bytes?: number }[]): number {
    const touched: string[] = [];
    const touchedLogs: PartitionLog[] = [];
    for (const entry of entries) {
      const log = this.#partitions.get(entry.partition);
      if (log === undefined) throw new Error(`unknown partition: ${entry.partition}`);
      const bytes = entry.bytes ?? byteSize(entry.value);
      log.records.push({ bytes, value: entry.value });
      log.nextOffset += 1;
      if (!touched.includes(entry.partition)) {
        touched.push(entry.partition);
        touchedLogs.push(log);
      }
    }
    this.#revision += 1;
    for (const log of touchedLogs) log.trail.push({ revision: this.#revision, offset: log.nextOffset });
    this.#changes.push({ revision: this.#revision, partitions: touched });
    this.#options.onAppend?.(this, this.#revision, [...touched]);
    if (touched.length > 0) {
      this.#deliver({ revision: this.#revision, partitions: [...touched] });
    }
    return this.#revision;
  }

  /**
   * Drop the oldest retained records of a partition, moving `startOffset`
   * forward. A read asking for a trimmed offset resumes at the new bottom.
   */
  trim(partition: string, newStartOffset: number): void {
    const log = this.#partitions.get(partition);
    if (log === undefined) throw new Error(`unknown partition: ${partition}`);
    const clamped = Math.max(log.startOffset, Math.min(newStartOffset, log.nextOffset));
    const drop = clamped - log.startOffset;
    if (drop <= 0) return;
    log.records.splice(0, drop);
    log.startOffset = clamped;
    this.#trimmedRecords += drop;
  }

  get trimmedRecords(): number {
    return this.#trimmedRecords;
  }

  /** Current retained offsets for one partition. */
  offsets(partition: string): { startOffset: number; nextOffset: number } {
    const log = this.#partitions.get(partition);
    if (log === undefined) throw new Error(`unknown partition: ${partition}`);
    return { startOffset: log.startOffset, nextOffset: log.nextOffset };
  }

  /** Retained payloads of one partition, for assertions. */
  values(partition: string): unknown[] {
    const log = this.#partitions.get(partition);
    if (log === undefined) throw new Error(`unknown partition: ${partition}`);
    return log.records.map((record) => record.value);
  }

  snapshot(partition: string, revision?: number): PartitionSnapshot {
    const log = this.#partitions.get(partition);
    if (log === undefined) throw new Error(`unknown partition: ${partition}`);
    const at = revision ?? this.#revision;
    if (!Number.isInteger(at) || at < 0) throw new RangeError(`invalid revision: ${at}`);
    if (at > this.#revision) {
      throw new RangeError(`revision ${at} is in the future (current ${this.#revision})`);
    }
    this.#options.onSnapshot?.(this, partition, at);
    const pinnedNext = this.#nextOffsetAt(log, at);
    const nextOffset = Math.max(log.startOffset, pinnedNext);
    return {
      partition,
      startOffset: log.startOffset,
      nextOffset,
      revision: at,
      records: log.records.slice(0, nextOffset - log.startOffset),
    };
  }

  subscribe(listener: ChangeListener, sinceRevision?: number): Unsubscribe {
    const subscriber: Subscriber = {
      listener,
      deliveredUpTo: sinceRevision ?? -1,
    };
    this.#subscribers.add(subscriber);

    // Replay from the recorded baseline *after* registration, so an append
    // that happens during subscription setup is seen either as replay (its
    // revision is newer than the baseline) or as a live notification.
    this.#options.onSubscribe?.(this, sinceRevision);

    for (const event of this.#changes) {
      if (event.revision <= subscriber.deliveredUpTo) continue;
      if (!this.#subscribers.has(subscriber)) break;
      this.#deliverOne(subscriber, event);
    }

    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  byteLength(record: LogRecord): number {
    return record.bytes;
  }

  /** Number of live subscribers, for leak assertions in tests. */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** Every committed change event so far (copy), for assertions. */
  get changeLog(): readonly ChangeEvent[] {
    return this.#changes.map((event) => ({ revision: event.revision, partitions: [...event.partitions] }));
  }

  #nextOffsetAt(log: PartitionLog, revision: number): number {
    const trail = log.trail;
    if (trail.length === 0 || trail[0].revision > revision) return log.startOffset;
    let low = 0;
    let high = trail.length - 1;
    let best = log.startOffset;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (trail[mid].revision <= revision) {
        best = trail[mid].offset;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  #deliver(notification: ChangeNotification): void {
    for (const subscriber of [...this.#subscribers]) {
      if (!this.#subscribers.has(subscriber)) continue;
      if (notification.revision <= subscriber.deliveredUpTo) continue;
      this.#deliverOne(subscriber, notification);
    }
  }

  #deliverOne(subscriber: Subscriber, event: ChangeEvent): void {
    // An empty-partition commit advances the revision without a change worth
    // reporting, but the subscriber has still seen up to it.
    subscriber.deliveredUpTo = Math.max(subscriber.deliveredUpTo, event.revision);
    if (event.partitions.length === 0) return;
    subscriber.listener({ revision: event.revision, partitions: [...event.partitions] });
  }
}

function byteSize(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  const json = JSON.stringify(value);
  return Buffer.byteLength(json ?? '', 'utf8');
}
