import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeadlineScheduler } from '../src/index.ts';
import type { DeadlineHandle } from '../src/index.ts';

/**
 * Deterministic PRNG so failures reproduce exactly.
 * mulberry32.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Trace {
  kind: 'fire' | 'cancel';
  rpcId: string;
  generation: number;
  at: bigint;
}

describe('randomised invariants', () => {
  it('holds heap/terminal/index invariants under random interleavings', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const random = rng(seed);
      const scheduler = new DeadlineScheduler();
      const live = new Map<string, DeadlineHandle>();
      const expiredGenerations = new Set<number>();
      const cancelledGenerations = new Set<number>();
      const firedOrder: bigint[] = [];
      const rpcIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      let clock = 0n;
      let maxGeneration = 0;

      const pick = <T>(xs: T[]): T | undefined =>
        xs.length === 0 ? undefined : xs[Math.floor(random() * xs.length)];

      for (let step = 0; step < 400; step++) {
        const r = random();
        if (r < 0.45) {
          // register a possibly-reused id at a deadline near the clock
          const id = pick(rpcIds)!;
          const deadline = clock + BigInt(Math.floor(random() * 50));
          const generationAtRegister = maxGeneration + 1;
          const handle = scheduler.register(id, deadline, (h) => {
            expiredGenerations.add(h.generation);
            firedOrder.push(scheduler.now());
            // Sometimes, from inside a callback: cancel someone and re-register self.
            const victimId = pick(rpcIds);
            if (victimId !== undefined && random() < 0.3) {
              const victim = live.get(victimId);
              if (victim !== undefined && random() < 0.5) {
                if (scheduler.cancel(victim)) live.delete(victimId);
              }
            }
            if (random() < 0.3) {
              const reused = scheduler.register(
                h.rpcId,
                scheduler.now() + BigInt(Math.floor(random() * 50)),
                () => {},
              );
              live.set(reused.rpcId, reused);
              maxGeneration = Math.max(maxGeneration, reused.generation);
            }
          });
          maxGeneration = Math.max(maxGeneration, handle.generation);
          live.set(id, handle);
          assert.equal(handle.generation, generationAtRegister);
        } else if (r < 0.62) {
          const id = pick([...live.keys()]);
          if (id !== undefined) {
            const handle = live.get(id)!;
            const newDeadline = clock + BigInt(Math.floor(random() * 80));
            const ok = scheduler.reschedule(handle, newDeadline);
            if (!ok) live.delete(id);
          }
        } else if (r < 0.72) {
          const id = pick([...live.keys()]);
          if (id !== undefined) {
            const handle = live.get(id)!;
            const ok = scheduler.cancel(handle);
            if (ok) {
              cancelledGenerations.add(handle.generation);
              live.delete(id);
            }
          }
        } else {
          const target = clock + BigInt(Math.floor(random() * 60));
          const result = scheduler.advance({
            target,
            maxCallbacks: 1 + Math.floor(random() * 4),
          });
          clock = result.now;
          // Callbacks may have removed handles; prune anything no longer active.
          for (const [id, handle] of [...live]) {
            if (!scheduler.isActive(handle)) live.delete(id);
          }
          // Every fired record must never have been cancelled.
          for (const e of result.expired) {
            assert.equal(
              cancelledGenerations.has(e.generation),
              false,
              `generation ${e.generation} both cancelled and fired`,
            );
          }
        }

        // ---- invariants after every step ----
        assert.ok(
          scheduler.indexSize() <= 2 * scheduler.activeCount() + 2,
          `seed ${seed} step ${step}: index=${scheduler.indexSize()} active=${scheduler.activeCount()}`,
        );
        assert.ok(scheduler.now() >= clock, `seed ${seed}: clock regressed`);
        clock = scheduler.now();
      }

      // Every cancellation is unique per generation and never also fired.
      const cancelledSeen = new Set<number>();
      for (const c of scheduler.cancellations()) {
        assert.equal(cancelledSeen.has(c.generation), false, `duplicate cancel ${c.generation}`);
        cancelledSeen.add(c.generation);
        assert.equal(expiredGenerations.has(c.generation), false);
      }
      for (const e of scheduler.expiries()) {
        assert.equal(cancelledSeen.has(e.generation), false);
      }
      // Federation: each generation fired at most once.
      const firedSeen = new Set<number>();
      for (const e of scheduler.expiries()) {
        assert.equal(firedSeen.has(e.generation), false, `duplicate fire ${e.generation}`);
        firedSeen.add(e.generation);
      }
      // Callbacks observed a non-decreasing clock.
      for (let i = 1; i < firedOrder.length; i++) {
        assert.ok(firedOrder[i] >= firedOrder[i - 1], `seed ${seed}: firing clock regressed`);
      }
    }
  });
});
