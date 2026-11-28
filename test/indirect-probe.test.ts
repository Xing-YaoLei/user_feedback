import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/clock.ts';
import { InMemoryTransport } from '../src/transport.ts';
import { MembershipNode } from '../src/node.ts';
import type { NodeConfig } from '../src/types.ts';
import { advance, baseConfig, forcedTargetSelector } from './helpers.ts';

function makeNode(
  id: string,
  clock: VirtualClock,
  transport: InMemoryTransport,
  forced: () => string | undefined,
  peers: string[],
  overrides: Partial<NodeConfig> = {},
): MembershipNode {
  return new MembershipNode(
    baseConfig(id, forcedTargetSelector(forced), {
      bootstrapPeers: peers.filter((p) => p !== id),
      ...overrides,
    }),
    clock,
    transport,
  );
}

/**
 * Scenario 1: the direct link A<->D is down, but helper links are healthy.
 * A's direct ping times out, the indirect phase must still prove D alive via
 * a helper, so no suspicion is ever raised.
 */
test('scenario: direct link down, indirect probe succeeds via helper', () => {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const ids = ['A', 'B', 'C', 'D'];

  let forcedTarget = 'D';
  const a = makeNode('A', clock, transport, () => forcedTarget, ids);
  const b = makeNode('B', clock, transport, () => undefined, ids);
  const c = makeNode('C', clock, transport, () => undefined, ids);
  const d = makeNode('D', clock, transport, () => undefined, ids);
  const nodes = { A: a, B: b, C: c, D: d };

  // Break only the direct links between A and D (both directions).
  transport.setBidirectionalLink('A', 'D', 'down');

  // Let bootstrap digest exchanges settle first.
  advance(clock, 160);
  for (const id of ids) {
    assert.equal(nodes[id as keyof typeof nodes].getEntry(id)!.state, 'alive');
  }

  advance(clock, 130); // probeInterval(100) + directTimeout(20) + indirectTimeout(30)

  // A must have recorded an indirect success, and must never suspect D.
  const aEvents = a.getAuditLog().map((e) => e.event);
  assert.ok(aEvents.includes('probe-indirect-start'), 'indirect phase should start');
  assert.ok(
    aEvents.some((e) => e === 'probe-success'),
    'an indirect ack should complete the probe successfully',
  );
  assert.ok(!aEvents.includes('suspicion-raised'), 'no suspicion after indirect success');
  assert.equal(a.getEntry('D')!.state, 'alive');

  // The direct link genuinely dropped traffic.
  const stats = transport.getStats();
  assert.ok((stats.dropped ?? 0) > 0, 'direct-link packets should be dropped');

  // Restore the link: subsequent direct probing stays healthy.
  transport.setBidirectionalLink('A', 'D', 'up');
  forcedTarget = 'B'; // rotate A's attention; D stays alive throughout
  advance(clock, 300);
  assert.equal(a.getEntry('D')!.state, 'alive');
  assert.ok(!aEvents.includes('death-confirmed'));

  for (const n of Object.values(nodes)) n.close();
});
