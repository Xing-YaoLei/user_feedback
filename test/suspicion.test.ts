import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/clock.ts';
import { InMemoryTransport } from '../src/transport.ts';
import { MembershipNode } from '../src/node.ts';
import { advance, baseConfig, forcedTargetSelector } from './helpers.ts';

function makeNode(
  id: string,
  clock: VirtualClock,
  transport: InMemoryTransport,
  forced: () => string | undefined,
  peers: string[],
): MembershipNode {
  return new MembershipNode(
    baseConfig(id, forcedTargetSelector(forced), {
      bootstrapPeers: peers.filter((p) => p !== id),
    }),
    clock,
    transport,
  );
}

/**
 * Scenario 2a: D is paused long enough to be suspected, but resumes BEFORE the
 * bounded suspicion deadline. It must refute with a higher alive seq and every
 * node must converge back to alive; no death is confirmed.
 */
test('scenario: suspected node resumes before deadline and refutes with higher seq', () => {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const ids = ['A', 'B', 'C', 'D'];
  const a = makeNode('A', clock, transport, () => 'D', ids);
  const b = makeNode('B', clock, transport, () => undefined, ids);
  const c = makeNode('C', clock, transport, () => undefined, ids);
  const d = makeNode('D', clock, transport, () => undefined, ids);
  const nodes = { A: a, B: b, C: c, D: d };

  advance(clock, 160); // bootstrap digest convergence
  // Isolate D completely: all traffic to/from D is held in order.
  transport.pauseNode('D');

  // direct(20) + indirect(30) => suspicion at ~50 after the next probe start.
  advance(clock, 200);
  assert.equal(a.getEntry('D')!.state, 'suspected');
  const deadline = a.getEntry('D')!.suspectDeadline!;
  assert.ok(deadline > clock.now(), 'suspicion must still be within its window');

  // Resume D while the suspicion is still active. Held messages arrive late.
  transport.resumeNode('D');
  // D receives the held suspicion (via piggyback/digest), refutes, and gossip
  // plus digest exchange propagate the higher-seq alive record.
  advance(clock, 300);

  assert.equal(d.selfIdentity().seq > 0, true);
  const dSeq = d.selfIdentity().seq;
  assert.ok(dSeq >= 1, 'D must have bumped its alive-declaration seq');

  for (const [name, node] of Object.entries(nodes)) {
    const entry = node.getEntry('D')!;
    assert.equal(entry.state, 'alive', `${name} should see D alive again`);
    assert.equal(entry.incarnation, 1, `${name} should keep the same incarnation`);
    assert.ok(entry.seq >= dSeq, `${name} should learn the refutation seq`);
  }

  // Advance well past the original deadline: the refutation must hold.
  advance(clock, 400);
  for (const node of Object.values(nodes)) {
    assert.equal(node.getEntry('D')!.state, 'alive');
  }
  assert.ok(
    !a.getAuditLog().some((e) => e.event === 'death-confirmed' && e.detail.member === 'D'),
    'no death may be confirmed after a successful refutation',
  );
  assert.ok(d.getAuditLog().some((e) => e.event === 'refutation'));

  for (const n of Object.values(nodes)) n.close();
});

/**
 * Scenario 2b: D stays isolated beyond the suspicion window. The suspicion
 * must convert to a bounded, explainable death decision.
 */
test('scenario: unrefuted suspicion converts to death after the bounded window', () => {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const ids = ['A', 'B', 'C', 'D'];
  const a = makeNode('A', clock, transport, () => 'D', ids);
  const b = makeNode('B', clock, transport, () => undefined, ids);
  const c = makeNode('C', clock, transport, () => undefined, ids);
  const d = makeNode('D', clock, transport, () => undefined, ids);

  advance(clock, 160);
  transport.pauseNode('D');
  // probe 50ms to suspicion + 200ms suspect window, with margin.
  advance(clock, 450);

  assert.equal(a.getEntry('D')!.state, 'dead');
  const death = a.getAuditLog().find((e) => e.event === 'death-confirmed');
  assert.ok(death, 'death decision must be audited');
  assert.equal(death!.detail.member, 'D');
  assert.equal(death!.detail.incarnation, 1);

  for (const n of [a, b, c, d]) n.close();
});
