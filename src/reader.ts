import type {
  ChangeNotification,
  LogAdapter,
  LogRecord,
  PackStopReason,
  ReadPartitionResult,
  ReadRequest,
  ReadResult,
  ReadStatus,
  Unsubscribe,
} from './types.ts';

/** A parked read registered on the shared adapter subscription. */
interface Waiter {
  readonly partitions: ReadonlySet<string>;
  /** Called when a change touches at least one partition of interest. */
  notify(): void;
}

/** Per-partition state of one packing attempt pinned at one revision. */
interface PackState {
  partition: string;
  requestedStart: number;
  snapshotStart: number;
  records: readonly LogRecord[];
  /** Next offset to inspect. */
  cursor: number;
  /** Offset at which this partition stops offering records for this pack. */
  end: number;
  packed: LogRecord[];
  bytes: number;
}

/** One consistent snapshot round and the pack built from it. */
interface Pack {
  revision: number;
  partitions: ReadPartitionResult[];
  bytes: number;
  recordCount: number;
  stopReason: PackStopReason;
}

type WaitOutcome = 'changed' | 'timeout' | 'cancelled';

/**
 * One adapter subscription shared by every parked read on a reader.
 *
 * Parked reads are reference-counted as a set: settling one read only detaches
 * the adapter subscription when it was the last interested one, so cancelling,
 * timing out, or completing one read never tears down another read's wake-ups.
 * Wake-ups are filtered per parked read by partition interest.
 */
class NotificationHub {
  #adapter: LogAdapter;
  #waiters = new Set<Waiter>();
  /** Revision the current subscription replays changes after. */
  #since: number | null = null;
  #unsubscribe: Unsubscribe | null = null;

  constructor(adapter: LogAdapter) {
    this.#adapter = adapter;
  }

  get subscribed(): boolean {
    return this.#unsubscribe !== null;
  }

  get waiterCount(): number {
    return this.#waiters.size;
  }

