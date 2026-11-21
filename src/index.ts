/**
 * Public entry point for the correlation subscription module.
 *
 * Typical use:
 *
 * ```ts
 * import { CorrelationEngine } from './src/index.ts';
 *
 * const engine = new CorrelationEngine({
 *   sources: ['left', 'right'],
 *   windowMs: 10,
 * });
 *
 * engine.ingest({ id: 'b1', source: 'right', key: 'k', type: 'B', time: 5 });
 * const r = engine.ingest({ id: 'a1', source: 'left', key: 'k', type: 'A', time: 4 });
 * console.log(r.delta);            // { retracted: [], added: [{ aId: 'a1', bId: 'b1', ... }] }
 * engine.advanceWatermark('left', 100);
 * engine.advanceWatermark('right', 100);
 * console.log(engine.snapshot().final); // now immutable
 * ```
 */

export {
  CorrelationEngine,
  type EngineOptions,
  type IngestStatus,
  type IngestResult,
  type WatermarkResult,
  type Snapshot,
  type Stats,
} from './engine.ts';

export {
  type CorrelationEvent,
  type CorrelationType,
  type EventTypeName,
  type Match,
  type MatchDelta,
  emptyDelta,
  isDeltaEmpty,
  sortMatches,
  compareMatches,
  compareEvents,
  sameEventContent,
} from './types.ts';

export { matchKeyEvents, type KeyMatchResult } from './matching.ts';
export { referenceMatches, type ReferenceResult } from './reference.ts';

export type {
  SubscriptionEvent,
  SubscriptionUpdate,
} from './subscription.ts';
export { CorrelationSubscription } from './subscription.ts';
