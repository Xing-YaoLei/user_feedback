import { VirtualClock } from '../src/clock.ts';
import { InMemoryTransport } from '../src/transport.ts';
import { MembershipNode, createRoundRobinSelectors } from '../src/node.ts';
import type { NodeConfig, Selectors } from '../src/types.ts';

/** Shared timing/cap configuration used by the cluster tests. */
export function baseConfig(
  id: string,
  selectors: Selectors = createRoundRobinSelectors(),
  overrides: Partial<NodeConfig> = {},
): NodeConfig {
  return {
    id,
    probeInterval: 100,
    directTimeout: 20,
    indirectTimeout: 30,
    indirectHelpers: 2,
    suspectTimeout: 200,
    digestInterval: 150,
    maxPiggyback: 2,
    maxPendingQueue: 4,
    selectors,
    ...overrides,
  };
}

export interface Cluster {
  clock: VirtualClock;
  transport: InMemoryTransport;
  nodes: Map<string, MembershipNode>;
}

export function createCluster(ids: string[], overrides: Partial<NodeConfig> = {}): Cluster {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const nodes = new Map<string, MembershipNode>();
  for (const id of ids) {
    const node = new MembershipNode(
      baseConfig(id, createRoundRobinSelectors(), {
        bootstrapPeers: ids.filter((p) => p !== id),
        ...overrides,
      }),
      clock,
      transport,
    );
    nodes.set(id, node);
  }
  return { clock, transport, nodes };
}

/**
 * A selector whose direct-probe target and digest peer are forced to a given
 * node, while helper selection still rotates deterministically.
 */
export function forcedTargetSelector(forced: () => string | undefined): Selectors {
  let helperCursor = 0;
  let digestCursor = 0;
  return {
    // Only the direct-probe target is forced (for deterministic scenarios).
    pickTarget: () => forced(),
    pickHelpers: (candidates, targetId, n) => {
      const pool = candidates.filter((c) => c !== targetId);
      const count = Math.min(n, pool.length);
      const picked: string[] = [];
      for (let i = 0; i < count; i++) {
        picked.push(pool[(helperCursor + i) % pool.length]!);
      }
      if (pool.length > 0) helperCursor++;
      return picked;
    },
    // Digest peers rotate so every neighbor is reached, including nodes this
    // node currently believes dead (needed to learn higher-incarnation restarts).
    pickDigestPeer: (candidates) => {
      if (candidates.length === 0) return undefined;
      const pick = candidates[digestCursor % candidates.length]!;
      digestCursor++;
      return pick;
    },
  };
}

export function nodeWithForcedTarget(
  id: string,
  clock: VirtualClock,
  transport: InMemoryTransport,
  forced: () => string | undefined,
  bootstrapPeers: string[],
  overrides: Partial<NodeConfig> = {},
): MembershipNode {
  return new MembershipNode(
    baseConfig(id, forcedTargetSelector(forced), { bootstrapPeers, ...overrides }),
    clock,
    transport,
  );
}

/** Advance virtual time in small steps so zero-delay message chains run fully. */
export function advance(clock: VirtualClock, ms: number, step = 5): void {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(step, remaining);
    clock.advance(chunk);
    remaining -= chunk;
  }
}

export function auditEvents(node: MembershipNode, event: string): string[] {
  return node.getAuditLog().filter((e) => e.event === event).map((e) => e.event);
}
