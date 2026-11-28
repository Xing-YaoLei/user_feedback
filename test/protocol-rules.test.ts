import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/clock.ts';
import { InMemoryTransport } from '../src/transport.ts';
import { MembershipNode, createRoundRobinSelectors } from '../src/node.ts';
import { advance, baseConfig } from './helpers.ts';
import type { MemberUpdate, Message } from '../src/types.ts';

function standaloneNode(
  id: string,
  clock: VirtualClock,
  transport: InMemoryTransport,
  bootstrapPeers: string[] = [],
): MembershipNode {
  return new MembershipNode(
    baseConfig(id, createRoundRobinSelectors(), { bootstrapPeers }),
    clock,
    transport,
  );
}

test('late ack for an older identity is ignored and cannot roll state backwards', () => {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const node = standaloneNode('X', clock, transport);

  // Current view: member Y at incarnation 2, seq 3, alive.
  const current: MemberUpdate = { id: 'Y', incarnation: 2, seq: 3, state: 'alive' };
  (node as unknown as { applyIncomingUpdates: (u: MemberUpdate[], s: string) => unknown })
    .applyIncomingUpdates([current], 'bootstrap');

  // A late ack from an old round, binding the old incarnation-1 identity.
  const lateAck = {
    kind: 'ack',
    from: 'Y',
    target: 'Y',
    round: 999,
    incarnation: 1,
    seq: 0,
    updates: [],
    digest: [],
  } as Message;

  // No outstanding probe round 999: it must be recorded as stale and ignored.
  (node as unknown as { handleMessage: (m: Message) => void }).handleMessage(lateAck);
  assert.ok(node.getAuditLog().some((e) => e.event === 'stale-ack-ignored'));
  assert.deepEqual(node.getEntry('Y'), current);

  // Even gossip riding the late ack with the old identity is rejected.
  const staleGossip: MemberUpdate = { id: 'Y', incarnation: 1, seq: 9, state: 'alive' };
  (node as unknown as { applyIncomingUpdates: (u: MemberUpdate[], s: string) => unknown })
    .applyIncomingUpdates([staleGossip], 'late-peer');
  assert.equal(node.getEntry('Y')!.incarnation, 2);
  assert.equal(node.getEntry('Y')!.seq, 3);

  node.close();
});

test('leave and dead both terminate probing of that identity', () => {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const a = standaloneNode('A', clock, transport, ['B', 'C']);
  const b = standaloneNode('B', clock, transport, ['A', 'C']);
  const c = standaloneNode('C', clock, transport, ['A', 'B']);

  advance(clock, 250);
  // B leaves voluntarily.
  b.leave();
  advance(clock, 500);

  assert.equal(a.getEntry('B')!.state, 'left');
  // A must not keep launching probes at the terminated identity. The audit
  // trail may contain earlier probes, but none after the leave was learned.
  const aLog = a.getAuditLog();
  const learnLeaveAt = aLog.find((e) => e.event === 'left-accepted' && e.detail.member === 'B')?.at;
  assert.ok(learnLeaveAt !== undefined);
  const probesAfter = aLog.filter(
    (e) => e.event === 'probe-direct-start' && e.detail.target === 'B' && e.at > learnLeaveAt!,
  );
  assert.equal(probesAfter.length, 0);

  // Dead is likewise terminal: drive C to dead on A by injecting the record.
  const deadC: MemberUpdate = { id: 'C', incarnation: 1, seq: 0, state: 'dead' };
  const deadAt = clock.now();
  (a as unknown as { applyIncomingUpdates: (u: MemberUpdate[], s: string) => unknown })
    .applyIncomingUpdates([deadC], 'local-decision');
  assert.equal(a.getEntry('C')!.state, 'dead');
  advance(clock, 400);
  const probesToDeadC = a
    .getAuditLog()
    .filter((e) => e.event === 'probe-direct-start' && e.detail.target === 'C' && e.at > deadAt);
  assert.equal(probesToDeadC.length, 0);

  for (const n of [a, b, c]) n.close();
});

test('audit trail explains every suspicion, refutation and death decision', () => {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const a = standaloneNode('A', clock, transport, ['D']);
  const d = standaloneNode('D', clock, transport, ['A']);

  advance(clock, 200);
  transport.pauseNode('D');
  advance(clock, 300); // suspicion raised on A
  const suspicion = a.getAuditLog().find((e) => e.event === 'suspicion-raised');
  assert.ok(suspicion);
  assert.equal(suspicion!.detail.member, 'D');
  assert.equal(typeof suspicion!.detail.deadline, 'number');

  // D receives the held suspicion and refutes.
  transport.resumeNode('D');
  advance(clock, 300);
  const refutation = d.getAuditLog().find((e) => e.event === 'refutation');
  assert.ok(refutation, 'refutation must be audited with the seq it refuted');
  assert.equal(typeof refutation!.detail.newSeq, 'number');
  assert.ok((refutation!.detail.newSeq as number) > (refutation!.detail.againstSeq as number));

  // Isolate again past the window and confirm the death decision is explained.
  transport.pauseNode('D');
  advance(clock, 500);
  const death = a.getAuditLog().find((e) => e.event === 'death-confirmed');
  assert.ok(death);
  assert.equal(death!.detail.member, 'D');
  assert.equal(typeof death!.detail.incarnation, 'number');
  assert.equal(typeof death!.detail.deadline, 'number');

  // Every audit entry is timestamped and attributed to a node.
  for (const entry of a.getAuditLog()) {
    assert.equal(typeof entry.at, 'number');
    assert.equal(entry.nodeId, 'A');
    assert.equal(typeof entry.event, 'string');
  }

  for (const n of [a, d]) n.close();
});