  /**
   * Register a waiter whose last consistent snapshot was taken at
   * `sinceRevision`. The adapter replays every change after that revision,
   * including ones that landed before this call returned, so an append in the
   * window between "not enough data" and "parked" cannot be lost.
   *
   * The waiter joins the set *before* subscribing, so a synchronous replay
   * reaches it like any other waiter.
   */
  add(waiter: Waiter, sinceRevision: number): void {
    this.#waiters.add(waiter);

    const existing = this.#unsubscribe;
    if (existing !== null && sinceRevision < this.#since!) {
      // This waiter's snapshot predates the shared baseline. Re-subscribe from
      // this waiter's revision *before* dropping the old subscription, so a
      // failing subscribe can never strand the waiters already parked.
      try {
        this.#unsubscribe = this.#adapter.subscribe(this.#onChange, sinceRevision);
      } catch (error) {
        this.#waiters.delete(waiter);
        throw error;
      }
      this.#since = sinceRevision;
      existing();
    } else if (existing === null) {
      try {
        this.#unsubscribe = this.#adapter.subscribe(this.#onChange, sinceRevision);
      } catch (error) {
        // A failing subscription must not leave a phantom waiter behind.
        this.#waiters.delete(waiter);
        throw error;
      }
      this.#since = sinceRevision;
    }

    // A change after this waiter's snapshot may have been delivered while the
    // waiter was not yet in the set (or by a replay). Asking it to re-check is
    // safe and cheap: it either finds the new data or parks again at the newer
    // revision.
    if (this.#adapter.snapshotRevision() > sinceRevision) waiter.notify();
  }

  /**
   * Detach a waiter. The subscription is withdrawn exactly when the last
   * waiter leaves, so a settled read never removes a subscription that
   * another parked read still needs.
   */
  remove(waiter: Waiter): void {
    if (!this.#waiters.delete(waiter)) return;
    if (this.#waiters.size > 0) return;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#since = null;
  }

  #onChange = (notification: ChangeNotification): void => {
    for (const waiter of this.#waiters) {
      let relevant = false;
      for (const partition of notification.partitions) {
        if (waiter.partitions.has(partition)) {
          relevant = true;
          break;
        }
      }
      if (!relevant) continue;
      try {
        waiter.notify();
      } catch {
        // One waiter must never break notification delivery for the others.
      }
    }
  };
}

/**
 * Long-polling reader over a {@link LogAdapter}.
 *
 * One instance serves any number of concurrent reads. They share a single
 * adapter subscription, created lazily the first time a read has to park and
 * withdrawn as soon as the last parked read settles.
 */
export class LongPollReader {
  #adapter: LogAdapter;
  #hub: NotificationHub;

  constructor(adapter: LogAdapter) {
    this.#adapter = adapter;
    this.#hub = new NotificationHub(adapter);
  }

  /** Number of adapter subscriptions currently open (0 or 1). */
  get activeSubscriptions(): number {
    return this.#hub.subscribed ? 1 : 0;
  }

  /** Number of reads currently parked on the shared subscription. */
  get pendingReads(): number {
    return this.#hub.waiterCount;
  }

  /**
   * Perform one long-poll read. The returned promise settles exactly once.
   *
   * The pack is built from consistent snapshots pinned at a single revision
   * (reported as `result.revision`). Records appended after that revision are
   * deliberately left for the next read, which resumes from each partition's
   * `nextOffset`.
   */
  read(request: ReadRequest): Promise<ReadResult> {
    validateRequest(request);
    return this.#run(request);
  }

  async #run(request: ReadRequest): Promise<ReadResult> {
    const adapter = this.#adapter;
    const deadline = Date.now() + request.waitMs;
    const signal = request.signal;

    let registered = false;
    let settled = false;
    /** A notification that arrived while the read was not yet parked. */
    let wake = false;
    let pending: ((outcome: WaitOutcome) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const settleWait = (outcome: WaitOutcome): void => {
      const resolve = pending;
      if (resolve === null) return;
      pending = null;
      clearTimer();
      resolve(outcome);
    };

    const waiter: Waiter = {
      partitions: new Set(request.partitions),
      notify: () => {
        wake = true;
        settleWait('changed');
      },
    };

    // Cancellation ends this read's wait only; the hub, the shared subscription
    // and every other parked read are untouched.
    const onAbort = (): void => settleWait('cancelled');
    if (signal !== undefined && !signal.aborted) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (status: ReadStatus, pack: Pack | null): ReadResult => {
      if (settled) throw new Error('internal error: read settled twice');
      settled = true;
      if (pack === null) return emptyResult(request, status);
      const nextOffsets: Record<string, number> = {};
      for (const part of pack.partitions) nextOffsets[part.partition] = part.nextOffset;
      return {
        status,
        revision: pack.revision,
        partitions: pack.partitions,
        bytes: pack.bytes,
        recordCount: pack.recordCount,
        nextOffsets,
        stopReason: pack.stopReason,
      };
    };

    const wait = (): Promise<WaitOutcome> =>
      new Promise<WaitOutcome>((resolve) => {
        if (signal?.aborted === true) {
          resolve('cancelled');
          return;
        }
        if (wake) {
          wake = false;
          resolve('changed');
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          resolve('timeout');
          return;
        }
        // The checks above and the resolver installation are synchronous with
        // no suspension point between them, so an append or abort cannot slip
        // in and be missed.
        pending = resolve;
        timer = setTimeout(() => {
          timer = null;
          const settle = pending;
          pending = null;
          if (settle !== null) settle('timeout');
        }, remaining);
      });

    try {
      while (true) {
        if (signal?.aborted === true) return finish('cancelled', null);

        // Reset before reading the revision. Any change delivered later is
        // either visible in the snapshots pinned at this revision, or leaves
        // `wake` set so the loop re-checks before parking.
        wake = false;

        const revision = adapter.snapshotRevision();
        const pack = this.#pack(revision, request);

        if (pack.bytes >= request.minBytes) return finish('min-bytes', pack);
        // A positive minimum with no partitions can never be reached, so there
        // is nothing to wait for; report what fit (nothing) at this revision.
        if (request.partitions.length === 0) return finish('deadline', pack);
        if (signal?.aborted === true) return finish('cancelled', null);
        if (Date.now() >= deadline) return finish('deadline', pack);

        if (!registered) {
          // Park at exactly the revision used to judge "not enough data":
          // appends between that decision and this subscription are replayed
          // by the adapter, so none can be lost.
          this.#hub.add(waiter, revision);
          registered = true;
        }

        // If a replay already set `wake`, this resolves without parking. The
        // remaining time is re-derived from the absolute deadline each time,
        // so a wake-up just before the deadline still settles on time.
        await wait();
      }
    } finally {
      if (registered) this.#hub.remove(waiter);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      clearTimer();
    }
  }

  /**
   * Greedy round-robin packing pinned at `revision`.
   *
   * Each round takes at most one record from each requested partition, in
   * request order, skipping partitions with nothing available at this revision.
   * Per-partition order is preserved. Packing ends when:
   *  - the minimum byte count is reached (immediately, when `minBytes` is 0),
   *  - the next record does not fit under `maxBytes` (the first record of an
   *    otherwise empty pack may exceed it, but is then returned alone),
   *  - `maxRecords` is reached, or
   *  - every requested partition is exhausted at this revision.
   *
   * The pack never exceeds either hard cap, even when the minimum cannot be
   * reached: the remaining budget is simply left unused.
   */
  #pack(revision: number, request: ReadRequest): Pack {
    const adapter = this.#adapter;
    const states: PackState[] = [];
    for (const partition of request.partitions) {
      const snapshot = adapter.snapshot(partition, revision);
      const requested = request.startOffsets[partition] as number;
      const cursor = Math.max(requested, snapshot.startOffset);
      states.push({
        partition,
        requestedStart: requested,
        snapshotStart: snapshot.startOffset,
        records: snapshot.records,
        cursor,
        end: Math.max(cursor, snapshot.nextOffset),
        packed: [],
        bytes: 0,
      });
    }

    const minBytes = request.minBytes;
    const maxBytes = request.maxBytes;
    const maxRecords = request.maxRecords;
    let totalBytes = 0;
    let totalRecords = 0;
    let stopReason: PackStopReason = 'exhausted';

    const take = (state: PackState, record: LogRecord, bytes: number): void => {
      state.packed.push(record);
      state.bytes += bytes;
      state.cursor += 1;
      totalBytes += bytes;
      totalRecords += 1;
    };

    packLoop: while (true) {
      if (totalRecords >= maxRecords) {
        stopReason = 'max-records';
        break;
      }
      let progressed = false;
      for (const state of states) {
        if (state.cursor >= state.end) continue; // empty partition this round
        if (totalRecords >= maxRecords) {
          stopReason = 'max-records';
          break packLoop;
        }
        const record = state.records[state.cursor - state.snapshotStart];
        if (record === undefined) {
          // A snapshot may not contain holes; if one appears, treat it as the
          // end of what this partition offers rather than inventing an offset.
          state.end = state.cursor;
          continue;
        }
        const bytes = adapter.byteLength(record);
        if (totalBytes + bytes > maxBytes) {
          if (totalRecords === 0) {
            // A record larger than the byte cap may be returned alone.
            take(state, record, bytes);
            progressed = true;
            stopReason = totalBytes >= minBytes ? 'min-bytes' : 'max-bytes';
          } else {
            stopReason = 'max-bytes';
          }
          break packLoop;
        }
        take(state, record, bytes);
        progressed = true;
        // `minBytes === 0` means "return whatever is ready", not "return
        // nothing": keep packing up to the caps, then report min-bytes.
        if (minBytes > 0 && totalBytes >= minBytes) {
          stopReason = 'min-bytes';
          break packLoop;
        }
      }
      if (!progressed) {
        stopReason = 'exhausted';
        break;
      }
    }

    const partitions: ReadPartitionResult[] = states.map((state) => {
      const firstOffset = Math.max(state.requestedStart, state.snapshotStart);
      return {
        partition: state.partition,
        startOffset: state.requestedStart,
        firstOffset,
        // Always points past the last record actually returned, so a read
        // resuming here neither re-consumes nor skips a returned record.
        nextOffset: state.cursor,
        records: state.packed,
        bytes: state.bytes,
      };
    });

    return { revision, partitions, bytes: totalBytes, recordCount: totalRecords, stopReason };
  }
}

/** Result for a read cancelled before it committed to any pack. */
function emptyResult(request: ReadRequest, status: ReadStatus): ReadResult {
  const nextOffsets: Record<string, number> = {};
  const partitions = request.partitions.map((partition) => {
    const offset = request.startOffsets[partition] as number;
    nextOffsets[partition] = offset;
    return {
      partition,
      startOffset: offset,
      firstOffset: offset,
      nextOffset: offset,
      records: [],
      bytes: 0,
    };
  });
  return {
    status,
    revision: null,
    partitions,
    bytes: 0,
    recordCount: 0,
    nextOffsets,
    stopReason: 'exhausted',
  };
}

function validateRequest(request: ReadRequest): void {
  if (request === null || typeof request !== 'object') {
    throw new TypeError('read request must be an object');
  }
  const partitions = request.partitions;
  if (!Array.isArray(partitions)) throw new TypeError('partitions must be an array');
  const seen = new Set<string>();
  for (const partition of partitions) {
    if (typeof partition !== 'string' || partition.length === 0) {
      throw new TypeError('partition names must be non-empty strings');
    }
    if (seen.has(partition)) throw new TypeError(`duplicate partition in request: ${partition}`);
    seen.add(partition);
  }
  const offsets: unknown = request.startOffsets;
  if (offsets === null || typeof offsets !== 'object') {
    throw new TypeError('startOffsets must be an object');
  }
  for (const partition of partitions) {
    const offset = (offsets as Record<string, unknown>)[partition];
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      throw new TypeError(`startOffsets[${partition}] must be a non-negative integer`);
    }
  }
  checkCount('minBytes', request.minBytes);
  checkCount('maxBytes', request.maxBytes);
  checkCount('maxRecords', request.maxRecords);
  if (typeof request.waitMs !== 'number' || !Number.isFinite(request.waitMs) || request.waitMs < 0) {
    throw new TypeError('waitMs must be a non-negative finite number');
  }
}

function checkCount(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

/** Convenience factory so callers need not name the class. */
export function createReader(adapter: LogAdapter): LongPollReader {
  return new LongPollReader(adapter);
}
