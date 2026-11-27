/**
 * Top-level routing: normal delivery first, alternate-exchange fallback second.
 *
 * Algorithm for one publish starting at entry exchange E:
 *
 *   1. Traverse normal bindings from E (alternate-blind) and collect queues.
 *      Non-empty → done. Alternates were never consulted.
 *   2. Empty → follow E's alternate A (if any), record the hop, and repeat
 *      step 1 with A as the entry.
 *   3. If an exchange along this alternate chain has already been visited,
 *      the chain cycles: return unroutable, naming the cycle. No further
 *      hops are taken.
 *   4. If the chain ends at an exchange with no alternate, the message is
 *      unroutable with no cycle.
 *
 * The alternate chain is strictly linear: each step uses that exchange's own
 * alternate, and the *normal* traversal from it remains alternate-blind. That
 * is exactly the "downstream exchanges do not use their own alternate" rule.
 */

import { parseRoutingKey } from './matching.ts';
import { traverseNormal } from './traversal.ts';
import { RouterError } from './types.ts';
import type {
  AlternateCycle,
  DeliveryTarget,
  Hop,
  PublishInput,
  RouteResult,
  Topology,
} from './types.ts';

function alternateOf(topology: Topology, exchange: string): string | null {
  const definition = topology.exchanges.get(exchange);
  if (!definition) {
    throw new RouterError('UNKNOWN_EXCHANGE', `exchange "${exchange}" is not in the topology`);
  }
  const alternate = definition.alternateExchange;
  return alternate === undefined || alternate === null ? null : alternate;
}

function toTargets(queues: Map<string, readonly string[]>): DeliveryTarget[] {
  const targets: DeliveryTarget[] = [];
  for (const [queue, bindingPath] of queues) {
    targets.push(Object.freeze({ queue, bindingPath }));
  }
  targets.sort((a, b) => (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0));
  return Object.freeze(targets) as DeliveryTarget[];
}

/**
 * Route one message against an immutable topology snapshot.
 *
 * Never mutates the snapshot; the returned object is a fresh value.
 * Throws `RouterError` (`UNKNOWN_EXCHANGE`, `INVALID_ROUTING_KEY`) for bad
 * inputs, but a structurally valid topology never throws during routing.
 */
export function routeOnTopology(topology: Topology, publish: PublishInput): RouteResult {
  if (publish === null || typeof publish !== 'object') {
    throw new RouterError('INVALID_PUBLISH', 'publish must be an object');
  }
  const entry = publish.exchange;
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new RouterError('INVALID_PUBLISH', 'publish.exchange must be a non-empty string');
  }
  if (!topology.exchanges.has(entry)) {
    throw new RouterError('UNKNOWN_EXCHANGE', `exchange "${entry}" is not in the topology`);
  }

  const key = parseRoutingKey(publish.routingKey ?? '');
  const alternates: Hop[] = [];

  // Which exchanges have been used as a step in the alternate chain.
  const visited = new Set<string>([entry]);
  // Chain order, for reporting a cycle.
  const chain: string[] = [entry];

  let current = entry;
  for (;;) {
    const traversal = traverseNormal(topology, current, key);
    if (traversal.queues.size > 0) {
      const result: RouteResult = {
        routable: true,
        exchange: entry,
        routingKey: key.raw,
        resolvedFrom: current,
        alternates: Object.freeze(alternates.slice()) as readonly Hop[],
        targets: toTargets(traversal.queues),
      };
      return Object.freeze(result);
    }

    const alternate = alternateOf(topology, current);
    if (alternate === null) {
      // Nothing matched and nowhere left to fall back to.
      return Object.freeze({
        routable: false,
        exchange: entry,
        routingKey: key.raw,
        alternates: Object.freeze(alternates.slice()) as readonly Hop[],
        targets: Object.freeze([]) as readonly DeliveryTarget[],
      });
    }

    if (visited.has(alternate)) {
      // Do not record this jump: the chain never actually moved there.
      const start = chain.indexOf(alternate);
      const cyclePath = Object.freeze([...chain.slice(start), alternate]);
      const cycle: AlternateCycle = Object.freeze({
        reason: 'alternate-cycle',
        exchanges: cyclePath,
      });
      return Object.freeze({
        routable: false,
        exchange: entry,
        routingKey: key.raw,
        alternates: Object.freeze(alternates.slice()) as readonly Hop[],
        targets: Object.freeze([]) as readonly DeliveryTarget[],
        alternateCycle: cycle,
      });
    }

    alternates.push(Object.freeze({ exchange: current, alternateExchange: alternate }));
    visited.add(alternate);
    chain.push(alternate);
    current = alternate;
  }
}
