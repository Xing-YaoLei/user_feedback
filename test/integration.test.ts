import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DeadlineDispatcher,
  ManualClock,
  beginCall,
  withCall,
  type DispatchOutcome,
  type SentOutcome,
} from '../src/index.ts';

function sent(outcome: DispatchOutcome): SentOutcome {
  assert.equal(outcome.status, 'sent', `expected a sent call, got ${outcome.status}`);
  return outcome as SentOutcome;
}

function assertNeverExceedsRemaining(outcome: SentOutcome): void {
  assert.ok(
    outcome.budget.encodedNanos <= outcome.remainingNanos,
    `protocol ${outcome.protocol} encoded ${outcome.budget.encodedNanos}ns ` +
      `from ${outcome.remainingNanos}ns remaining`,
  );
  assert.equal(outcome.budget.encodedNanos + outcome.budget.lossNanos, outcome.remainingNanos);
}

describe('interleaved queue hold and unit-boundary crossing', () => {
  it('holds one call below 1ms, crosses a protocol-B digit boundary on another, and keeps siblings independent', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '200S', clock, root: true, label: 'root' });

    // Call A (protocol A) asks for exactly 1s; it will be queued down past the
    // 1ms floor, where protocol A has no representable value.
    const callA = dispatcher.submit({ parent: root, protocol: 'A', budget: '1S', label: 'A' });

    // Call B (protocol B) is queued down to 999_999ns — a real sub-millisecond
    // outgoing budget that must still be sent, and must equal that remaining
    // amount.
    const holdNanos = 999_000_001n;
    const callB = dispatcher.submit({ parent: root, protocol: 'B', budget: '1S', label: 'B' });

    // Call C (protocol B) is queued so its remaining straddles the eight-digit
    // microsecond form: 99_999_999_999ns == 99_999_999.999µs.
    const boundaryRemaining = 99_999_999_999n;
    const callC = dispatcher.submit({
      parent: root,
      protocol: 'B',
      budget: holdNanos + boundaryRemaining,
      label: 'C',
    });

    // Call D: a sibling that is cancelled while A, B and C wait.
    const callD = dispatcher.submit({ parent: root, protocol: 'B', budget: '500m', label: 'D' });
    const grandchildOfD = callD.scope.createChild({ budget: '100m' });

    // The adapter leaves the calls in the queue until the 1s siblings have
    // 999_999ns left.
    clock.advance(holdNanos);
    assert.equal(callA.scope.remainingNanos(), 999_999n);
    assert.equal(callB.scope.remainingNanos(), 999_999n);

    const outcomeB = sent(dispatcher.dispatch(callB));
    assert.equal(outcomeB.wire, '999999n');
    assert.equal(outcomeB.budget.encodedNanos, 999_999n);
    assert.equal(outcomeB.budget.lossNanos, 0n);
    assertNeverExceedsRemaining(outcomeB);

    const outcomeC = sent(dispatcher.dispatch(callC));
    assert.equal(outcomeC.wire, '99999999u');
    assert.equal(outcomeC.budget.encodedNanos, 99_999_999_000n);
    assert.equal(outcomeC.budget.lossNanos, 999n);
    assertNeverExceedsRemaining(outcomeC);

    const outcomeA = dispatcher.dispatch(callA);
    assert.equal(outcomeA.status, 'insufficient');
    assert.equal(outcomeA.remainingNanos, 999_999n);
    assert.equal(callA.status, 'insufficient');
    // No zero-length budget was produced: zero would read as "no deadline".
    assert.equal(callA.outcome?.status, 'insufficient');

    callD.scope.cancel();
    assert.equal(callD.status, 'cancelled');
    assert.equal(grandchildOfD.endState?.reason, 'cancelled');
    assert.equal(grandchildOfD.endState?.cause, 'ancestor');

    // Each sibling kept its own deadline and end state throughout.
    assert.equal(callB.scope.ended, false);
    assert.equal(callC.scope.ended, false);
    assert.equal(callB.scope.deadline, 1_000_000_000n);
    assert.equal(callC.scope.deadline, holdNanos + boundaryRemaining);
    assert.equal(root.ended, false);
    assert.equal(dispatcher.pending.length, 0);
  });

  it('moves protocol B to a coarser unit when the finer one would need nine digits', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ deadline: 3_600_000_000_000n, clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B' });

    const outcome = sent(dispatcher.dispatch(call));
    // 3.6e12ns needs 10 digits as microseconds, so the encoder chooses exact
    // milliseconds (7 digits) instead of clamping the microsecond value and
    // losing an hour of budget.
    assert.equal(outcome.wire, '3600000m');
    assert.equal(outcome.budget.lossNanos, 0n);
    assertNeverExceedsRemaining(outcome);
  });

  it('keeps two roots fully independent across async interleaving', async () => {
    const fastClock = new ManualClock(0n);
    const slowClock = new ManualClock(0n);
    const fastDispatcher = new DeadlineDispatcher({ clock: fastClock });
    const slowDispatcher = new DeadlineDispatcher({ clock: slowClock });

    const observations: string[] = [];

    const fastRoot = withCall(
      { budget: '300m', clock: fastClock, root: true, label: 'fast' },
      async (scope) => {
        const call = fastDispatcher.submit({ parent: scope, protocol: 'A' });
        await Promise.resolve();
        fastClock.advance(299_500_000n); // 500_000ns remain: below 1ms
        assert.equal(scope.remainingNanos(), 500_000n);
        observations.push(`fast-dispatch:${fastDispatcher.dispatch(call).status}`);
      },
    );

    const slowRoot = withCall(
      { budget: '5S', clock: slowClock, root: true, label: 'slow' },
      async (scope) => {
        const call = slowDispatcher.submit({ parent: scope, protocol: 'B' });
        await Promise.resolve();
        // The fast root's clock advances do not move this root's deadline.
        assert.equal(scope.remainingNanos(), 5_000_000_000n);
        assert.equal(scope.ended, false);
        const outcome = sent(slowDispatcher.dispatch(call));
        assert.equal(outcome.wire, '5000000u');
        assertNeverExceedsRemaining(outcome);
        observations.push(`slow:${outcome.wire}`);
      },
    );

    await Promise.all([fastRoot, slowRoot]);
    assert.deepEqual(observations.sort(), [
      'fast-dispatch:insufficient',
      'slow:5000000u',
    ]);
  });

  it('survives a late dequeue notification without sending or reviving anything', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: '10S', clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B', budget: '1S' });

    // The transport dies and reports the dequeue late, after the call's own
    // deadline but before the root's.
    clock.advance(1_200_000_000n);
    const late = dispatcher.dispatch(call);
    assert.equal(late.status, 'expired');
    assert.equal(call.status, 'expired');
    assert.equal(root.ended, false);

    // Any number of duplicate/late notifications stays settled.
    const again = dispatcher.dispatch(call);
    assert.equal(again, late);
    assert.equal(dispatcher.pending.length, 0);

    // The root survives its child's crash and can still issue calls.
    const retry = dispatcher.submit({ parent: root, protocol: 'A' });
    assert.equal(retry.status, 'queued');
    const retryOutcome = sent(dispatcher.dispatch(retry));
    assert.equal(retryOutcome.wire, '8800');
    assertNeverExceedsRemaining(retryOutcome);
  });

  it('expires a real queued call through the wall-clock timer', async () => {
    const dispatcher = new DeadlineDispatcher();
    const root = beginCall({ budget: '40m', root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'A' });

    let guard: ReturnType<typeof setTimeout> | undefined;
    const guardFailure = new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error('timer did not expire the queued call')), 2_000);
    });

    let event;
    try {
      event = await Promise.race([call.scope.whenEnded(), guardFailure]);
    } finally {
      clearTimeout(guard);
    }

    assert.equal(event.reason, 'expired');
    assert.equal(call.status, 'expired');
    assert.equal(dispatcher.pending.length, 0);
  });
});
