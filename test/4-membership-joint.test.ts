import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addNode, makeHarness, waitForApply, waitForLeader } from './helpers.ts';
import { setCmd } from '../src/kv.ts';
import { RaftError } from '../src/types.ts';

test('joint consensus adds a node: catch-up, joint majority, final config', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 71 });
  try {
    const leader = await waitForLeader(h);
    for (let i = 0; i < 3; i++) {
      const e = await leader.write(setCmd(`pre${i}`, `${i}`));
      await waitForApply(h, e.index);
    }

    addNode(h, 'n4'); // starts unconfigured; receives no traffic yet
    const target = ['n1', 'n2', 'n3', 'n4'];
    const finalConfig = await leader.changeConfig(target);

    assert.deepEqual([...finalConfig.voters].sort(), target);
    await waitForApply(h, finalConfig.id);
    for (const n of h.nodes.values()) {
      assert.deepEqual([...n.api.getConfig().voters].sort(), target);
      assert.equal(n.api.getConfig().joint, undefined);
      // The newcomer had to catch up the pre-existing log first.
      assert.ok(n.api.getLastApplied() >= finalConfig.id);
    }

    // Writes continue under the 4-node configuration.
    const e = await leader.write(setCmd('after', 'ok'));
    await waitForApply(h, e.index);
    assert.equal(
      (h.nodes.get('n4')!.api.getAppliedState() as Record<string, string>).after,
      'ok',
    );
  } finally {
    h.cleanup();
  }
});

test('concurrent membership changes are rejected (one at a time)', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 73 });
  try {
    const leader = await waitForLeader(h);
    addNode(h, 'n4');
    addNode(h, 'n5');

    const first = leader.changeConfig(['n1', 'n2', 'n3', 'n4'], 3000);
    // The joint entry appends synchronously, so a second attempt sees it.
    const second = leader.changeConfig(['n1', 'n2', 'n3', 'n5'], 3000);
    await assert.rejects(
      second,
      (err: unknown) => err instanceof RaftError && err.code === 'CONFIG_BUSY',
    );
    const cfg = await first;
    assert.deepEqual([...cfg.voters].sort(), ['n1', 'n2', 'n3', 'n4']);
  } finally {
    h.cleanup();
  }
});

/**
 * The headline scenario: during the JOINT phase of a membership replacement
 *   1. isolate the old leader (which the target config removes),
 *   2. restart one voting node from its durable directory,
 *   3. deliver messages held back before the partition,
 *   4. verify quorum boundaries on reads and writes,
 *   5. heal, run to convergence and check the full history and reads.
 */
