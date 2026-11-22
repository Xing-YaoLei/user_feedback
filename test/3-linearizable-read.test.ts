import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setCmd } from '../src/kv.ts';
import { RaftError } from '../src/types.ts';
import {
  makeHarness,
  waitForApply,
  waitForLeader,
} from './helpers.ts';

test('leader read returns the applied state after quorum confirmation', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 51 });
  try {
    const leader = await waitForLeader(h);
    const e = await leader.write(setCmd('k', 'v'));
    await waitForApply(h, e.index);

    const state = await leader.read();
    assert.deepEqual(state, { k: 'v' });
  } finally {
    h.cleanup();
  }
});

test('a partitioned self-proclaimed leader cannot complete a read', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 57 });
  try {
    const leader = await waitForLeader(h);
    const e = await leader.write(setCmd('k', 'v'));
    await waitForApply(h, e.index);

    // Cut the leader off from both followers: it keeps calling itself leader
    // but can no longer confirm leadership in the current term.
    h.network.isolateAll(leader.id);

    await assert.rejects(
      () => leader.read(600),
      (err: unknown) => err instanceof RaftError && err.code === 'TIMEOUT',
    );

    // The other quorum elects a successor and accepts writes the old leader
    // can neither see nor serve reads against.
    await h.scheduler.advance(600);
    const leaders = [...h.nodes.values()].filter(
      (n) => n.running && n.api.getRole() === 'leader' && n.id !== leader.id,
    );
    assert.equal(leaders.length, 1);
    const newLeader = leaders[0].api;
    const e2 = await newLeader.write(setCmd('k2', 'v2'));
    await waitForApply(h, e2.index, [leader.id]);

    // Old leader's read must still fail: no quorum, no stale success.
    await assert.rejects(
      () => leader.read(300),
      (err: unknown) => err instanceof RaftError,
    );
  } finally {
    h.cleanup();
  }
});

test('read after recovery observes all previously committed writes', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 63 });
  try {
    const leader = await waitForLeader(h);
    const e1 = await leader.write(setCmd('one', '1'));
    await waitForApply(h, e1.index);
    h.network.isolateAll(leader.id);
    await h.scheduler.advance(600);
    const newLeader = [...h.nodes.values()].find(
      (n) => n.running && n.api.getRole() === 'leader' && n.id !== leader.id,
    )!.api;
    const e2 = await newLeader.write(setCmd('two', '2'));
    await waitForApply(h, e2.index, [leader.id]);

    h.network.healAll(leader.id);
    await h.scheduler.advance(500);

    const stableLeader = (await waitForLeader(h)) as typeof newLeader;
    const state = await stableLeader.read();
    assert.deepEqual(state, { one: '1', two: '2' });
  } finally {
    h.cleanup();
  }
});
