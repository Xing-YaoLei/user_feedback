/**
 * Topology compilation.
 *
 * A `TopologyInput` is validated once and turned into an immutable snapshot.
 * All lookup structures are frozen arrays/maps; routing never mutates a
 * snapshot, and replacing a topology swaps the reference atomically.
 */

import { parseTopicPattern, validateLiteralKey } from './matching.ts';
import { RouterError } from './types.ts';
import type {
  BindingDefinition,
  DestinationKind,
  ExchangeDefinition,
  ExchangeKind,
  QueueDefinition,
  ResolvedBinding,
  Topology,
  TopologyInput,
} from './types.ts';

const EXCHANGE_KINDS: ReadonlySet<string> = new Set(['direct', 'fanout', 'topic']);

function fail(message: string): never {
  throw new RouterError('INVALID_TOPOLOGY', message);
}

function assertName(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${what} must be a non-empty string`);
  }
}

/**
 * Compare two binding-id paths. Shorter wins; among equal lengths the
 * lexicographically smaller id sequence wins.
 */
export function compareBindingPaths(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length) return a.length - b.length;
  const limit = a.length;
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Validate and compile a topology description into an immutable snapshot.
 *
 * Throws `RouterError` with code `INVALID_TOPOLOGY` for any structural
 * problem: unknown exchanges/queues, duplicate names or ids, malformed topic
 * patterns, or alternate-exchange references to missing exchanges.
 */
export function compileTopology(input: TopologyInput): Topology {
  if (input === null || typeof input !== 'object') {
    fail('topology must be an object');
  }

  const exchangeDefs = input.exchanges ?? [];
  const queueDefs = input.queues ?? [];
  const bindingDefs = input.bindings ?? [];

  const exchanges = new Map<string, ExchangeDefinition>();
  for (const definition of exchangeDefs) {
    if (definition === null || typeof definition !== 'object') fail('exchange entry must be an object');
    assertName(definition.name, 'exchange name');
    if (exchanges.has(definition.name)) fail(`duplicate exchange "${definition.name}"`);
    if (!EXCHANGE_KINDS.has(definition.kind)) {
      fail(`exchange "${definition.name}" has invalid kind "${String(definition.kind)}"`);
    }
    exchanges.set(definition.name, Object.freeze({ ...definition }));
  }

  const queueNames = new Set<string>();
  for (const definition of queueDefs as readonly QueueDefinition[]) {
    if (definition === null || typeof definition !== 'object') fail('queue entry must be an object');
    assertName(definition.name, 'queue name');
    if (queueNames.has(definition.name)) fail(`duplicate queue "${definition.name}"`);
    queueNames.add(definition.name);
  }

  for (const definition of exchanges.values()) {
    const alternate = definition.alternateExchange;
    if (alternate === undefined || alternate === null) continue;
    assertName(alternate, `alternate of exchange "${definition.name}"`);
    if (!exchanges.has(alternate)) {
      fail(`exchange "${definition.name}" names unknown alternate "${alternate}"`);
    }
  }

  const seenIds = new Set<string>();
  const resolved: ResolvedBinding[] = [];
  for (const definition of bindingDefs as readonly BindingDefinition[]) {
    if (definition === null || typeof definition !== 'object') fail('binding entry must be an object');
    assertName(definition.id, 'binding id');
    if (seenIds.has(definition.id)) fail(`duplicate binding id "${definition.id}"`);
    seenIds.add(definition.id);
    assertName(definition.source, `source of binding "${definition.id}"`);
    assertName(definition.destination, `destination of binding "${definition.id}"`);

    const sourceExchange = exchanges.get(definition.source);
    if (!sourceExchange) {
      fail(`binding "${definition.id}" has unknown source exchange "${definition.source}"`);
    }

    let destinationKind: DestinationKind;
    if (definition.destinationKind === 'queue') {
      if (!queueNames.has(definition.destination)) {
        fail(`binding "${definition.id}" has unknown destination queue "${definition.destination}"`);
      }
      destinationKind = 'queue';
    } else if (definition.destinationKind === 'exchange') {
      if (!exchanges.has(definition.destination)) {
        fail(`binding "${definition.id}" has unknown destination exchange "${definition.destination}"`);
      }
      destinationKind = 'exchange';
    } else if (definition.destinationKind === undefined) {
      // Infer only when the destination name is unambiguous.
      const isQueue = queueNames.has(definition.destination);
      const isExchange = exchanges.has(definition.destination);
      if (isQueue === isExchange) {
        fail(
          `binding "${definition.id}" must set destinationKind: destination "${definition.destination}" is ` +
            (isQueue ? 'both a queue and an exchange' : 'neither a queue nor an exchange'),
        );
      }
      destinationKind = isQueue ? 'queue' : 'exchange';
    } else {
      fail(
        `binding "${definition.id}" has invalid destinationKind "${String(definition.destinationKind)}"`,
      );
    }

    const kind: ExchangeKind = sourceExchange.kind;
    const rawKey = definition.routingKey ?? '';
    let routingKey: string;
    let pattern: ResolvedBinding['pattern'];
    if (kind === 'topic') {
      try {
        pattern = parseTopicPattern(rawKey, `binding "${definition.id}"`);
      } catch (error) {
        // Report every structural problem in a topology as INVALID_TOPOLOGY.
        if (error instanceof RouterError) fail(error.message);
        throw error;
      }
      routingKey = rawKey;
    } else if (kind === 'direct') {
      routingKey = validateLiteralKey(rawKey, `binding "${definition.id}"`);
    } else {
      // Fanout ignores binding keys, but still store what the caller gave.
      if (typeof rawKey !== 'string') fail(`binding "${definition.id}" routingKey must be a string`);
      routingKey = rawKey;
    }

    const resolvedBinding: ResolvedBinding = {
      id: definition.id,
      source: definition.source,
      destination: definition.destination,
      destinationKind,
      routingKey,
      ...(pattern ? { pattern } : {}),
    };
    resolved.push(Object.freeze(resolvedBinding));
  }

  // Deterministic ordering: binding id ascending. Routing also compares ids,
  // but a stable canonical order keeps iteration reproducible.
  resolved.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const bySource = new Map<string, ResolvedBinding[]>();
  for (const binding of resolved) {
    let list = bySource.get(binding.source);
    if (!list) {
      list = [];
      bySource.set(binding.source, list);
    }
    list.push(binding);
  }
  for (const [source, list] of bySource) {
    bySource.set(source, Object.freeze(list.slice()));
  }

  return Object.freeze({
    exchanges,
    queueNames,
    bindings: Object.freeze(resolved),
    bindingsBySource: bySource,
  });
}
