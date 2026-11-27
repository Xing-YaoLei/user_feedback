/**
 * Stateful embeddable facade.
 *
 * `Router` holds one compiled topology snapshot at a time. Replacing the
 * topology is a single atomic swap: a routing call captures the snapshot and
 * its version before doing any work, so every message is routed against
 * exactly one topology version even if another task replaces the topology
 * mid-flight.
 *
 * `replaceTopology` validates and compiles the whole new description before
 * the swap, so a rejected replacement leaves the previous version fully
 * intact — a crash while building the next topology can never leave a
 * half-applied one visible.
 */

import { compileTopology } from './topology.ts';
import { routeOnTopology } from './routing.ts';
import type {
  PublishInput,
  RouteResult,
  Topology,
  TopologyInput,
  VersionedRouteResult,
} from './types.ts';

export interface RouterSnapshotInfo {
  readonly version: number;
  readonly exchangeCount: number;
  readonly queueCount: number;
  readonly bindingCount: number;
}

/**
 * An immutable handle to one topology version. All routes taken through it
 * use that version, no matter how many times the owning `Router` replaces its
 * topology afterward.
 */
export interface TopologySnapshot {
  readonly version: number;
  readonly topology: Topology;
  readonly info: RouterSnapshotInfo;
  route(publish: PublishInput): VersionedRouteResult;
  routeBatch(publishes: readonly PublishInput[]): VersionedRouteResult[];
}

export class Router {
  #topology: Topology;
  #version: number;

  constructor(topology?: TopologyInput | Topology, version = 0) {
    if (isCompiled(topology)) {
      this.#topology = topology;
    } else {
      this.#topology = compileTopology(topology ?? {});
    }
    if (!Number.isInteger(version) || version < 0) {
      throw new TypeError(`Router version must be a non-negative integer, got ${version}`);
    }
    this.#version = version;
  }

  /**
   * Rebuild a router from a snapshot loaded off disk (or any captured
   * `{ topology, version }` pair), preserving its version counter so later
   * replacements continue the same sequence.
   */
  static fromSnapshot(snapshot: { topology: Topology; version: number }): Router {
    return new Router(snapshot.topology, snapshot.version);
  }

  /** Version counter, incremented once per successful topology replacement. */
  get version(): number {
    return this.#version;
  }

  /** Current immutable snapshot. Safe to retain; it will never change. */
  get topology(): Topology {
    return this.#topology;
  }

  /** Metadata about the current snapshot. */
  snapshotInfo(): RouterSnapshotInfo {
    return snapshotOf(this.#topology, this.#version);
  }

  /**
   * Pin the current topology version. Useful when a logical batch of work
   * spans `await` points and must not observe a later replacement.
   */
  capture(): TopologySnapshot {
    const topology = this.#topology;
    const version = this.#version;
    const info = snapshotOf(topology, version);
    return Object.freeze({
      version,
      topology,
      info,
      route: (publish: PublishInput) => withVersion(routeOnTopology(topology, publish), version),
      routeBatch: (publishes: readonly PublishInput[]) =>
        publishes.map((publish) => withVersion(routeOnTopology(topology, publish), version)),
    });
  }

  /**
   * Replace the entire topology in one batch. Either the new description
   * compiles and becomes version `version + 1`, or this throws and nothing
   * changes.
   */
  replaceTopology(input: TopologyInput | Topology): RouterSnapshotInfo {
    const next = isCompiled(input) ? input : compileTopology(input);
    this.#topology = next;
    this.#version += 1;
    return this.snapshotInfo();
  }

  /**
   * Route one message against the snapshot current at call time. The result
   * records the topology version that produced it.
   */
  route(publish: PublishInput): VersionedRouteResult {
    return this.capture().route(publish);
  }

  /**
   * Route a batch of publishes that all observe one topology version. The
   * snapshot is captured once, before the loop.
   */
  routeBatch(publishes: readonly PublishInput[]): VersionedRouteResult[] {
    return this.capture().routeBatch(publishes);
  }
}

export function snapshotOf(topology: Topology, version: number): RouterSnapshotInfo {
  return Object.freeze({
    version,
    exchangeCount: topology.exchanges.size,
    queueCount: topology.queueNames.size,
    bindingCount: topology.bindings.length,
  });
}

function withVersion(result: RouteResult, topologyVersion: number): VersionedRouteResult {
  return Object.freeze({ ...result, topologyVersion });
}

function isCompiled(value: TopologyInput | Topology | undefined): value is Topology {
  if (value === undefined || value === null || typeof value !== 'object') return false;
  return 'bindingsBySource' in value && 'queueNames' in value && 'bindings' in value;
}