test('joint-phase replacement: isolate old leader, restart a voter, replay held messages', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 79 });
  try {
    const oldLeader = await waitForLeader(h);
    const initial = await oldLeader.write(setCmd('c1', '1'));
    await waitForApply(h, initial.index);

    // New member starts unconfigured; the target set removes the old leader.
    addNode(h, 'n4');
    const remainingVoters = h.config.voters.filter((id) => id !== oldLeader.id);
    const targetVoters = [...remainingVoters, 'n4'].sort();

    let jointSeen = false;
    let termAtIsolation = 0;
    // The changeConfig pump is the single driver of virtual time. Its
    // onJointCommitted callback fires at the exact joint-commit instant and
    // injects the whole fault sequence synchronously.
    const change = oldLeader
      .changeConfig(targetVoters, {
        timeoutMs: 1500,
        onJointCommitted: (joint) => {
          jointSeen = true;
          termAtIsolation = oldLeader.getTerm();
          assert.deepEqual([...joint.joint!.oldVoters].sort(), ['n1', 'n2', 'n3']);
          assert.deepEqual([...joint.joint!.newVoters].sort(), targetVoters);

          // From this instant retain the old leader's outbound traffic, so the
          // heartbeats it still emits while believing it is leader become the
          // "previously held" messages replayed after the partition.
          for (const id of h.config.voters) {
            if (id !== oldLeader.id) h.network.hold(oldLeader.id, id);
          }

          /* 1. isolate the old leader exactly in the joint phase */
          h.network.isolateAll(oldLeader.id);

          /* 2. restart one joint-phase voter from its durable directory */
          const restartedId = remainingVoters[0];
          const restarted = h.nodes.get(restartedId)!;
          const termBefore = restarted.api.getTerm();
          const persistedIndex = restarted.api.getLastApplied();
          restarted.restart();
          assert.equal(restarted.api.getTerm(), termBefore);
          assert.equal(restarted.api.getLastApplied(), persistedIndex);
        },
      })
      .catch((err: unknown) => err as Error);

    const result = await change;
    assert.ok(jointSeen, 'the joint configuration must have been committed');

    /* ---- quorum boundary: the isolated old leader cannot read or write ---- */
    await assert.rejects(
      () => oldLeader.read(400),
      (err: unknown) => err instanceof RaftError,
    );
    await assert.rejects(
      () => oldLeader.write(setCmd('ghost', 'no'), 400),
      (err: unknown) => err instanceof RaftError,
    );
    // Its own membership change cannot finish while it is cut off.
    assert.ok(result instanceof RaftError);

    /* ---- the surviving joint quorum elects a leader in a NEW term ---- */
    await h.scheduler.runUntil(
      () =>
        [...h.nodes.values()].some(
          (n) =>
            n.running &&
            n.id !== oldLeader.id &&
            n.api.getRole() === 'leader' &&
            n.api.getTerm() > termAtIsolation,
        ),
      2500,
    );
    const newLeaderApi = [...h.nodes.values()].find(
      (n) =>
        n.running &&
        n.id !== oldLeader.id &&
        n.api.getRole() === 'leader' &&
        n.api.getTerm() > termAtIsolation,
    )!.api;
    assert.ok(targetVoters.includes(newLeaderApi.id));
    // The new leader resumes the unfinished joint transition; it may already
    // have appended C_new by the time we observe it, but the target voters and
    // history must match the joint/final configuration of that transition.
    const cfg = newLeaderApi.getConfig();
    if (cfg.joint) {
      assert.deepEqual([...cfg.joint.newVoters].sort(), targetVoters);
      assert.deepEqual([...cfg.joint.oldVoters].sort(), ['n1', 'n2', 'n3']);
    } else {
      assert.deepEqual([...cfg.voters].sort(), targetVoters);
    }

    const jointWrite = await newLeaderApi.write(setCmd('joint', 'q'));
    await waitForApply(h, jointWrite.index, [oldLeader.id], 2000);
    for (const n of h.nodes.values()) {
      if (!n.running || n.id === oldLeader.id) continue;
      assert.equal(
        (n.api.getAppliedState() as Record<string, string>).joint,
        'q',
      );
    }

    /* ---- 3. deliver the messages held back before the partition ---- */
    for (const id of h.config.voters) {
      if (id !== oldLeader.id) h.network.releaseHeld(oldLeader.id, id);
    }
    await h.scheduler.advance(300);
    // Replaying stale messages cannot produce a leadership claim that rivals
    // the new term: the old node's term stays below the surviving quorum's.
    assert.ok(oldLeader.getTerm() < newLeaderApi.getTerm());

    /* ---- 4. heal and drive everything to convergence ---- */
    h.network.healAll(oldLeader.id);
    // Let the resumed transition commit C_new and the old node catch up.
    await h.scheduler.runUntil(
      () =>
        newLeaderApi.getConfig().joint === undefined &&
        targetVoters.every(
          (id) =>
            h.nodes.get(id)!.api.getConfig().joint === undefined &&
            h.nodes.get(id)!.api.getLastApplied() >= jointWrite.index,
        ),
      3000,
    );
    await h.scheduler.advance(400);

    const finalConfig = newLeaderApi.getConfig();
    assert.deepEqual([...finalConfig.voters].sort(), targetVoters);
    assert.equal(finalConfig.joint, undefined);

    // Every member of the CURRENT configuration converges on one identical
    // command history — the same log position holds the same command.
    const reference = h.nodes
      .get(targetVoters[0])!
      .api.getLog()
      .map((e) => ({ index: e.index, term: e.term, command: e.command }));
    for (const id of targetVoters) {
      const got = h.nodes
        .get(id)!
        .api.getLog()
        .map((e) => ({ index: e.index, term: e.term, command: e.command }));
      assert.deepEqual(got, reference, `member ${id} must share the identical log`);
    }

    // The removed node is outside the configuration: it must not claim
    // leadership or serve reads, and must preserve every entry it had already
    // durably committed before removal (the shared prefix).
    assert.equal(oldLeader.getRole(), 'follower');
    const oldLog = oldLeader.getLog();
    const sharedPrefix = reference.filter(
      (e) => e.index <= initial.index,
    );
    for (const committed of sharedPrefix) {
      const match = oldLog.find((e) => e.index === committed.index);
      assert.ok(match, `removed node retains entry at ${committed.index}`);
      assert.deepEqual(match.command, committed.command);
    }
    await assert.rejects(
      () => oldLeader.read(200),
      (err: unknown) => err instanceof RaftError && err.code === 'NOT_LEADER',
    );

    // Linearizable read on the new configuration sees the whole history.
    const state = (await newLeaderApi.read()) as Record<string, string>;
    assert.equal(state.c1, '1');
    assert.equal(state.joint, 'q');
    assert.equal(state.ghost, undefined);
  } finally {
    h.cleanup();
  }
});

