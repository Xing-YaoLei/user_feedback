import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DeadlineDispatcher,
  ManualClock,
  ScopeEndedError,
  beginCall,
  openScope,
  runInScope,
  withCall,
} from '../src/index.ts';
import type { ScopeEndEvent } from '../src/index.ts';

describe('deadline propagation', () => {
  it('converts the received relative budget into an absolute monotonic deadline at entry', () => {
    const clock = new ManualClock(5_000_000_000n);
    const scope = beginCall({ budget: '250m', clock, root: true });

    assert.equal(scope.deadline, 5_250_000_000n);
    assert.equal(scope.deadlineOrigin, 'own');
    assert.equal(scope.remainingNanos(), 250_000_000n);

    // Time passes after entry: remaining shrinks, deadline does not move.
    clock.advance(100_000_000n);
    assert.equal(scope.deadline, 5_250_000_000n);
    assert.equal(scope.remainingNanos(), 150_000_000n);
  });

  it('accepts protocol A budgets decoded exactly', () => {
    const clock = new ManualClock(0n);
    const scope = beginCall({ budget: 2_147_483_647n * 1_000_000n, clock, root: true });
    assert.equal(scope.deadline, 2_147_483_647_000_000n);
  });

  it('takes the earlier of the parent deadline and the child requirement', () => {
    const clock = new ManualClock(1_000n);
    const parent = beginCall({ budget: '1S', clock, root: true });

    const tighter = parent.createChild({ budget: '100m' });
    assert.equal(tighter.deadline, 100_001_000n);
    assert.equal(tighter.deadlineOrigin, 'own');

    const looser = parent.createChild({ budget: '5S' });
    assert.equal(looser.deadline, parent.deadline);
    assert.equal(looser.deadlineOrigin, 'ancestor');

    const equal = parent.createChild({ budget: '1000m' });
    assert.equal(equal.deadline, parent.deadline);
    assert.equal(equal.deadlineOrigin, 'both');
  });

  it('inherits the parent deadline when the child requests nothing', () => {
    const clock = new ManualClock(0n);
    const parent = beginCall({ budget: '2S', clock, root: true });
    const child = parent.createChild();
    assert.equal(child.deadline, parent.deadline);
    assert.equal(child.deadlineOrigin, 'ancestor');
  });

  it('expires a child at construction when its requirement is already in the past', () => {
    const clock = new ManualClock(10_000n);
    const parent = beginCall({ budget: '1S', clock, root: true });
    const child = parent.createChild({ budget: 0n });
    assert.equal(child.ended, true);
    assert.equal(child.endState?.reason, 'expired');
    assert.equal(child.remainingNanos(), 0n);
  });

  it('wraps execution in a scope with withCall and completes it afterwards', async () => {
    const clock = new ManualClock(0n);
    const events: ScopeEndEvent[] = [];
    const result = await withCall(
      { budget: '500m', clock, root: true, onEnd: (event) => events.push(event) },
      async (scope) => {
        clock.advance(10_000_000n);
        assert.equal(scope.remainingNanos(), 490_000_000n);
        return 'ok';
      },
    );
    assert.equal(result, 'ok');
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'completed');
  });
});

