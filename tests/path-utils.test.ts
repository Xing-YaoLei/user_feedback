import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareDomainIdSequence,
  compareRanked,
  isAcceptablePath,
  sameSelectedRoute,
  assertNonNegativeIntCost,
  type RankedCandidate,
} from '../src/path-utils.ts';
import type { Candidate, SelectedRoute } from '../src/types.ts';

function makeCandidate(over: Partial<Candidate>): Candidate {
  return {
    destination: 'd',
    learnedFrom: 'B',
    source: { stableId: 'A', gen: 1 },
    path: ['A', 'B'],
    version: 1,
    announcedCost: 1,
    linkCost: 1,
    ...over,
  };
}

function rank(c: Candidate, fullPath: string[], totalCost: number): RankedCandidate {
  return { ...c, fullPath, totalCost };
}

test('域 ID 序列字典序逐段比较', () => {
  assert.equal(compareDomainIdSequence(['A', 'B'], ['A', 'C']), -1);
  assert.equal(compareDomainIdSequence(['A', 'B'], ['A', 'B']), 0);
  assert.equal(compareDomainIdSequence(['A'], ['A', 'B']), -1);
  assert.equal(compareDomainIdSequence(['B'], ['A']), 1);
});

test('选路依次按总代价、跳数、域 ID 序列决胜', () => {
  const base = makeCandidate({});
  const cheap = rank(base, ['A', 'B', 'X'], 2);
  const costly = rank(base, ['A', 'C', 'X'], 5);
  assert.ok(compareRanked(cheap, costly) < 0, '低代价优先');

  const sameCostShort = rank(base, ['A', 'X'], 3);
  const sameCostLong = rank(base, ['A', 'B', 'X'], 3);
  assert.ok(compareRanked(sameCostShort, sameCostLong) < 0, '同代价跳数少者优先');

  const p1 = rank(base, ['A', 'B', 'X'], 3);
  const p2 = rank(base, ['A', 'C', 'X'], 3);
  assert.ok(compareRanked(p1, p2) < 0, '同代价同跳数字典序小者优先');
});

test('等价候选集合排序结果确定唯一（洗牌不变性）', () => {
  const cands: RankedCandidate[] = [
    rank(makeCandidate({ learnedFrom: 'B' }), ['A', 'B', 'X'], 4),
    rank(makeCandidate({ learnedFrom: 'C' }), ['A', 'C', 'X'], 4),
    rank(makeCandidate({ learnedFrom: 'F' }), ['A', 'F', 'X'], 4),
  ];
  const pickBest = (arr: RankedCandidate[]): RankedCandidate =>
    [...arr].sort(compareRanked)[0];
  const ref = pickBest(cands);
  for (let seed = 1; seed < 50; seed++) {
    const shuffled = [...cands];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (seed * (i + 7)) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    assert.deepEqual(pickBest(shuffled).fullPath, ref.fullPath);
  }
});

test('含本域或重复域的路径被拒绝', () => {
  const src = { stableId: 'A', gen: 1 };
  assert.equal(isAcceptablePath(['A', 'B', 'C'], src, 'X'), true);
  assert.equal(isAcceptablePath(['A', 'B', 'A'], src, 'X'), false, '重复域拒绝');
  assert.equal(isAcceptablePath(['A', 'B', 'X'], src, 'X'), false, '含本域拒绝');
  assert.equal(isAcceptablePath(['B', 'C'], src, 'X'), false, '首跳非来源拒绝');
  assert.equal(isAcceptablePath([], src, 'X'), false, '空路径拒绝');
});

test('非负整数代价校验', () => {
  assert.throws(() => assertNonNegativeIntCost(-1));
  assert.throws(() => assertNonNegativeIntCost(1.5));
  assert.doesNotThrow(() => assertNonNegativeIntCost(0));
  assert.doesNotThrow(() => assertNonNegativeIntCost(10));
});

test('sameSelectedRoute 区分路径与代次差异', () => {
  const r: SelectedRoute = {
    destination: 'd',
    source: { stableId: 'A', gen: 1 },
    fullPath: ['A', 'B', 'C'],
    totalCost: 3,
    hops: 2,
    local: false,
    learnedFrom: 'B',
    version: 1,
  };
  assert.equal(sameSelectedRoute(r, { ...r }), true);
  assert.equal(
    sameSelectedRoute(r, { ...r, source: { stableId: 'A', gen: 2 } }),
    false,
  );
  assert.equal(sameSelectedRoute(r, null), false);
  assert.equal(sameSelectedRoute(null, null), true);
});
