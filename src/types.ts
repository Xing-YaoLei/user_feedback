/**
 * Public value types for the routing module.
 *
 * Everything here is plain data. A topology is compiled from these objects
 * into an immutable snapshot; the router never mutates its inputs, and every
 * result is a fresh, serialisable value owned by the caller.
 */

/** Kind of switch an exchange can be. */
export type ExchangeKind = 'direct' | 'fanout' | 'topic';

/** Where a binding delivers: a queue or another exchange. */
export type DestinationKind = 'queue' | 'exchange';

export interface QueueDefinition {
  readonly name: string;
}

export interface ExchangeDefinition {
  readonly name: string;
  readonly kind: ExchangeKind;
  /**
   * Alternate exchange for this exchange. Consulted only after a publish
   * whose *current solve root* is this exchange resolves to an empty normal
   * queue set.
   */
  readonly alternateExchange?: string | null;
}

export interface BindingDefinition {
  readonly id: string;
  readonly source: string;
  readonly destination: string;
  /**
   * Whether `destination` names a queue or another exchange. May be omitted
   * when the destination name identifies exactly one of the two; it is
   * required if the name exists as both.
   */
  readonly destinationKind?: DestinationKind;
  /**
   * Binding key.
   *
   * - `direct`: matched literally against the routing key (default `''`).
   * - `fanout`: ignored (any string is tolerated; default `''`).
   * - `topic`: a dotted pattern where `*` is one segment and `#` is zero or
   *   more segments (default `''`, the zero-segment pattern).
   */
  readonly routingKey?: string;
}

export interface TopologyInput {
  readonly exchanges?: readonly ExchangeDefinition[];
  readonly queues?: readonly QueueDefinition[];
  readonly bindings?: readonly BindingDefinition[];
}

/** A parsed routing key: the raw string plus its dot-separated segments. */
export interface ParsedKey {
  readonly raw: string;
  readonly segments: readonly string[];
}

/** A validated topic pattern. `#` may repeat, including adjacent `#` segments. */
export interface ParsedPattern {
  readonly raw: string;
  readonly segments: readonly string[];
  /** Number of wildcard segments (`*` or `#`) in the pattern. */
  readonly wildcardCount: number;
}

/** A binding whose destination kind and topic pattern are resolved. */
export interface ResolvedBinding {
  readonly id: string;
  readonly source: string;
  readonly destination: string;
  readonly destinationKind: DestinationKind;
  readonly routingKey: string;
  /** Present only when the source exchange is a `topic` exchange. */
  readonly pattern?: ParsedPattern;
}

/**
 * Fully validated, immutable snapshot of a topology. Produced by
 * `compileTopology`; consumed by `routeOnTopology` and `Router`.
 */
export interface Topology {
  readonly exchanges: ReadonlyMap<string, ExchangeDefinition>;
  readonly queueNames: ReadonlySet<string>;
  readonly bindings: readonly ResolvedBinding[];
  /**
   * Outgoing bindings per source exchange, sorted by binding id. Only sources
   * with at least one binding appear.
   */
  readonly bindingsBySource: ReadonlyMap<string, readonly ResolvedBinding[]>;
}

export interface PublishInput {
  /** Entry exchange for this publish. */
  readonly exchange: string;
  /** Dotted routing key. The empty string means zero segments. */
  readonly routingKey?: string;
}

/** One step along an alternate-exchange chain. */
export interface Hop {
  /** Exchange that declared the alternate. */
  readonly exchange: string;
  /** Alternate exchange the router moved to. */
  readonly alternateExchange: string;
}

export interface DeliveryTarget {
  readonly queue: string;
  /**
   * Binding ids forming the shortest normal path from the exchange that
   * produced the targets (`RouteResult.resolvedFrom`) to this queue. Ties in
   * length are broken lexicographically by this id sequence.
   */
  readonly bindingPath: readonly string[];
}

export interface AlternateCycle {
  readonly reason: 'alternate-cycle';
  /**
   * Exchanges on the cycle in visit order, starting and ending at the first
   * exchange that was revisited. For `chain-a -> chain-b -> chain-a` this is
   * `['chain-a', 'chain-b', 'chain-a']`.
   */
  readonly exchanges: readonly string[];
}

export interface RouteResult {
  readonly routable: boolean;
  /** Entry exchange named by the publish. */
  readonly exchange: string;
  /** The routing key exactly as given (empty string if omitted). */
  readonly routingKey: string;
  /**
   * Exchange whose normal bindings produced `targets`: the entry exchange on
   * a direct hit, or the last alternate reached on a fallback. Absent when
   * the message is unroutable.
   */
  readonly resolvedFrom?: string;
  /**
   * Alternate jumps actually taken, in order. Empty on a direct hit. On an
   * alternate cycle this stops at the last exchange visited; the loop-closing
   * jump appears only in `alternateCycle.exchanges`.
   */
  readonly alternates: readonly Hop[];
  /** One entry per reachable queue, sorted by queue name. */
  readonly targets: readonly DeliveryTarget[];
  /** Present only when the alternate chain loops. */
  readonly alternateCycle?: AlternateCycle;
}

/** `RouteResult` tagged with the topology version used to produce it. */
export interface VersionedRouteResult extends RouteResult {
  readonly topologyVersion: number;
}

export class RouterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
  }
}
