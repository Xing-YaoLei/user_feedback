import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationSubscription } from '../src/subscription.ts';
import type { SubscriptionEvent } from '../src/subscription.ts';
import { ev, matchKeys } from './helpers.ts';

test('subscription reports provisional revisions for its key only', () => {
  const updates: SubscriptionEvent[] = [];
  const { subscription, engine } = CorrelationSubscription.create(
    { sources: ['L', 'R'], windowMs: 10 },
    'k',
    (u) => updates.push(u),
  );

  subscription.ingest(ev('b-other', 'R', 'other', 'B', 5)); // ignored by scoped delta
  subscription.ingest(ev('b', 'R', 'k', 'B', 6));
  subscription.ingest(ev('a9', 'L', 'k', 'A', 5));
  subscription.ingest(ev('a1', 'L', 'k', 'A', 1));

  const provisional = updates.filter((u) => u.kind === 'provisional');
  assert.equal(provisional.length, 2);
  const last = provisional.at(-1)!;
  assert.equal(last.kind, 'provisional');
  if (last.kind === 'provisional') {
    assert.deepEqual(matchKeys(last.delta.retracted), ['k:a9->b']);
    assert.deepEqual(matchKeys(last.delta.added), ['k:a1->b']);
  }

  subscription.end();
  const finals = updates.filter((u) => u.kind === 'final');
  assert.equal(finals.length, 1);
  const finalUpdate = finals[0];
  if (finalUpdate.kind === 'final') {
    assert.deepEqual(matchKeys(finalUpdate.matches), ['k:a1->b']);
  }

  assert.deepEqual(matchKeys(subscription.snapshot()), ['k:a1->b']);
});

test('subscription does not emit for rejected or duplicate events', () => {
  const updates: SubscriptionEvent[] = [];
  const { subscription } = CorrelationSubscription.create(
    { sources: ['L'], windowMs: 10 },
    'k',
    (u) => updates.push(u),
  );
  subscription.ingest(ev('a', 'L', 'k', 'A', 1));
  subscription.ingest(ev('a', 'L', 'k', 'A', 1)); // duplicate
  subscription.ingest(ev('x', 'Z', 'k', 'A', 1)); // unknown source
  assert.equal(updates.length, 0);
});
