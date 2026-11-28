import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareEntries, mergeUpdate } from '../src/membership.ts';
import type { MemberUpdate } from '../src/types.ts';

function upd(partial: Partial<MemberUpdate> & { id: string }): MemberUpdate {
  return {
    incarnation: 1,
    seq: 0,
    state: 'alive',
    ...partial,
  };
}

test('new entry is accepted', () => {
  const view = new Map<string, MemberUpdate>();
  const d = mergeUpdate(view, upd({ id: 'a' }));
  assert.equal(d.accepted, true);
  assert.equal(d.reason, 'new-entry');
  assert.equal(view.get('a')!.state, 'alive');
});

test('higher incarnation overrides every older-incarnation state', () => {
  const view = new Map<string, MemberUpdate>();
  mergeUpdate(view, upd({ id: 'a', incarnation: 1, state: 'dead' }));
  const d = mergeUpdate(view, upd({ id: 'a', incarnation: 2, state: 'alive' }));
  assert.equal(d.accepted, true);
  assert.equal(d.reason, 'incarnation-override');
  assert.equal(view.get('a')!.incarnation, 2);
  assert.equal(view.get('a')!.state, 'alive');
});

test('older incarnation gossip cannot resurrect or modify a newer identity', () => {
  const view = new Map<string, MemberUpdate>();
  mergeUpdate(view, upd({ id: 'a', incarnation: 2, state: 'alive', seq: 3 }));
  const d = mergeUpdate(view, upd({ id: 'a', incarnation: 1, state: 'alive' }));
  assert.equal(d.accepted, false);
  assert.equal(d.reason, 'rejected-incarnation');
  assert.equal(view.get('a')!.incarnation, 2);

  const d2 = mergeUpdate(view, upd({ id: 'a', incarnation: 1, state: 'dead' }));
  assert.equal(d2.accepted, false);
});

test('terminal states cannot be overridden within the same incarnation', () => {
  const view = new Map<string, MemberUpdate>();
  mergeUpdate(view, upd({ id: 'a', state: 'dead' }));
  const laterAlive = mergeUpdate(view, upd({ id: 'a', seq: 5, state: 'alive' }));
  assert.equal(laterAlive.accepted, false);
  assert.equal(view.get('a')!.state, 'dead');
});

test('leave dominates dead within the same incarnation and both terminate', () => {
  const view1 = new Map<string, MemberUpdate>();
  mergeUpdate(view1, upd({ id: 'a', state: 'dead' }));
  const leaveWins = mergeUpdate(view1, upd({ id: 'a', state: 'left' }));
  assert.equal(leaveWins.accepted, true);
  assert.equal(view1.get('a')!.state, 'left');

  const view2 = new Map<string, MemberUpdate>();
  mergeUpdate(view2, upd({ id: 'a', state: 'left' }));
  const deadLoses = mergeUpdate(view2, upd({ id: 'a', state: 'dead' }));
  assert.equal(deadLoses.accepted, false);
  assert.equal(view2.get('a')!.state, 'left');
});

test('higher alive seq refutes a suspicion', () => {
  const view = new Map<string, MemberUpdate>();
  mergeUpdate(view, upd({ id: 'a', state: 'suspected', seq: 1, suspectDeadline: 99 }));
  const d = mergeUpdate(view, upd({ id: 'a', state: 'alive', seq: 2 }));
  assert.equal(d.accepted, true);
  assert.equal(view.get('a')!.state, 'alive');
  assert.equal(view.get('a')!.seq, 2);
});

test('same-seq suspected overrides alive, but alive cannot erase suspected', () => {
  const view = new Map<string, MemberUpdate>();
  mergeUpdate(view, upd({ id: 'a', state: 'alive', seq: 1 }));
  const d = mergeUpdate(view, upd({ id: 'a', state: 'suspected', seq: 1 }));
  assert.equal(d.accepted, true);
  assert.equal(d.reason, 'suspect-over-alive-same-seq');

  const staleAlive = mergeUpdate(view, upd({ id: 'a', state: 'alive', seq: 1 }));
  assert.equal(staleAlive.accepted, false);
  assert.equal(view.get('a')!.state, 'suspected');
});

test('duplicate suspicion is a no-op and keeps the original deadline', () => {
  const view = new Map<string, MemberUpdate>();
  const first = upd({ id: 'a', state: 'suspected', seq: 1, suspectDeadline: 500 });
  mergeUpdate(view, first);
  const repeated = upd({
    id: 'a',
    state: 'suspected',
    seq: 1,
    suspectDeadline: 9999, // a later re-gossip trying to extend the window
  });
  const d = mergeUpdate(view, repeated);
  assert.equal(d.accepted, false);
  assert.equal(d.reason, 'duplicate-noop');
  assert.equal(view.get('a')!.suspectDeadline, 500);
});

test('compareEntries ordering covers ranks', () => {
  const a = upd({ id: 'a' });
  assert.ok(compareEntries(upd({ id: 'a', state: 'suspected' }), a) > 0);
  assert.ok(compareEntries(upd({ id: 'a', state: 'dead' }), upd({ id: 'a', state: 'suspected' })) > 0);
  assert.ok(compareEntries(upd({ id: 'a', state: 'left' }), upd({ id: 'a', state: 'dead' })) > 0);
  assert.ok(
    compareEntries(upd({ id: 'a', incarnation: 2, state: 'alive' }), upd({ id: 'a', state: 'left' })) >
      0,
  );
  assert.throws(() =>
    compareEntries(upd({ id: 'a' }), upd({ id: 'b' })),
  );
});

test('dead at higher seq still cannot beat same-incarnation left at lower seq', () => {
  const view = new Map<string, MemberUpdate>();
  mergeUpdate(view, upd({ id: 'a', state: 'left', seq: 1 }));
  const d = mergeUpdate(view, upd({ id: 'a', state: 'dead', seq: 4 }));
  assert.equal(d.accepted, false);
  assert.equal(view.get('a')!.state, 'left');
});
