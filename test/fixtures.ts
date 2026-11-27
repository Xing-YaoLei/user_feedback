/**
 * Shared topology fixtures for the test suite and the runnable example.
 *
 * `shopTopology()` is deliberately awkward. It contains:
 *   - a diamond (ingress -> split -> {left, right} -> q-left),
 *   - a normal binding cycle (left -> cycle-a -> cycle-b -> left),
 *   - a downstream exchange (`right`) with its *own* alternate (`shadow-dlx`);
 *     that alternate must never fire during normal traversal,
 *   - two equal-length paths to q-left, resolved by binding-id sequence,
 *   - a longer id-smaller path to q-left that must lose on length,
 *   - a one-hop alternate (ingress -> dlx-entry -> q-dead),
 *   - a multi-hop alternate chain (chain-a -> chain-b -> chain-c -> q-chain),
 *   - a separate alternate cycle (alt-a <-> alt-b).
 */

import type { TopologyInput } from '../src/index.ts';

export function shopTopology(): TopologyInput {
  return {
    exchanges: [
      { name: 'ingress', kind: 'topic', alternateExchange: 'dlx-entry' },
      { name: 'split', kind: 'fanout' },
      { name: 'left', kind: 'topic' },
      { name: 'right', kind: 'direct', alternateExchange: 'shadow-dlx' },
      { name: 'cycle-a', kind: 'fanout' },
      { name: 'cycle-b', kind: 'fanout' },
      { name: 'shadow-dlx', kind: 'fanout' },
      { name: 'dlx-entry', kind: 'fanout' },
      { name: 'chain-a', kind: 'fanout', alternateExchange: 'chain-b' },
      { name: 'chain-b', kind: 'fanout', alternateExchange: 'chain-c' },
      { name: 'chain-c', kind: 'fanout' },
      { name: 'alt-a', kind: 'fanout', alternateExchange: 'alt-b' },
      { name: 'alt-b', kind: 'fanout', alternateExchange: 'alt-a' },
      { name: 'dead-end', kind: 'direct' },
    ],
    queues: [
      { name: 'q-left' },
      { name: 'q-right' },
      { name: 'q-dead' },
      { name: 'q-shadow' },
      { name: 'q-chain' },
      { name: 'q-orphan' },
    ],
    bindings: [
      // ingress -> split, matched by any key whose first segment is `order`.
      { id: 'b01', source: 'ingress', destination: 'split', destinationKind: 'exchange', routingKey: 'order.#' },
      // Fanout split to both diamond arms.
      { id: 'b02', source: 'split', destination: 'left', destinationKind: 'exchange' },
      { id: 'b03', source: 'split', destination: 'right', destinationKind: 'exchange' },
      // Two equal-length routes to q-left; b02 < b03, so the left arm wins.
      { id: 'b04', source: 'left', destination: 'q-left', destinationKind: 'queue', routingKey: 'order.*' },
      { id: 'b05', source: 'right', destination: 'q-right', destinationKind: 'queue', routingKey: 'order.created' },
      { id: 'b06', source: 'right', destination: 'q-left', destinationKind: 'queue', routingKey: 'order.created' },
      // Normal binding cycle rooted at `left`.
      { id: 'b07', source: 'left', destination: 'cycle-a', destinationKind: 'exchange' },
      { id: 'b08', source: 'cycle-a', destination: 'cycle-b', destinationKind: 'exchange' },
      { id: 'b09', source: 'cycle-b', destination: 'left', destinationKind: 'exchange' },
      // Deliberately tiny id on a *longer* path: shortest path still wins.
      { id: 'b00', source: 'cycle-b', destination: 'q-left', destinationKind: 'queue' },
      // Downstream alternate target. Only reachable if the router wrongly
      // consults `right`'s alternate during normal traversal.
      { id: 'b10', source: 'shadow-dlx', destination: 'q-shadow', destinationKind: 'queue' },
      // Entry alternate target.
      { id: 'b11', source: 'dlx-entry', destination: 'q-dead', destinationKind: 'queue' },
      // Multi-hop alternate chain terminal.
      { id: 'b12', source: 'chain-c', destination: 'q-chain', destinationKind: 'queue' },
    ],
  };
}

/** A key that exercises the diamond, both branches, and the normal cycle. */
export const DIAMOND_KEY = 'order.created';

/** A key matched by ingress and the left arm only. */
export const PARTIAL_KEY = 'order.shipped';

/** A key matched by nothing on ingress's normal bindings. */
export const ORPHAN_KEY = 'orphan.key';

/**
 * A key that reaches `split` on normal bindings but matches no queue there.
 * `right` declares an alternate, but it must not fire: only ingress's
 * alternate is eligible once the total normal result is empty.
 */
export const DOWNSTREAM_ONLY_KEY = 'order';
