import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setCmd } from '../src/kv.ts';
import { RaftError } from '../src/types.ts';
import {
  assertCommittedState,
  assertLogsConverged,
  commandEntries,
  makeHarness,
  waitForApply,
  waitForLeader,
  writeThroughLeader,
} from './helpers.ts';

test('a unique leader is elected and heartbeats stabilise the term', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 1 });
  try {
    const l = await waitForLeader(h);
    const termAtElection = l.getTerm();
    await h.scheduler.advance(400);
    const leaders = [...h.nodes.values()].filter(
      (n) => n.running && n.api.getRole() === 'leader',
    );
    assert.equal(leaders.length, 1);
    assert.equal(leaders[0].id, l.id);
    assert.equal(l.getTerm(), termAtElection);
    for (const n of h.nodes.values()) {
      assert.equal(n.api.getTerm(), termAtElection);
    }
  } finally {
    h.cleanup();
  }
});

test('commands are replicated to a majority and applied identically', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 7 });
  try {
    const leader = await waitForLeader(h);
    const e1 = await leader.write(setCmd('k1', 'v1'));
    const e2 = await leader.write(setCmd('k2', 'v2'));
    assert.ok(e2.index === e1.index + 1);
    await waitForApply(h, e2.index);

    const committed = commandEntries(h);
    assert.deepEqual(
      committed.map((e) => e.command),
      [setCmd('k1', 'v1'), setCmd('k2', 'v2')],
    );
    assertCommittedState(h, { k1: 'v1', k2: 'v2' });
    assertLogsConverged(h);
  } finally {
    h.cleanup();
  }
});

test('a follower rejects client writes', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 11 });
  try {
    await waitForLeader(h);
    const follower = [...h.nodes.values()].find(
      (n) => n.api.getRole() === 'follower',
    )!;
    await assert.rejects(
      () => follower.api.write(setCmd('x', 'y')),
      (err: unknown) => err instanceof RaftError && err.code === 'NOT_LEADER',
    );
  } finally {
    h.cleanup();
  }
});

test('minority partition cannot commit; healing the quorum resumes progress', async () => {
  // Five nodes let the leader keep exactly one peer (2/5, no majority).
  const h = makeHarness(['n1', 'n2', 'n3', 'n4', 'n5'], { seed: 23 });
  try {
    const leader = await waitForLeader(h);
    const before = await leader.write(setCmd('stable', '1'));
    await waitForApply(h, before.index);
    const commitBefore = leader.getCommitIndex();

    // Isolate the leader together with exactly one follower: two of five,
    // which cannot form a majority on either elections or commits.
    const peers = [...h.nodes.keys()].filter((id) => id !== leader.id);
    const isolatedPeer = peers[0];
    const outside = peers.slice(1);
    for (const id of outside) {
      h.network.isolate(leader.id, id);
      h.network.isolate(isolatedPeer, id);
    }

    // A write attempted by the quorum-less side cannot be acknowledged in
    // time; it must time out rather than report a commit.
    await assert.rejects(
      () => leader.write(setCmd('partitioned', 'x'), 400),
      (err: unknown) => err instanceof RaftError && err.code === 'TIMEOUT',
    );
    // Nothing new was committed on the minority side during the partition.
    assert.equal(leader.getCommitIndex(), commitBefore);
    for (const id of outside) {
      assert.equal(
        (h.nodes.get(id)!.api.getAppliedState() as Record<string, string>)
          .partitioned,
        undefined,
      );
    }

    // Heal: the majority side may already have elected a new leader, so the
    // cluster resumes through whoever currently holds leadership.
    for (const id of outside) {
      h.network.heal(leader.id, id);
      h.network.heal(isolatedPeer, id);
    }
    await writeThroughLeader(h, setCmd('healed', '2'));
    assertCommittedState(h, { stable: '1', healed: '2' } as Record<string, string>);
    assertLogsConverged(h);
  } finally {
    h.cleanup();
  }
});
