/**
 * Public entry point for the message router module.
 *
 * Typical embedded use:
 *
 *     import { Router } from 'message-router';
 *
 *     const router = new Router({
 *       exchanges: [
 *         { name: 'events', kind: 'topic', alternateExchange: 'dlx' },
 *         { name: 'dlx', kind: 'fanout' },
 *       ],
 *       queues: [{ name: 'orders' }, { name: 'dead' }],
 *       bindings: [
 *         { id: 'b1', source: 'events', destination: 'orders', destinationKind: 'queue', routingKey: 'order.*' },
 *         { id: 'b2', source: 'dlx', destination: 'dead', destinationKind: 'queue' },
 *       ],
 *     });
 *
 *     const result = router.route({ exchange: 'events', routingKey: 'order.created' });
 *     // -> { routable: true, resolvedFrom: 'events', targets: [{ queue: 'orders', bindingPath: ['b1'] }], ... }
 *
 * `routeOnTopology` / `compileTopology` are also exported for callers that
 * want to manage immutable snapshots themselves (e.g. share one compiled
 * snapshot across many request handlers).
 */

export { Router, snapshotOf } from './router.ts';
export type { RouterSnapshotInfo, TopologySnapshot } from './router.ts';
export {
  saveSnapshot,
  loadSnapshot,
  canonicalTopology,
} from './store.ts';
export type {
  LoadedSnapshot,
  SnapshotEnvelope,
  SnapshotFileAdapter,
  TopologyStoreOptions,
} from './store.ts';
export {
  compileTopology,
  compareBindingPaths,
} from './topology.ts';
export type { NormalTraversal, TraversalStats } from './traversal.ts';
export {
  parseRoutingKey,
  parseTopicPattern,
  topicMatches,
} from './matching.ts';
export { bindingMatches, traverseNormal } from './traversal.ts';
export { routeOnTopology } from './routing.ts';
export { RouterError } from './types.ts';
export type {
  AlternateCycle,
  BindingDefinition,
  DeliveryTarget,
  DestinationKind,
  ExchangeDefinition,
  ExchangeKind,
  Hop,
  ParsedKey,
  ParsedPattern,
  PublishInput,
  QueueDefinition,
  ResolvedBinding,
  RouteResult,
  Topology,
  TopologyInput,
  VersionedRouteResult,
} from './types.ts';
