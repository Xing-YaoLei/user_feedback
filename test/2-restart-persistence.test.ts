import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeDataDir } from '../src/cluster.ts';
import { setCmd } from '../src/kv.ts';
import {
  assertCommittedState,
  assertLogsConverged,
  makeHarness,
  waitForApply,
  waitForLeader,
} from './helpers.ts';

test('restarted nodes retain term, vote and log, then rejoin replication', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 31 });
  try {
    const leader = await waitForLeader(h);
    const e1 = await leader.write(setCmd('a', '1'));
    await waitForApply(h, e1.index);
    const term = leader.getTerm();

    // Restart every node from its own durable directory.
    for (const n of h.nodes.values()) n.restart();
    await h.scheduler.advance(500);

    const leader2 = await waitForLeader(h);
    // A post-restart election is legal, but the term can never move backwards
    // and persisted state must have survived every restart.
    assert.ok(leader2.getTerm() >= term);
    for (const n of h.nodes.values()) {
      const raw = JSON.parse(
        readFileSync(join(nodeDataDir(h.baseDir, n.id), 'state.json'), 'utf8'),
      ) as { currentTerm: number; votedFor: string | null };
      assert.ok(raw.currentTerm >= term);
      assert.ok(n.api.getLog().some((entry) => entry.index === e1.index));
    }

    const e2 = await leader2.write(setCmd('b', '2'));
    await waitForApply(h, e2.index);
    assertCommittedState(h, { a: '1', b: '2' });
    assertLogsConverged(h);
  } finally {
    h.cleanup();
  }
});

test('a node down during commits catches the full log after restart', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 37 });
  try {
    const leader = await waitForLeader(h);
    const downed = [...h.nodes.values()].find((n) => n.id !== leader.id)!;
    downed.shutdown();

    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(await leader.write(setCmd(`k${i}`, `v${i}`)));
    }
    await h.scheduler.advance(200);

    // Restart: durable log is replayed through the snapshot and then caught up.
    downed.restart();
    await waitForApply(h, entries[entries.length - 1].index);
    assertCommittedState(
      h,
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, `v${i}`])),
    );
    assertLogsConverged(h);
  } finally {
    h.cleanup();
  }
});

test('durable files on disk hold term, vote, log and the applied snapshot', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 43 });
  try {
    const leader = await waitForLeader(h);
    const entry = await leader.write(setCmd('persisted', 'disk'));
    await waitForApply(h, entry.index);

    const dir = nodeDataDir(h.baseDir, leader.id);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
      currentTerm: number;
      votedFor: string | null;
    };
    const log = JSON.parse(readFileSync(join(dir, 'log.json'), 'utf8')) as Array<{
      index: number;
      term: number;
      command: unknown;
    }>;
    const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as {
      commitIndex: number;
      lastApplied: number;
      appliedState: Record<string, string>;
    };

    assert.ok(state.currentTerm >= 1);
    assert.ok(state.votedFor !== null);
    assert.ok(log.some((e) => e.index === entry.index));
    assert.equal(snapshot.commitIndex, leader.getCommitIndex());
    assert.equal(snapshot.lastApplied, leader.getLastApplied());
    assert.equal(snapshot.appliedState.persisted, 'disk');

    // Restart and confirm the constraints survive byte-for-byte.
    const termBefore = state.currentTerm;
    leader.stop();
    const restartedNode = h.nodes.get(leader.id)!;
    restartedNode.restart();
    const state2 = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
      currentTerm: number;
      votedFor: string | null;
    };
    assert.equal(state2.currentTerm, termBefore);
    assert.equal(state2.votedFor, state.votedFor);
    assert.ok(restartedNode.api.getLog().some((e) => e.index === entry.index));
    assert.equal(
      (restartedNode.api.getAppliedState() as Record<string, string>).persisted,
      'disk',
    );
  } finally {
    h.cleanup();
  }
});

test('commands acknowledged before a leader change remain committed afterwards', async () => {
  const h = makeHarness(['n1', 'n2', 'n3'], { seed: 41 });
  try {
    const leader = await waitForLeader(h);
    const e = await leader.write(setCmd('durable', 'yes'));
    await waitForApply(h, e.index);

    // Kill the old leader; the remaining quorum elects a new one.
    const oldId = leader.id;
    h.nodes.get(oldId)!.shutdown();
    await h.scheduler.advance(600);
    const leader2 = await waitForLeader(h);
    assert.notEqual(leader2.id, oldId);

    const next = await leader2.write(setCmd('after', 'failover'));
    await waitForApply(h, next.index);
    for (const n of h.nodes.values()) {
      if (!n.running) continue;
      const state = n.api.getAppliedState() as Record<string, string>;
      assert.equal(state.durable, 'yes');
      assert.equal(state.after, 'failover');
    }
  } finally {
    h.cleanup();
  }
});