test('partition quorum boundaries: minority writes fail on both sides, majority side wins', async () => {
  // 5 nodes split into a 2-node side containing the old leader and a 3-node side.
  const h = makeHarness(['n1', 'n2', 'n3', 'n4', 'n5'], { seed: 97 });
  try {
    const oldLeader = await waitForLeader(h);
    const base = await oldLeader.write(setCmd('base', '0'));
    await waitForApply(h, base.index);

    const oldSide = [oldLeader.id];
    const peer = [...h.nodes.keys()].find((id) => id !== oldLeader.id)!;
    oldSide.push(peer);
    const majoritySide = h.config.voters.filter((id) => !oldSide.includes(id));

    // Cut the two sides fully apart.
    for (const a of oldSide) {
      for (const b of majoritySide) h.network.isolate(a, b);
    }

    /* --- minority side (2/5): neither reads nor writes can reach quorum --- */
    await assert.rejects(
      () => oldLeader.read(400),
      (err: unknown) => err instanceof RaftError,
    );
    await assert.rejects(
      () => oldLeader.write(setCmd('minority', 'x'), 400),
      (err: unknown) => err instanceof RaftError,
    );

    /* --- majority side (3/5): elects its own leader and commits normally --- */
    await h.scheduler.runUntil(
      () =>
        majoritySide.some(
          (id) =>
            h.nodes.get(id)!.api.getRole() === 'leader' &&
            h.nodes.get(id)!.api.getTerm() > oldLeader.getTerm(),
        ),
      2500,
    );
    const majorityLeaderId = majoritySide.find(
      (id) => h.nodes.get(id)!.api.getRole() === 'leader',
    )!;
    const majorityLeader = h.nodes.get(majorityLeaderId)!.api;
    const ok = await majorityLeader.write(setCmd('majority', 'y'));
    await waitForApply(h, ok.index, oldSide, 2000);

    /* --- healing converges both sides onto the majority's history --- */
    for (const a of oldSide) {
      for (const b of majoritySide) h.network.heal(a, b);
    }
    await h.scheduler.runUntil(
      () => oldSide.every((id) => h.nodes.get(id)!.api.getLastApplied() >= ok.index),
      3000,
    );

    for (const n of h.nodes.values()) {
      const s = n.api.getAppliedState() as Record<string, string>;
      assert.equal(s.base, '0');
      assert.equal(s.majority, 'y');
      assert.equal(s.minority, undefined, 'a minority-side write is never committed');
    }

    // Log matching: identical command at every identical position.
    const ref = majorityLeader
      .getLog()
      .map((e) => ({ index: e.index, term: e.term, command: e.command }));
    for (const n of h.nodes.values()) {
      assert.deepEqual(
        n.api.getLog().map((e) => ({ index: e.index, term: e.term, command: e.command })),
        ref,
      );
    }
  } finally {
    h.cleanup();
  }
});
