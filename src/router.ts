/**
 * Sharded routing table over an unsigned 32-bit key space.
 *
 * The key space is the half-open interval [0, KEY_SPACE). Every point of the
 * space is owned by exactly one segment at all times; the table starts as a
 * single segment covering the whole space.
 */

/** Exclusive upper bound of the shard key space: 2^32. */
export const KEY_SPACE = 0x1_0000_0000; // 4_294_967_296

/** A contiguous half-open range `[start, end)` with a single owner. */
export interface RouteSegment {
  readonly start: number;
  readonly end: number;
  readonly address: string;
  readonly generation: number;
}

/** A permanent ownership hint: it may be merged into the shared table. */
export interface PermanentHint {
  readonly kind: 'permanent';
  readonly start: number;
  readonly end: number;
  readonly address: string;
  readonly generation: number;
}

/** A temporary forwarding hint: only the receiving call may use it. */
export interface TemporaryHint {
  readonly kind: 'temporary';
  readonly address: string;
}

export type OwnerHint = PermanentHint | TemporaryHint;

/** Information about an equal-generation, different-owner overlap. */
export interface ConflictInfo {
  readonly start: number;
  readonly end: number;
  readonly generation: number;
  readonly existingAddress: string;
  readonly incomingAddress: string;
}

export type ApplyStatus = 'applied' | 'stale' | 'conflict' | 'invalid';

export interface ApplyResult {
  readonly status: ApplyStatus;
  /** True only when the routing table was mutated. */
  readonly changed: boolean;
  readonly message: string;
  readonly conflict?: ConflictInfo;
}

export interface RouterOptions {
  /** Address owning the whole key space before any hint is applied. */
  readonly initialAddress?: string;
  /** Generation of the initial route. Defaults to 0. */
  readonly initialGeneration?: number;
}

const DEFAULT_ADDRESS = 'bootstrap:0';

/** True for a valid shard key: integer in [0, 2^32). */
export function isShardKey(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < KEY_SPACE
  );
}

/** True for a valid range endpoint: integer in [0, 2^32]. */
export function isRangeEndpoint(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= KEY_SPACE
  );
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a permanent hint coming from the network.
 * Returns a human readable reason, or `null` when the hint is well formed.
 */
export function validatePermanentHint(hint: PermanentHint): string | null {
  if (hint === null || typeof hint !== 'object') {
    return 'permanent hint must be an object';
  }
  if (hint.kind !== 'permanent') {
    return `permanent hint has unexpected kind ${String(hint.kind)}`;
  }
  if (!isRangeEndpoint(hint.start)) {
    return `hint start ${String(hint.start)} is not an unsigned 32-bit boundary`;
  }
  if (!isRangeEndpoint(hint.end)) {
    return `hint end ${String(hint.end)} is not an unsigned 32-bit boundary`;
  }
  if (hint.start >= hint.end) {
    return `hint range [${hint.start}, ${hint.end}) is empty`;
  }
  if (!isGeneration(hint.generation)) {
    return `hint generation ${String(hint.generation)} is not a non-negative safe integer`;
  }
  if (!isAddress(hint.address)) {
    return 'hint address must be a non-empty string';
  }
  return null;
}

/** Validate a temporary hint coming from the network. */
export function validateTemporaryHint(hint: TemporaryHint): string | null {
  if (hint === null || typeof hint !== 'object') {
    return 'temporary hint must be an object';
  }
  if (hint.kind !== 'temporary') {
    return `temporary hint has unexpected kind ${String(hint.kind)}`;
  }
  if (!isAddress(hint.address)) {
    return 'temporary hint address must be a non-empty string';
  }
  return null;
}

function cloneSegment(segment: RouteSegment): RouteSegment {
  return {
    start: segment.start,
    end: segment.end,
    address: segment.address,
    generation: segment.generation,
  };
}

