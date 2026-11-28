import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/clock.ts';
import { InMemoryTransport } from '../src/transport.ts';
import { MembershipNode } from '../src/node.ts';
import { advance, baseConfig, forcedTargetSelector } from './helpers.ts';
import type { MemberUpdate } from '../src/types.ts';

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

test('scenario: confirmed death, same-id restart with higher incarnation, stale gossip reflow', () => {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const ids = ['A', 'B', 'C', 'D'];
  const a = makeNode('A', clock, transport, () => 'D', ids);
  const b = makeNode('B', clock, transport, () => undefined, ids);
  const c = makeNode('C', clock, transport, () => undefined, ids);
  const d = makeNode('D', clock, transport, () => undefined, ids);

  advance(clock, 160);
  transport.pauseNode('D');
  advance(clock, 450);

  // D is confirmed dead (incarnation 1) on the surviving nodes.
  for (const node of [a, b, c]) {
    const entry = node.getEntry('D')!;
    assert.equal(entry.state, 'dead');
    assert.equal(entry.incarnation, 1);
  }

  // D comes back under the SAME stable id with a strictly greater incarnation.
  transport.resumeNode('D');
  // Drain the late messages from the old incarnation before restarting so the
  // restart starts from a clean local state.
  advance(clock, 50);
  d.restart(2);
  assert.deepEqual(d.selfIdentity(), { id: 'D', incarnation: 2, seq: 0 });

  // Gossip + digest exchange must propagate the new identity everywhere.
  // Round-robin selection visits every peer; allow enough periods for all.
  advance(clock, 900);
  for (const [name, node] of [['A', a], ['B', b], ['C', c]] as const) {
    const entry = node.getEntry('D')!;
    assert.equal(entry.incarnation, 2, `${name} should learn incarnation 2`);
    assert.equal(entry.state, 'alive', `${name} should see restarted D alive`);
  }

  // Old-incarnation gossip keeps flowing back (simulated by re-injecting
  // copies of the dead incarnation-1 record through every surviving node).
  const staleDead: MemberUpdate = { id: 'D', incarnation: 1, seq: 0, state: 'dead' };
  const staleAlive: MemberUpdate = { id: 'D', incarnation: 1, seq: 0, state: 'alive' };
  const staleSuspect: MemberUpdate = {
    id: 'D',
    incarnation: 1,
    seq: 0,
    state: 'suspected',
    suspectDeadline: clock.now() + 1000,
  };
  for (let round = 0; round < 5; round++) {
    for (const node of [a, b, c]) {
      (node as unknown as {
        applyIncomingUpdates: (u: MemberUpdate[], s: string) => unknown;
      }).applyIncomingUpdates([staleDead, staleAlive, staleSuspect], 'stale-peer');
    }
  }
  // Stale records can never roll the current identity backwards.
  for (const [name, node] of [['A', a], ['B', b], ['C', c]] as const) {
    const entry = node.getEntry('D')!;
    assert.equal(entry.incarnation, 2, `${name} must stay on incarnation 2`);
    assert.equal(entry.state, 'alive', `${name} must keep D alive`);
  }

  // The audit trail explains suspicion, death and the incarnation override.
  const events = a.getAuditLog().map((e) => e.event);
  assert.ok(events.includes('suspicion-raised'));
  assert.ok(events.includes('death-confirmed'));
  assert.ok(
    a.getAuditLog().some(
      (e) => e.event === 'alive-accepted' && e.detail.member === 'D' && e.detail.incarnation === 2,
    ),
    'incarnation-2 restart must be audited as an override',
  );

  for (const n of [a, b, c, d]) n.close();
});

test('repeated gossip of the same suspicion does not extend the deadline', () => {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const a = makeNode('A', clock, transport, () => undefined, ['B']);
  const suspicion: MemberUpdate = {
    id: 'B',
    incarnation: 1,
    seq: 0,
    state: 'suspected',
    suspectDeadline: clock.now() + 200,
  };
  (a as unknown as { applyIncomingUpdates: (u: MemberUpdate[], s: string) => unknown })
    .applyIncomingUpdates([suspicion], 'peer-1');
  const firstDeadline = a.getEntry('B')!.suspectDeadline!;

  // Re-gossip the same suspicion repeatedly with ever-later proposed deadlines.
  for (let i = 1; i <= 5; i++) {
    (a as unknown as { applyIncomingUpdates: (u: MemberUpdate[], s: string) => unknown })
      .applyIncomingUpdates(
        [{ ...suspicion, suspectDeadline: firstDeadline + i * 500 }],
        `peer-${i}`,
      );
  }
  assert.equal(a.getEntry('B')!.suspectDeadline, firstDeadline);
  assert.ok(
    a.getAuditLog().filter((e) => e.event === 'duplicate-suspect-ignored').length >= 5,
  );
  a.close();
});

test('a higher-seq suspicion in the same incarnation supersedes the old one', () => {
  const clock = new VirtualClock();
  const transport = new InMemoryTransport(clock);
  const a = makeNode('A', clock, transport, () => undefined, ['B']);
  const first: MemberUpdate = {
    id: 'B',
    incarnation: 1,
    seq: 0,
    state: 'suspected',
    suspectDeadline: clock.now() + 200,
  };
  (a as unknown as { applyIncomingUpdates: (u: MemberUpdate[], s: string) => unknown })
    .applyIncomingUpdates([first], 'peer-1');
  assert.equal(a.getEntry('B')!.seq, 0);

  // B refuted once (seq 1 alive), then a new suspicion against seq 1 arrives.
  const refuted: MemberUpdate = { id: 'B', incarnation: 1, seq: 1, state: 'alive' };
  const nextSuspicion: MemberUpdate = {
    id: 'B',
    incarnation: 1,
    seq: 1,
    state: 'suspected',
    suspectDeadline: clock.now() + 400,
  };
  (a as unknown as { applyIncomingUpdates: (u: MemberUpdate[], s: string) => unknown })
    .applyIncomingUpdates([refuted, nextSuspicion], 'peer-2');

  const entry = a.getEntry('B')!;
  assert.equal(entry.state, 'suspected');
  assert.equal(entry.seq, 1, 'the suspicion must bind to the newer declaration seq');
  a.close();
});
