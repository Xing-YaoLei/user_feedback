import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setCmd } from '../src/kv.ts';
import {
  assertLogsConverged,
  makeHarness,
  waitForApply,
  waitForLeader,
  type Harness,
} from './helpers.ts';

async function runChaosScenario(seed: number): Promise<{
  commands: { key: string; value: string }[];
  history: unknown[];
}> {
  const h: Harness = makeHarness(['n1', 'n2', 'n3', 'n4', 'n5'], {
    seed,
    chaos: {
      lossRate: 0.15,
      duplicateRate: 0.1,
      minDelay: 1,
      maxDelay: 4,
      reorder: true,
    },
  });
  const commands: { key: string; value: string }[] = [];
  try {
    const leader = await waitForLeader(h, 5000);

    for (let round = 0; round < 6; round++) {
      const key = `k${round}`;
      const value = `v${seed}-${round}`;
      commands.push({ key, value });
      // Retry with the same idempotent command until a leader accepts it.
      let committed = false;
      for (let attempt = 0; attempt < 8 && !committed; attempt++) {
        const current =
          [...h.nodes.values()].find(
            (n) => n.running && n.api.getRole() === 'leader',
          )?.api ?? leader;
        try {
          const entry = await current.write(setCmd(key, value), 800);
          await waitForApply(h, entry.index, 1500);
          committed = true;
        } catch {
          await h.scheduler.advance(120); // let elections/retransmits happen
        }
      }
      assert.ok(committed, `command ${key} eventually commits under chaos`);
      // Periodically bounce a random node; durable state must survive.
      if (round % 2 === 1) {
        const victim = [...h.nodes.values()][h.scheduler.rng.int(0, 4)];
        victim.restart();
        await h.scheduler.advance(200);
      }
    }

    await h.scheduler.advance(800);
    assertLogsConverged(h);
    const history = h.nodes
      .get('n1')!
      .api.getLog()
      .map((e) => ({ index: e.index, term: e.term, command: e.command }));
    return { commands, history };
  } finally {
    h.cleanup();
  }
}

test('loss, duplication, delay, reorder and restarts still produce one convergent log', async () => {
  const { commands, history } = await runChaosScenario(101);
  // Every offered command appears exactly once in the command history.
  const appliedCommands = history
    .map((e) => (e as { command: { key?: string } }).command)
    .filter((c) => c && typeof c === 'object' && 'key' in c);
  for (const { key } of commands) {
    const occurrences = appliedCommands.filter((c) => c.key === key);
    assert.equal(occurrences.length, 1, `${key} must appear exactly once`);
  }
});

test('same seed reproduces the exact same schedule and log history', async () => {
  const a = await runChaosScenario(2024);
  const b = await runChaosScenario(2024);
  assert.deepEqual(a.history, b.history);
  assert.deepEqual(a.commands, b.commands);
});

test('different seeds still converge, via different interleavings', async () => {
  const a = await runChaosScenario(111);
  const b = await runChaosScenario(222);
  // Every seed drives the same sequence of client operations (the values
  // intentionally embed the seed, so compare op/key identity and order);
  // term/index interleaving may legitimately differ between schedules.
  const shape = (run: { history: unknown[] }): unknown =>
    (run.history as { command: { op?: string; key?: string } }[])
      .filter((e) => e.command && typeof e.command === 'object' && 'key' in e.command)
      .map((e) => ({ op: e.command.op, key: e.command.key }));
  assert.deepEqual(shape(a), shape(b));
  assert.equal(shape(a).length, 6);
});
