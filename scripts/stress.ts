/**
 * Ad-hoc multi-seed stability check (not part of the permanent suite).
 * Runs the chaos-style cluster through many seeds to catch schedule-specific
 * flakiness. Run: node scripts/stress.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterNode, bootstrapConfigFor, nodeDataDir } from '../src/cluster.ts';
import { kvStateMachine, setCmd } from '../src/kv.ts';
import { Network } from '../src/network.ts';
import { Scheduler } from '../src/scheduler.ts';

async function runSeed(seed: number): Promise<void> {
  const ids = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const baseDir = mkdtempSync(join(tmpdir(), `raft-stress-${seed}-`));
  const scheduler = new Scheduler(seed);
  const network = new Network(scheduler, {
    lossRate: 0.2,
    duplicateRate: 0.1,
    minDelay: 1,
    maxDelay: 4,
    reorder: true,
  });
  const config = bootstrapConfigFor(ids);
  const nodes = new Map(
    ids.map(
      (id) =>
        [id, new ClusterNode(id, kvStateMachine, scheduler, network, nodeDataDir(baseDir, id), config)] as const,
    ),
  );
  try {
    await scheduler.runUntil(() => [...nodes.values()].some((n) => n.api.getRole() === 'leader'));
    for (let round = 0; round < 8; round++) {
      let done = false;
      for (let attempt = 0; attempt < 10 && !done; attempt++) {
        const leader = [...nodes.values()].find((n) => n.api.getRole() === 'leader');
        if (!leader) {
          await scheduler.advance(120);
          continue;
        }
        try {
          const entry = await leader.api.write(setCmd(`k${round}`, `s${seed}-${round}`), 800);
          await scheduler.runUntil(
            () => [...nodes.values()].every((n) => n.api.getLastApplied() >= entry.index),
            2000,
          );
          done = true;
        } catch {
          await scheduler.advance(120);
        }
      }
      if (!done) throw new Error(`seed ${seed}: round ${round} never committed`);
      if (round % 2 === 1) {
        const victim = [...nodes.values()][scheduler.rng.int(0, 4)];
        victim.restart();
        await scheduler.advance(200);
      }
    }
    // Convergence: identical command payload at every position across nodes.
    const ref = [...nodes.values()][0].api.getLog().map((e) => e.command);
    for (const n of nodes.values()) {
      const got = n.api.getLog().map((e) => e.command);
      if (JSON.stringify(got) !== JSON.stringify(ref)) {
        throw new Error(`seed ${seed}: log divergence on ${n.id}`);
      }
    }
  } finally {
    for (const n of nodes.values()) n.shutdown();
    rmSync(baseDir, { recursive: true, force: true });
  }
}

const seeds = [1, 2, 3, 7, 13, 42, 79, 101, 2024, 9999];
for (const seed of seeds) {
  await runSeed(seed);
  console.log(`seed ${seed} OK`);
}
console.log(`all ${seeds.length} seeds converged`);
process.exit(0);
