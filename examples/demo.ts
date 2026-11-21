/**
 * Runnable demonstration of the correlation subscription.
 *
 *   npm run demo
 *
 * It walks through the mandated narrative: provisional result, a late earlier A
 * that re-assigns a B, a late C that invalidates a match, then watermark
 * advancement that finalises and reclaims — and finally shows the finalised
 * result matching the complete-input rule.
 */

import {
  CorrelationEngine,
  referenceMatches,
  type CorrelationEvent,
  type Match,
} from '../src/index.ts';

const T = 10;
const sources = ['left', 'right'];

const engine = new CorrelationEngine({ sources, windowMs: T });
const delivered: CorrelationEvent[] = [];

function fmt(m: Match): string {
  return `[${m.key}] ${m.aId}@${m.aTime} -> ${m.bId}@${m.bTime}`;
}

function overview(label: string): void {
  const snap = engine.snapshot();
  console.log(`\n=== ${label} ===`);
  console.log('provisional:', snap.provisional.map(fmt));
  console.log('final      :', snap.final.map(fmt));
}

function feed(event: CorrelationEvent): void {
  const r = engine.ingest(event);
  if (r.status === 'accepted') delivered.push(event);
  const changes = [
    ...r.delta.retracted.map((m) => `- ${fmt(m)}`),
    ...r.delta.added.map((m) => `+ ${fmt(m)}`),
  ];
  console.log(
    `ingest ${event.id} (${event.type} @${event.time} from ${event.source}) -> ${r.status}` +
      (changes.length ? `\n    ${changes.join('\n    ')}` : ''),
  );
}

// 1. A B arrives first, then an A that claims it.
feed({ id: 'b1', source: 'right', key: 'orders', type: 'B', time: 6 });
feed({ id: 'a9', source: 'left', key: 'orders', type: 'A', time: 5 });
overview('provisional after b1 + a9');

// 2. A late but earlier A steals the B.
feed({ id: 'a1', source: 'left', key: 'orders', type: 'A', time: 1 });
overview('after late earlier a1 (re-assignment)');

// 3. A second key: a late C invalidates a match.
feed({ id: 'b2', source: 'right', key: 'payments', type: 'B', time: 9 });
feed({ id: 'a5', source: 'left', key: 'payments', type: 'A', time: 0 });
overview('payments provisional');
feed({ id: 'c1', source: 'right', key: 'payments', type: 'C', time: 4 });
overview('after late C invalidates payments match');

// 4. Advance watermarks from different sources; progress = min.
console.log('\nprogress before watermarks:', engine.globalProgress);
let wm = engine.advanceWatermark('left', 100);
console.log('advance left=100 -> progress', wm.progress, '(still gated by right)');
wm = engine.advanceWatermark('right', 100);
console.log('advance right=100 -> progress', wm.progress);
console.log('finalised now:', wm.finalized.map(fmt), '| reclaimed', wm.reclaimed);
overview('after watermark advancement');

// 5. Compare the finalised result with the complete-input rule.
engine.end();
const reference = referenceMatches(delivered, T);
const finalKeys = engine.snapshot().final.map((m) => `${m.key}:${m.aId}->${m.bId}`).sort();
const refKeys = reference.matches.map((m) => `${m.key}:${m.aId}->${m.bId}`).sort();
console.log('\nfinal result      :', finalKeys);
console.log('complete-input rule:', refKeys);
console.log('agree             :', JSON.stringify(finalKeys) === JSON.stringify(refKeys));
console.log('\nstats:', engine.stats());
