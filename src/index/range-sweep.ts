/**
 * Pairwise sweep-line index for two ranges on the same path.
 *
 * Expressions such as `x in [a,b] AND x in [c,d]` (internally, any AND of two
 * range atoms, even if the same range appears more than once) can be answered
 * from a set of precomputed intersection intervals instead of testing both
 * ranges per event. Contradictions (`[5,10] AND [20,30]`) produce no interval
 * and therefore no index entry: the OR of them is an empty candidate set.
 *
 * Stored keys are merged intervals `(min,max]`-style integer sets:
 * `[max(lo1,lo2), min(hi1,hi2)]` when non-empty.
 */

export interface RangeAtomRef {
  id: number;
  min: number | null;
  max: number | null;
}

const NEG_INF = -Infinity;
const POS_INF = Infinity;

export const intersectRanges = (
  a: { min: number | null; max: number | null },
  b: { min: number | null; max: number | null },
): { min: number | null; max: number | null } | null => {
  const lo = Math.max(a.min ?? NEG_INF, b.min ?? NEG_INF);
  const hi = Math.min(a.max ?? POS_INF, b.max ?? POS_INF);
  if (lo > hi) return null;
  return {
    min: lo === NEG_INF ? null : lo,
    max: hi === POS_INF ? null : hi,
  };
};