function sameSegments(
  left: readonly RouteSegment[],
  right: readonly RouteSegment[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.start !== b.start ||
      a.end !== b.end ||
      a.address !== b.address ||
      a.generation !== b.generation
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A sorted, gap-free, coalesced partition of [0, 2^32) into owner ranges.
 *
 * Updates are synchronous and atomic: a rejected (conflicting or invalid)
 * hint never mutates the table. The range outside a hint is never touched.
 */
export class Router {
  #segments: RouteSegment[];

  constructor(options: RouterOptions = {}) {
    const address = options.initialAddress ?? DEFAULT_ADDRESS;
    const generation = options.initialGeneration ?? 0;

    if (!isAddress(address)) {
      throw new TypeError('initialAddress must be a non-empty string');
    }
    if (!isGeneration(generation)) {
      throw new TypeError('initialGeneration must be a non-negative safe integer');
    }

    this.#segments = [
      { start: 0, end: KEY_SPACE, address, generation },
    ];
  }

  /** Number of ranges currently held by the table. */
  get size(): number {
    return this.#segments.length;
  }

  /** Defensive copy of the current partition, in key order. */
  snapshot(): RouteSegment[] {
    return this.#segments.map(cloneSegment);
  }

  /**
   * Owner of a single shard key.
   * @throws RangeError when the key is not an unsigned 32-bit integer.
   */
  lookup(key: number): RouteSegment {
    if (!isShardKey(key)) {
      throw new RangeError(
        `shard key ${String(key)} is not an unsigned 32-bit integer`,
      );
    }

    const segments = this.#segments;
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const segment = segments[middle];
      if (key < segment.start) {
        high = middle - 1;
      } else if (key >= segment.end) {
        low = middle + 1;
      } else {
        return cloneSegment(segment);
      }
    }

    // The partition invariant guarantees a hit above.
    throw new Error('routing table invariant violated: key is uncovered');
  }

  /** Convenience wrapper around {@link lookup}. */
  ownerOf(key: number): string {
    return this.lookup(key).address;
  }

  /**
   * Merge a permanent hint into the shared table.
   *
   * Semantics:
   * - Every point in `[start, end)` adopts the hint only when the hint has a
   *   strictly higher generation than the route currently covering it.
   * - Overlaps split the existing ranges; everything outside stays untouched.
   * - If any overlapping point has the same generation but a different owner,
   *   the *whole* hint is rejected as a conflict and the table is not changed.
   * - Lower generations are ignored; a hint that changes nothing is `stale`.
   * - Malformed hints are rejected as `invalid` without touching the table.
   *
   * The operation is synchronous, so concurrent callers cannot interleave
   * partially applied hints.
   */
  applyPermanentHint(hint: PermanentHint): ApplyResult {
    const invalidReason = validatePermanentHint(hint);
    if (invalidReason !== null) {
      return { status: 'invalid', changed: false, message: invalidReason };
    }

    // Phase 1: atomic conflict detection. Any equal-generation overlap with a
    // different owner rejects the whole hint before anything is mutated.
    for (const segment of this.#segments) {
      const overlapStart = Math.max(segment.start, hint.start);
      const overlapEnd = Math.min(segment.end, hint.end);
      if (overlapStart >= overlapEnd) continue;
      if (
        segment.generation === hint.generation &&
        segment.address !== hint.address
      ) {
        return {
          status: 'conflict',
          changed: false,
          message:
            `hint [${hint.start}, ${hint.end}) -> ${hint.address}@${hint.generation} ` +
            `conflicts with ${segment.address}@${segment.generation} ` +
            `on [${overlapStart}, ${overlapEnd})`,
          conflict: {
            start: overlapStart,
            end: overlapEnd,
            generation: segment.generation,
            existingAddress: segment.address,
            incomingAddress: hint.address,
          },
        };
      }
    }

    // Phase 2: rebuild the partition, splitting at the hint boundaries.
    const next: RouteSegment[] = [];
    const push = (segment: RouteSegment): void => {
      const previous = next[next.length - 1];
      if (
        previous !== undefined &&
        previous.end === segment.start &&
        previous.address === segment.address &&
        previous.generation === segment.generation
      ) {
        next[next.length - 1] = {
          start: previous.start,
          end: segment.end,
          address: previous.address,
          generation: previous.generation,
        };
        return;
      }
      next.push(cloneSegment(segment));
    };

    for (const segment of this.#segments) {
      const overlapStart = Math.max(segment.start, hint.start);
      const overlapEnd = Math.min(segment.end, hint.end);

      if (overlapStart >= overlapEnd) {
        push(segment);
        continue;
      }

      if (segment.start < overlapStart) {
        push({
          start: segment.start,
          end: overlapStart,
          address: segment.address,
          generation: segment.generation,
        });
      }

      if (segment.generation < hint.generation) {
        push({
          start: overlapStart,
          end: overlapEnd,
          address: hint.address,
          generation: hint.generation,
        });
      } else {
        // Equal generation (same owner, checked above) or newer local route.
        push({
          start: overlapStart,
          end: overlapEnd,
          address: segment.address,
          generation: segment.generation,
        });
      }

      if (overlapEnd < segment.end) {
        push({
          start: overlapEnd,
          end: segment.end,
          address: segment.address,
          generation: segment.generation,
        });
      }
    }

    if (sameSegments(this.#segments, next)) {
      return {
        status: 'stale',
        changed: false,
        message:
          `hint [${hint.start}, ${hint.end}) -> ${hint.address}@${hint.generation} ` +
          'is not newer than the current routes',
      };
    }

    this.#segments = next;
    return {
      status: 'applied',
      changed: true,
      message:
        `applied hint [${hint.start}, ${hint.end}) -> ${hint.address}@${hint.generation}`,
    };
  }

  /**
   * Check the internal partition invariant. Useful in tests and diagnostics.
   * @throws Error when the routing table is malformed.
   */
  assertInvariant(): void {
    const segments = this.#segments;
    if (segments.length === 0) {
      throw new Error('routing table has no segments');
    }

    let expectedStart = 0;
    let previous: RouteSegment | undefined;
    for (const segment of segments) {
      if (segment.start !== expectedStart) {
        throw new Error(
          `routing table is not contiguous at key ${expectedStart}`,
        );
      }
      if (segment.end <= segment.start) {
        throw new Error(`routing table segment [${segment.start}, ${segment.end}) is empty`);
      }
      if (!isAddress(segment.address)) {
        throw new Error(`routing table has an invalid address at [${segment.start}, ${segment.end})`);
      }
      if (!isGeneration(segment.generation)) {
        throw new Error(`routing table has an invalid generation at [${segment.start}, ${segment.end})`);
      }
      if (
        previous !== undefined &&
        previous.address === segment.address &&
        previous.generation === segment.generation
      ) {
        throw new Error(
          `routing table has uncoalesced segments at key ${segment.start}`,
        );
      }
      expectedStart = segment.end;
      previous = segment;
    }

    if (expectedStart !== KEY_SPACE) {
      throw new Error(
        `routing table ends at ${expectedStart}, expected ${KEY_SPACE}`,
      );
    }
  }
}
