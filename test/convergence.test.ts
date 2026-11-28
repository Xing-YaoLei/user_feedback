import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCluster, advance } from './helpers.ts';
import type { MemberUpdate, Message } from '../src/types.ts';

test('scenario: voluntary leave propagates, ends probing and dominates death', () => {
  const { clock, transport, nodes } = createCluster(['A', 'B', 'C', 'D']);
  advance(clock, 300); // let views converge

  const d = nodes.get('D')!;
  d.leave();
  assert.equal(d.isStopped(), false); // still attached to answer late messages
  advance(clock, 500);

  for (const [name, node] of nodes) {
    if (name === 'D') continue;
    const entry = node.getEntry('D')!;
    assert.equal(entry.state, 'left', `${name} should learn D left`);
  }

  // A later same-incarnation death gossip cannot override the leave.
  const staleDead: MemberUpdate = { id: 'D', incarnation: 1, seq: 0, state: 'dead' };
  const a = nodes.get('A')!;
  (a as unknown as { applyIncomingUpdates: (u: MemberUpdate[], s: string) => unknown })
    .applyIncomingUpdates([staleDead], 'late-peer');
  assert.equal(a.getEntry('D')!.state, 'left');

  // D stopped scheduling probes after leaving.
  const dEvents = d.getAuditLog().map((e) => e.event);
  const leaveIdx = dEvents.lastIndexOf('leave');
  const probesAfterLeave = dEvents
    .slice(leaveIdx)
    .filter((e) => e === 'probe-direct-start').length;
  assert.equal(probesAfterLeave, 0);

  void transport;
  for (const n of nodes.values()) n.close();
});

test('bounded piggyback: no message carries more than maxPiggyback updates', () => {
  const { clock, transport, nodes } = createCluster(['A', 'B', 'C', 'D', 'E']);
  advance(clock, 600);
  const overLimit = transport
    .getHistory()
    .filter((h) => h.result === 'delivered')
    .filter((h) => (h.msg as Message).updates.length > 2);
  assert.equal(overLimit.length, 0, 'every message must respect maxPiggyback=2');
  for (const n of nodes.values()) n.close();
});

test('bounded pending queue: queue length never exceeds maxPendingQueue', () => {
  const { clock, nodes } = createCluster(['A', 'B', 'C', 'D', 'E', 'F']);
  advance(clock, 800);
  for (const node of nodes.values()) {
    assert.ok(
      node.getPendingQueue().length <= 4,
      `node ${node.id} pending queue exceeded cap: ${node.getPendingQueue().length}`,
    );
  }
  // Eviction events are audited whenever pressure occurs.
  const evictions = [...nodes.values()].flatMap((n) =>
    n.getAuditLog().filter((e) => e.event === 'pending-evict'),
  );
  assert.ok(evictions.length > 0, 'queue pressure should have caused bounded evictions');
  for (const n of nodes.values()) n.close();
});

test('convergence: stable network, all alive nodes agree on identities and states', () => {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const { clock, nodes } = createCluster(ids);
  // Long enough for round-robin probing and digest anti-entropy to cover all pairs.
  advance(clock, 2500);

  const reference = new Map<string, MemberUpdate>();
  for (const id of ids) reference.set(id, nodes.get(id)!.getEntry(id)!);

  for (const [observerName, observer] of nodes) {
    for (const id of ids) {
      const entry = observer.getEntry(id);
      assert.ok(entry, `${observerName} is missing member ${id}`);
      const expected = reference.get(id)!;
      assert.equal(entry!.incarnation, expected.incarnation, `${observerName}:${id} incarnation`);
      assert.equal(entry!.seq, expected.seq, `${observerName}:${id} seq`);
      assert.equal(entry!.state, 'alive', `${observerName}:${id} state`);
    }
  }
  for (const n of nodes.values()) n.close();
});

test('digest exchange repairs an update that piggyback limits caused to be missed', () => {
  const { clock, nodes } = createCluster(['A', 'B', 'C']);
  advance(clock, 200);
  // Every node must eventually learn every other node despite maxPiggyback=2.
  for (const [observerName, observer] of nodes) {
    for (const id of ['A', 'B', 'C']) {
      const entry = observer.getEntry(id);
      assert.ok(entry, `${observerName} should eventually know ${id} via digest repair`);
    }
  }
  for (const n of nodes.values()) n.close();
});
