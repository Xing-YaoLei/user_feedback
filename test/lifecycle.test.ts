import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DeadlineDispatcher,
  ManualClock,
  ScopeEndedError,
  beginCall,
  receiveCall,
  withCall,
  type DispatchOutcome,
  type SentOutcome,
} from '../src/index.ts';

function sent(outcome: DispatchOutcome): SentOutcome {
  assert.equal(outcome.status, 'sent', `expected a sent call, got ${outcome.status}`);
  return outcome as SentOutcome;
}

describe('a parent request that waited in a queue', () => {
  it('computes the child budget from the deadline fixed at receipt time', () => {
    const clock = new ManualClock(0n);

    // The parent's budget of 1s is converted to an absolute deadline the
    // instant the request arrives, before it is queued.
    const parent = receiveCall('1S', { clock, root: true });
    const parentDeadline = parent.deadline;
    assert.equal(parentDeadline, 1_000_000_000n);

    // The request waits in the adapter queue for 600ms.
    clock.advance(600_000_000n);

    const dispatcher = new DeadlineDispatcher({ clock });
    const child = dispatcher.submit({ parent, protocol: 'A', budget: '900m' });

    // At spawn time only 400ms remain, so the child inherits 400ms even though
    // it asked for 900ms. The queue wait is charged to the caller.
    assert.equal(child.scope.deadline, parentDeadline);
    assert.equal(child.scope.remainingNanos(), 400_000_000n);

    // The child then waits another 100ms in the transport queue.
    clock.advance(100_000_000n);
    const outcome = sent(dispatcher.dispatch(child));
    assert.equal(outcome.wire, '300');
    assert.ok(outcome.budget.encodedNanos <= 300_000_000n);
  });

  it('never uses the receipt-time remaining amount for a later child', () => {
    const clock = new ManualClock(0n);
    const parent = receiveCall('500m', { clock, root: true });
    clock.advance(499_500_000n); // 500_000ns remain

    const dispatcher = new DeadlineDispatcher({ clock });
    const child = dispatcher.submit({ parent, protocol: 'A' });
    const outcome = dispatcher.dispatch(child);

    // The stale "500ms" from receipt must not leak through; only 500µs is left.
    assert.equal(outcome.status, 'insufficient');
    assert.equal(outcome.remainingNanos, 500_000n);
  });
});

describe('scopes without a deadline', () => {
  it('reports no-deadline and never invents an infinite wire value', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ clock, root: true }); // no budget, no deadline
    assert.equal(root.deadline, null);
    assert.equal(root.remainingNanos(), null);

    const call = dispatcher.submit({ parent: root, protocol: 'A' });
    const outcome = dispatcher.dispatch(call);
    assert.equal(outcome.status, 'no-deadline');
    assert.equal(outcome.remainingNanos, null);
    assert.equal(call.status, 'no-deadline');
  });

  it('an unbounded parent accepts a bounded child', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B', budget: '250m' });

    clock.advance(50_000_000n);
    const outcome = sent(dispatcher.dispatch(call));
    assert.equal(outcome.wire, '200000u');
  });
});

describe('withCall lifecycle', () => {
  it('refuses to run the body when the parent is already cancelled', async () => {
    const clock = new ManualClock(0n);
    const parent = beginCall({ budget: '1S', clock, root: true });
    parent.cancel();

    let ran = false;
    await assert.rejects(
      withCall({ budget: '500m', parent, clock }, () => {
        ran = true;
      }),
      (error: unknown) =>
        error instanceof ScopeEndedError && error.reason === 'cancelled' && error.endCause === 'ancestor',
    );
    assert.equal(ran, false);
  });

  it('refuses to run the body when the received budget is already zero', async () => {
    const clock = new ManualClock(0n);
    let ran = false;
    await assert.rejects(
      withCall({ budget: 0n, clock, root: true }, () => {
        ran = true;
      }),
      (error: unknown) => error instanceof ScopeEndedError && error.reason === 'expired',
    );
    assert.equal(ran, false);
  });

  it('propagates user errors but still completes the scope', async () => {
    const clock = new ManualClock(0n);
    let completed = false;
    const scope = beginCall({ budget: '1S', clock, root: true });
    void scope;
    await assert.rejects(
      withCall(
        {
          budget: '1S',
          clock,
          root: true,
          onEnd: (event) => {
            completed = event.reason === 'completed';
          },
        },
        () => {
          throw new Error('boom');
        },
      ),
      /boom/,
    );
    assert.equal(completed, true);
  });
});

describe('far-future and boundary deadlines', () => {
  it('does not arm a timer for a deadline beyond the timer range but still dispatches', () => {
    let timersSet = 0;
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({
      clock,
      deadlineTimers: true,
      setTimer: () => {
        timersSet++;
        return Symbol('t');
      },
      clearTimer: () => {},
    });

    const root = beginCall({ budget: '10000S', clock, root: true }); // ~2.8h
    const call = dispatcher.submit({ parent: root, protocol: 'A' });

    assert.equal(timersSet, 1, 'a normal long deadline still gets a timer');

    const huge = beginCall({ budget: 10_000_000_000_000_000_000n, clock, root: true });
    const hugeCall = dispatcher.submit({ parent: huge, protocol: 'A' });
    assert.equal(timersSet, 1, 'a deadline past the setTimeout range is not armed');
    void hugeCall;

    clock.advance(1_000_000_000n);
    const outcome = sent(dispatcher.dispatch(call));
    assert.ok(outcome.budget.encodedNanos <= outcome.remainingNanos);
  });

  it('encodes exactly 1ms on protocol A (the smallest representable value)', () => {
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({ clock });
    const root = beginCall({ budget: 1_000_000n, clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'A' });

    const outcome = sent(dispatcher.dispatch(call));
    assert.equal(outcome.wire, '1');
    assert.equal(outcome.budget.lossNanos, 0n);
  });
});
