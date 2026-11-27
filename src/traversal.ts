/**
 * Normal-binding traversal.
 *
 * A publish starts at one exchange. Every outgoing binding whose key matches
 * is followed; exchange destinations are traversed transitively (this is how
 * a publish can "arrive at the same queue along several switch branches").
 * The traversal records, per reachable queue, the shortest binding-id path.
 * Ties in length are resolved by comparing the id sequences lexicographically.
 *
 * The traversal is deliberately *alternate-blind*: it never consults the
 * alternate exchange of a downstream exchange. Only the top-level route()
 * loop may follow an alternate, and only when this entire normal result is
 * empty.
 *
 * Complexity: the walk is breadth-first in binding hops. Each exchange is
 * expanded at most once, and only one best prefix is retained per exchange
 * (and per depth). Normal cycles therefore terminate, and repeated or
 * criss-crossing bindings cannot expand into an exponential number of paths:
 * total binding evaluations are bounded by the number of bindings.
 */

import { topicMatches } from './matching.ts';
import { compareBindingPaths } from './topology.ts';
import { RouterError } from './types.ts';
import type { ExchangeKind, ParsedKey, ResolvedBinding, Topology } from './types.ts';

export interface TraversalStats {
  /** Exchanges expanded; each at most once, so `<= exchange count`. */
  readonly exchangesExpanded: number;
  /** Matching-key binding evaluations; bounded by topology size. */
  readonly bindingsEvaluated: number;
}

export interface NormalTraversal {
  /** Reachable queues with their shortest binding path, keyed by queue name. */
  readonly queues: Map<string, readonly string[]>;
  readonly stats: TraversalStats;
}

/** Keep the shorter path, breaking equal lengths by binding-id sequence. */
function keepBest(map: Map<string, readonly string[]>, key: string, path: readonly string[]): void {
  const current = map.get(key);
  if (current === undefined || compareBindingPaths(path, current) < 0) {
    map.set(key, path);
  }
}

/** Does this binding fire for the given routing key? */
export function bindingMatches(
  binding: ResolvedBinding,
  kind: ExchangeKind,
  key: ParsedKey,
): boolean {
  if (kind === 'fanout') return true;
  if (kind === 'direct') return binding.routingKey === key.raw;
  if (kind === 'topic') {
    // Patterns are parsed during compileTopology; a missing pattern on a topic
    // exchange cannot happen for a valid snapshot, but treat it as no-match.
    return binding.pattern !== undefined && topicMatches(binding.pattern, key);
  }
  return false;
}

/**
 * Traverse normal bindings from `entry` and collect reachable queues.
 *
 * Does not follow alternate exchanges at all, including the entry's own.
 * Throws if `entry` is not an exchange in the snapshot.
 */
export function traverseNormal(
  topology: Topology,
  entry: string,
  key: ParsedKey,
): NormalTraversal {
  if (!topology.exchanges.has(entry)) {
    throw new RouterError('UNKNOWN_EXCHANGE', `exchange "${entry}" is not in the topology`);
  }

  const queues = new Map<string, readonly string[]>();
  // Exchanges already expanded or queued for expansion.
  const reachedExchanges = new Set<string>([entry]);

  // Frontier: exchange name -> best path that reaches it at this depth.
  let frontier = new Map<string, readonly string[]>([[entry, Object.freeze([])]]);
  let exchangesExpanded = 0;
  let bindingsEvaluated = 0;

  while (frontier.size > 0) {
    // Queues discovered at this depth. Keep one best path per queue.
    const queueCandidates = new Map<string, readonly string[]>();
    // Exchanges discovered at this depth, before dropping already-reached ones.
    const exchangeCandidates = new Map<string, readonly string[]>();

    for (const [exchangeName, basePath] of frontier) {
      const source = topology.exchanges.get(exchangeName);
      if (!source) continue;
      exchangesExpanded++;
      const outgoing = topology.bindingsBySource.get(exchangeName);
      if (!outgoing) continue;
      for (const binding of outgoing) {
        bindingsEvaluated++;
        if (!bindingMatches(binding, source.kind, key)) continue;
        const path = Object.freeze([...basePath, binding.id]);
        if (binding.destinationKind === 'queue') {
          keepBest(queueCandidates, binding.destination, path);
        } else {
          keepBest(exchangeCandidates, binding.destination, path);
        }
      }
    }

    // A queue first reached at depth d cannot be improved deeper: path lengths
    // only grow with depth. Intra-depth ties are already resolved by keepBest.
    for (const [queueName, path] of queueCandidates) {
      if (!queues.has(queueName)) queues.set(queueName, path);
    }

    // Advance to not-yet-reached exchanges. Marking them reached here is what
    // makes normal cycles terminate instead of expanding paths forever.
    const next = new Map<string, readonly string[]>();
    for (const [exchangeName, path] of exchangeCandidates) {
      if (reachedExchanges.has(exchangeName)) continue;
      keepBest(next, exchangeName, path);
    }
    for (const exchangeName of next.keys()) reachedExchanges.add(exchangeName);
    frontier = next;
  }

  return { queues, stats: { exchangesExpanded, bindingsEvaluated } };
}
