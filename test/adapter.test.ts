import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DeadlineDispatcher,
  ManualClock,
  beginCall,
  type DispatchOutcome,
  type SentOutcome,
  type UnsentOutcome,
} from '../src/index.ts';

function sent(outcome: DispatchOutcome): SentOutcome {
  assert.equal(outcome.status, 'sent', `expected a sent call, got ${outcome.status}`);
  return outcome as SentOutcome;
}

function unsent(outcome: DispatchOutcome): UnsentOutcome {
  assert.notEqual(outcome.status, 'sent');
  return outcome as UnsentOutcome;
}

describe('outgoing budget is computed at dequeue time', () => {
  it('charges queueing delay to the call instead of extending its budget', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '1S', clock, root: true });

    const call = dispatcher.submit({ parent: root, protocol: 'A' });
    // Nothing is encoded at enqueue: the call just sits in the queue.
    assert.equal(call.status, 'queued');
    assert.equal(call.outcome, null);

    // The adapter holds the call for 250ms before it really sends.
    clock.advance(250_000_000n);
    const outcome = sent(dispatcher.dispatch(call));

    assert.equal(outcome.wire, '750');
    assert.equal(outcome.remainingNanos, 750_000_000n);
    assert.ok(outcome.budget.encodedNanos <= outcome.remainingNanos);
    assert.equal(outcome.dispatchedAtNanos, 250_000_000n);
    assert.equal(call.status, 'sent');
    assert.equal(dispatcher.pending.length, 0);
  });

  it('queues a call down to just under a millisecond and then reports insufficient for A', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '1S', clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'A' });

    // Queue until 999_999ns remain: positive, but below protocol A's 1ms unit.
    clock.advance(999_000_001n);
    assert.equal(root.remainingNanos(), 999_999n);

    const outcome = unsent(dispatcher.dispatch(call));
    assert.equal(outcome.status, 'insufficient');
    assert.equal(outcome.remainingNanos, 999_999n);
    assert.equal(outcome.minimumNanos, 1_000_000n);
    assert.equal(call.status, 'insufficient');
    // Crucially, no `"0"` was produced: zero would mean an infinite wait.
    assert.equal(call.outcome?.status === 'sent', false);
  });

  it('still encodes a sub-millisecond budget exactly on protocol B', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '1S', clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B' });

    clock.advance(999_000_001n);
    const outcome = sent(dispatcher.dispatch(call));

    assert.equal(outcome.wire, '999999n');
    assert.equal(outcome.budget.encodedNanos, 999_999n);
    assert.equal(outcome.budget.lossNanos, 0n);
    assert.ok(outcome.budget.encodedNanos <= 999_999n);
  });

  it('never sends a call whose deadline passed while queued', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '500m', clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B' });

    clock.advance(500_000_000n); // exactly at the deadline
    const outcome = unsent(dispatcher.dispatch(call));

    assert.equal(outcome.status, 'expired');
    assert.equal(outcome.remainingNanos, 0n);
    assert.equal(root.remainingNanos(), 0n);
    assert.equal(call.status, 'expired');
  });

  it('computes the budget from the call deadline, which may be the parent one', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '2S', clock, root: true });

    const looser = dispatcher.submit({ parent: root, protocol: 'A', budget: '10S' });
    const tighter = dispatcher.submit({ parent: root, protocol: 'A', budget: '200m' });

    clock.advance(100_000_000n);

    const looserOutcome = sent(dispatcher.dispatch(looser));
    const tighterOutcome = sent(dispatcher.dispatch(tighter));

    assert.equal(looserOutcome.remainingNanos, 1_900_000_000n, 'clamped to the parent deadline');
    assert.equal(tighterOutcome.remainingNanos, 100_000_000n, 'own tighter requirement wins');
    assert.equal(looserOutcome.wire, '1900');
    assert.equal(tighterOutcome.wire, '100');
  });
});

describe('scope end while queued', () => {
  it('drops a queued call when its parent is cancelled before dequeue', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '1S', clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B' });

    root.cancel();
    assert.equal(call.status, 'cancelled');
    assert.equal(dispatcher.pending.length, 0);

    // A late dequeue notification must not send or revive anything.
    const late = unsent(dispatcher.dispatch(call));
    assert.equal(late.status, 'cancelled');
    assert.equal(root.endState?.reason, 'cancelled');
    assert.equal(call.status, 'cancelled');
  });

  it('ends only its own descendants when a sibling is cancelled', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '10S', clock, root: true });

    const siblingA = dispatcher.submit({ parent: root, protocol: 'A' });
    const siblingB = dispatcher.submit({ parent: root, protocol: 'B' });
    const grandchild = siblingA.scope.createChild({ budget: '1S' });

    siblingA.scope.cancel();
    assert.equal(grandchild.endState?.reason, 'cancelled');
    assert.equal(siblingA.status, 'cancelled');
    assert.equal(siblingB.status, 'queued');
    assert.equal(siblingB.scope.ended, false);

    clock.advance(1_000_000_000n);
    const outcome = sent(dispatcher.dispatch(siblingB));
    // 9s is exactly representable as 9000m and 9000000u; the finer unit wins.
    assert.equal(outcome.wire, '9000000u');
    assert.equal(outcome.remainingNanos, 9_000_000_000n);
  });

  it('does not revive an ended call on a second dequeue notification', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '1S', clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B' });

    clock.advance(100_000_000n);
    const first = sent(dispatcher.dispatch(call));
    assert.equal(first.wire, '900000u');

    clock.advance(500_000_000n);
    const second = dispatcher.dispatch(call);
    assert.equal(second, first, 'the settled outcome is stable');
    assert.equal(call.status, 'sent');
  });

  it('reports completed when a call is cleanly abandoned after dequeue-time expiry', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '100m', clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'A' });

    const outcome = unsent(dispatcher.abandon(call));
    assert.equal(outcome.status, 'completed');
    assert.equal(call.status, 'completed');
  });
});

describe('resource cleanup on end', () => {
  it('releases the queue slot and the timer when a queued call expires', () => {
    const cleared: unknown[] = [];
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({
      clock,
      deadlineTimers: true,
      setTimer: () => Symbol('t'),
      clearTimer: (handle) => cleared.push(handle),
    });
    const root = beginCall({ budget: '1S', clock, root: true });
    dispatcher.submit({ parent: root, protocol: 'B' });

    assert.equal(dispatcher.pending.length, 1);
    clock.advance(1_000_000_000n);
    root.expireIfDue();

    assert.equal(dispatcher.pending.length, 0);
    assert.equal(cleared.length, 1);
  });

  it('uses only exact integer nanoseconds in reported outcomes', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: 123_456_789n, clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B' });
    clock.advance(456_789n);

    const outcome = sent(dispatcher.dispatch(call));
    assert.equal(outcome.remainingNanos, 123_000_000n);
    assert.equal(outcome.wire, '123000u');
    assert.equal(outcome.budget.encodedNanos + outcome.budget.lossNanos, 123_000_000n);
  });
});
