import type { CorrelationEvent, CorrelationType } from '../src/types.ts';

/** Build a correlation event with terse positional args. */
export function ev(
  id: string,
  source: string,
  key: string,
  type: CorrelationType,
  time: number,
): CorrelationEvent {
  return { id, source, key, type, time };
}

/**
 * Small deterministic PRNG (mulberry32) so randomised tests are reproducible.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle driven by a supplied RNG. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Stable string form of a match, useful for set comparisons. */
export function matchKeyOf(match: { aId: string; bId: string; key: string }): string {
  return `${match.key}:${match.aId}->${match.bId}`;
}

/** Sorted `key:a->b` strings for an array of matches. */
export function matchKeys(matches: readonly { aId: string; bId: string; key: string }[]): string[] {
  return matches.map(matchKeyOf).sort();
}
