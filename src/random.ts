import type { RandomSource } from './types.ts';

/**
 * Small deterministic PRNG (mulberry32). Tests inject one sequence per
 * receiver so initial NACK jitter and retransmission backoff are reproducible
 * yet differ between peers.
 */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
