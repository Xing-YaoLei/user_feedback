import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeadlineDispatcher, ManualClock, beginCall } from '../src/index.ts';

describe('deadline timers', () => {
  it('re-arms instead of expiring when the timer fires before the deadline', () => {
    const clock = new ManualClock(0n);
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];

    const dispatcher = new DeadlineDispatcher({
      clock,
      deadlineTimers: true,
      setTimer: (callback) => {
        callbacks.push(callback);
        return Symbol('timer');
      },
      clearTimer: (handle) => cleared.push(handle),
    });

    const root = beginCall({ budget: '100m', clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B', budget: '100m' });

    // Simulate a sloppy platform firing the 100ms timer after only 40ms.
    assert.equal(callbacks.length, 1);
    clock.advance(40_000_000n);
    callbacks[0]();

    assert.equal(call.status, 'queued', 'an early timer must not expire the call');
    assert.equal(callbacks.length, 2, 'a new timer is armed for the remainder');
    // The already-fired handle is consumed rather than handed to clearTimer.
    assert.equal(cleared.length, 0);

    // The re-armed timer fires at the real deadline.
    clock.advance(60_000_000n);
    callbacks[1]();
    assert.equal(call.status, 'expired');
    assert.equal(dispatcher.pending.length, 0);
  });

  it('does not arm timers against a manual clock by default', () => {
    const clock = new ManualClock(0n);
    let armed = 0;
    const dispatcher = new DeadlineDispatcher({
      clock,
      setTimer: () => {
        armed++;
        return Symbol('timer');
      },
    });

    const root = beginCall({ budget: '1S', clock, root: true });
    dispatcher.submit({ parent: root, protocol: 'A' });
    assert.equal(armed, 0, 'manual clocks never get wall-clock timers by default');
  });

  it('releases a real timer when the scope is cancelled before firing', async () => {
    const dispatcher = new DeadlineDispatcher();
    const root = beginCall({ budget: '30S', root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B' });

    call.scope.cancel();
    assert.equal(call.status, 'cancelled');

    // Give the event loop a chance to run any stray timer.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatcher.pending.length, 0);
    assert.equal(call.status, 'cancelled');
  });
});
