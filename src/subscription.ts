/**
 * Thin subscription layer over the engine.
 *
 * A subscription scopes the stream to one correlation key and turns the raw
 * provisional/final distinction into ordered callbacks:
 *
 *  - `provisional` fires whenever the key's current best-effort matches change
 *    (retract old pairings, add new ones) as events arrive;
 *  - `final` fires when the global progress settles a match for good.
 *
 * Both callbacks receive the same `MatchDelta` shape the engine uses, so a
 * consumer can treat the result set as an incrementally maintained view.
 */

import {
  CorrelationEngine,
  type EngineOptions,
  type IngestResult,
  type Match,
  type MatchDelta,
  type WatermarkResult,
} from './engine.ts';
import type { CorrelationEvent } from './types.ts';

export type SubscriptionEvent =
  | { kind: 'provisional'; key: string; delta: MatchDelta }
  | { kind: 'final'; key: string; matches: Match[] };

export type SubscriptionUpdate = (update: SubscriptionEvent) => void;

function filterDelta(delta: MatchDelta, key: string): MatchDelta {
  return {
    retracted: delta.retracted.filter((m) => m.key === key),
    added: delta.added.filter((m) => m.key === key),
  };
}

export class CorrelationSubscription {
  private readonly engine: CorrelationEngine;
  private readonly key: string;
  private readonly listener: SubscriptionUpdate;

  constructor(
    engine: CorrelationEngine,
    key: string,
    listener: SubscriptionUpdate,
  ) {
    this.engine = engine;
    this.key = key;
    this.listener = listener;
  }

  /** Convenience factory that also builds the backing engine. */
  static create(
    options: EngineOptions,
    key: string,
    listener: SubscriptionUpdate,
  ): { subscription: CorrelationSubscription; engine: CorrelationEngine } {
    const engine = new CorrelationEngine(options);
    const subscription = new CorrelationSubscription(engine, key, listener);
    return { subscription, engine };
  }

  ingest(event: CorrelationEvent): IngestResult {
    const result = this.engine.ingest(event);
    if (result.status === 'accepted') {
      const delta = filterDelta(result.delta, this.key);
      if (delta.retracted.length > 0 || delta.added.length > 0) {
        this.listener({ kind: 'provisional', key: this.key, delta });
      }
    }
    return result;
  }

  advanceWatermark(source: string, watermark: number): WatermarkResult {
    const result = this.engine.advanceWatermark(source, watermark);
    if (result.status === 'applied' && result.finalized.length > 0) {
      const matches = result.finalized.filter((m) => m.key === this.key);
      if (matches.length > 0) {
        this.listener({ kind: 'final', key: this.key, matches });
      }
    }
    return result;
  }

  /** Signal end of stream; emits a single `final` update for this key. */
  end(): WatermarkResult {
    const result = this.engine.end();
    const matches = result.finalized.filter((m) => m.key === this.key);
    if (matches.length > 0) {
      this.listener({ kind: 'final', key: this.key, matches });
    }
    return result;
  }

  snapshot(): Match[] {
    return this.engine.snapshot().all.filter((m) => m.key === this.key);
  }
}