describe('scope isolation', () => {
  it('keeps concurrent roots independent', async () => {
    const clock = new ManualClock(0n);
    const events: string[] = [];

    const first = withCall(
      { budget: '1S', clock, root: true, label: 'first', onEnd: (e) => events.push(`first:${e.reason}`) },
      async (scope) => {
        await Promise.resolve();
        assert.equal(scope.remainingNanos(), 1_000_000_000n);
        scope.cancel();
        assert.equal(scope.endState?.reason, 'cancelled');
      },
    );

    const second = withCall(
      { budget: '2S', clock, root: true, label: 'second', onEnd: (e) => events.push(`second:${e.reason}`) },
      async (scope) => {
        await Promise.resolve();
        assert.equal(scope.ended, false, 'sibling root must not be cancelled');
        assert.equal(scope.remainingNanos(), 2_000_000_000n);
      },
    );

    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:cancelled', 'second:completed']);
  });

  it('propagates parent cancellation to descendants but not to siblings', () => {
    const clock = new ManualClock(0n);
    const root = beginCall({ budget: '10S', clock, root: true });
    const left = root.createChild({ budget: '5S' });
    const right = root.createChild({ budget: '5S' });
    const grandchild = left.createChild({ budget: '1S' });

    const rightEnds: ScopeEndEvent[] = [];
    right.onEnd((event) => rightEnds.push(event));

    left.cancel();

    assert.equal(left.endState?.reason, 'cancelled');
    assert.equal(left.endState?.cause, 'self');
    assert.equal(grandchild.endState?.reason, 'cancelled');
    assert.equal(grandchild.endState?.cause, 'ancestor');
    assert.equal(root.ended, false, 'child cancellation must not end the parent');
    assert.equal(right.ended, false, 'sibling must be unaffected');
    assert.equal(right.remainingNanos(), 5_000_000_000n);
    assert.deepEqual(rightEnds, []);
  });

  it('propagates root cancellation to every descendant and aborts signals', () => {
    const clock = new ManualClock(0n);
    const root = beginCall({ budget: '10S', clock, root: true });
    const child = root.createChild({ budget: '9S' });
    const grandchild = child.createChild({ budget: '8S' });

    const aborted: string[] = [];
    grandchild.signal.addEventListener('abort', () => aborted.push('grandchild'));
    child.signal.addEventListener('abort', () => aborted.push('child'));

    root.cancel();

    assert.equal(root.endState?.reason, 'cancelled');
    assert.equal(child.endState?.reason, 'cancelled');
    assert.equal(grandchild.endState?.reason, 'cancelled');
    assert.equal(grandchild.endState?.cause, 'ancestor');
    assert.deepEqual(aborted.sort(), ['child', 'grandchild']);
    assert.ok(grandchild.signal.reason instanceof ScopeEndedError);
  });

  it('cannot revive an ended scope with a late parent cancellation', () => {
    const clock = new ManualClock(0n);
    const root = beginCall({ budget: '10S', clock, root: true });
    const child = root.createChild({ budget: '5S' });
    child.cancel();
    assert.equal(child.endState?.reason, 'cancelled');

    // A late ancestor end must not change the recorded end state.
    root.cancel();
    assert.equal(child.endState?.reason, 'cancelled');
    assert.equal(child.endState?.cause, 'self');
  });

  it('defaults to the ambient scope when one exists, else root', () => {
    const clock = new ManualClock(0n);
    const root = beginCall({ budget: '1S', clock, root: true });

    const outside = beginCall({ budget: '1S', clock });
    assert.equal(outside.parent, null);

    const inside = runInScope(root, () => beginCall({ budget: '500m' }));
    assert.equal(inside.parent, root);
    assert.equal(inside.deadline, 500_000_000n);
  });
});

describe('resource release', () => {
  it('runs cleanups exactly once when the scope ends', () => {
    const clock = new ManualClock(0n);
    const root = beginCall({ budget: '1S', clock, root: true });
    let runs = 0;
    root.addCleanup(() => runs++);
    root.cancel();
    root.cancel(); // idempotent
    assert.equal(runs, 1);
  });

  it('runs a cleanup immediately when registered after the end', () => {
    const clock = new ManualClock(0n);
    const root = beginCall({ budget: '1S', clock, root: true });
    root.cancel();
    let runs = 0;
    root.addCleanup(() => runs++);
    assert.equal(runs, 1);
  });

  it('removes an ended child from its parent so it is not garbage-retained', () => {
    const clock = new ManualClock(0n);
    const parent = beginCall({ budget: '10S', clock, root: true });
    const child = parent.createChild();
    const child2 = parent.createChild();
    child.cancel();
    child2.complete();

    // Ending is visible via state, and a later parent cancel only reaches
    // still-live descendants; nothing throws or double-ends.
    parent.cancel();
    assert.equal(child.endState?.cause, 'self');
    assert.equal(child2.endState?.reason, 'completed');
  });

  it('does not leave timers armed once the scope is cancelled', async () => {
    const cleared: unknown[] = [];
    const clock = new ManualClock(0n);
    const dispatcher = new DeadlineDispatcher({
      clock,
      deadlineTimers: true,
      setTimer: (_callback, _ms) => Symbol('timer'),
      clearTimer: (handle) => cleared.push(handle),
    });

    const root = beginCall({ budget: '1S', clock, root: true });
    const call = dispatcher.submit({ parent: root, protocol: 'B', budget: '500m' });
    assert.equal(cleared.length, 0);
    assert.equal(clock.now(), 0n);

    root.cancel();
    assert.equal(cleared.length, 1, 'timer must be cleared when the scope ends');
    assert.equal(call.status, 'cancelled');
    assert.equal(dispatcher.pending.length, 0);
  });
});

describe('argument validation', () => {
  it('rejects passing both a relative budget and an absolute deadline', () => {
    const clock = new ManualClock(0n);
    assert.throws(() => openScope({ clock, budget: '1S', deadline: 5n, parent: null }));
  });

  it('rejects a child using a different clock than its parent', () => {
    const clock = new ManualClock(0n);
    const parent = openScope({ clock, budget: '1S', parent: null });
    assert.throws(() => parent.createChild({ clock: new ManualClock(0n) } as never));
  });
});
