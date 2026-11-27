import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeadlineScheduler, toNanoseconds } from '../src/index.ts';
import type { DeadlineHandle } from '../src/index.ts';

const NS = 1n;

function collect(scheduler: DeadlineScheduler, order: string[]): (handle: DeadlineHandle) => void {
  return (handle) => {
    order.push(handle.rpcId);
  };
}

describe('exact nanosecond time', () => {
  it('accepts bigint nanoseconds without loss', () => {
    assert.equal(toNanoseconds(9_007_199_254_740_993n), 9_007_199_254_740_993n);
  });

  it('accepts safe integer numbers and rejects unsafe ones', () => {
    assert.equal(toNanoseconds(42), 42n);
    assert.throws(() => toNanoseconds(Number.MAX_SAFE_INTEGER + 1), RangeError);
    assert.throws(() => toNanoseconds(1.5), RangeError);
  });

  it('keeps deadlines past Number.MAX_SAFE_INTEGER exact', () => {
    const scheduler = new DeadlineScheduler();
    const far = BigInt(Number.MAX_SAFE_INTEGER) * 1000n + 7n;
    let firedAt: bigint | undefined;
    scheduler.register('far', far, () => {
      firedAt = scheduler.now();
    });
    const near = far - 1n;
    scheduler.advance({ target: near });
    assert.equal(firedAt, undefined, 'must not fire one nanosecond early');
    assert.equal(scheduler.now(), near);
    scheduler.advance({ target: far });
    assert.equal(firedAt, far);
    assert.equal(scheduler.now(), far);
  });
});

describe('ordering', () => {
  it('fires earliest deadline first', () => {
    const scheduler = new DeadlineScheduler();
    const order: string[] = [];
    scheduler.register('late', 30n, collect(scheduler, order));
    scheduler.register('early', 10n, collect(scheduler, order));
    scheduler.register('middle', 20n, collect(scheduler, order));
    const result = scheduler.advance({ target: 100n });
    assert.deepEqual(order, ['early', 'middle', 'late']);
    assert.equal(result.callbacks, 3);
    assert.equal(result.now, 100n);
  });

  it('breaks equal deadlines by smaller registration sequence', () => {
    const scheduler = new DeadlineScheduler();
    const order: string[] = [];
    for (const id of ['c', 'a', 'b']) {
      scheduler.register(id, 5n, collect(scheduler, order));
    }
    scheduler.advance({ target: 5n });
    assert.deepEqual(order, ['c', 'a', 'b']);
  });

  it('does not reorder a rescheduled item ahead of its registration seniority on ties', () => {
    const scheduler = new DeadlineScheduler();
    const order: string[] = [];
    const first = scheduler.register('first', 1n, collect(scheduler, order));
    scheduler.register('second', 50n, collect(scheduler, order));
    scheduler.reschedule(first, 50n); // same deadline as 'second', older seq stays first
    scheduler.advance({ target: 50n });
    assert.deepEqual(order, ['first', 'second']);
  });
});

describe('registration generations', () => {
  it('gives each registration a distinct generation', () => {
    const scheduler = new DeadlineScheduler();
    const a1 = scheduler.register('a', 10n, () => {});
    const a2 = scheduler.register('a', 20n, () => {});
    assert.notEqual(a1.generation, a2.generation);
    assert.notEqual(a1.seq, a2.seq);
    assert.equal(scheduler.isActive(a1), false);
    assert.equal(scheduler.isActive(a2), true);
  });

  it('invalidates old handles when an RPC id is reused', () => {
    const scheduler = new DeadlineScheduler();
    const fired: string[] = [];
    const oldHandle = scheduler.register('rpc', 10n, () => fired.push('old'));
    scheduler.register('rpc', 10n, () => fired.push('new'));
    assert.equal(scheduler.cancel(oldHandle), false);
    assert.equal(scheduler.reschedule(oldHandle, 1n), false);
    scheduler.advance({ target: 10n });
    assert.deepEqual(fired, ['new']);
  });

  it('never fires a stale handle even if it shares the old deadline', () => {
    const scheduler = new DeadlineScheduler();
    const calls: number[] = [];
    const gen1 = scheduler.register('x', 5n, () => calls.push(1));
    scheduler.cancel(gen1);
    scheduler.register('x', 5n, () => calls.push(2));
    scheduler.advance({ target: 5n });
    assert.deepEqual(calls, [2]);
    assert.equal(scheduler.expiries().length, 1);
    assert.equal(scheduler.cancellations().length, 1);
  });
});

describe('rescheduling', () => {
  it('moves a deadline later without firing it early', () => {
    const scheduler = new DeadlineScheduler();
    let fired = 0;
    const handle = scheduler.register('r', 10n, () => fired++);
    scheduler.reschedule(handle, 100n);
    scheduler.advance({ target: 50n });
    assert.equal(fired, 0);
    scheduler.advance({ target: 100n });
    assert.equal(fired, 1);
    assert.equal(scheduler.now(), 100n);
  });

  it('moves a deadline earlier', () => {
    const scheduler = new DeadlineScheduler();
    const order: string[] = [];
    const handle = scheduler.register('r', 100n, collect(scheduler, order));
    scheduler.register('other', 50n, collect(scheduler, order));
    scheduler.reschedule(handle, 10n);
    scheduler.advance({ target: 100n });
    assert.deepEqual(order, ['r', 'other']);
  });

  it('keeps one live node across a million reschedules', () => {    const scheduler = new DeadlineScheduler();
    let fired = 0;
    const handle = scheduler.register('hot', 1n, () => fired++);
    for (let i = 0; i < 1_000_000; i++) {
      assert.equal(scheduler.reschedule(handle, 1_000_000n + BigInt(i)), true);
    }
    assert.equal(scheduler.activeCount(), 1);
    assert.ok(
      scheduler.indexSize() <= 3,
      `index must stay O(active), got ${scheduler.indexSize()}`,
    );
    scheduler.advance({ target: 1_000_000n + 999_999n });
    assert.equal(fired, 1);
    assert.equal(scheduler.activeCount(), 0);
    assert.equal(scheduler.indexSize(), 0);
  });

  it('keeps the handle valid and the generation unchanged across reschedules', () => {
    const scheduler = new DeadlineScheduler();
    const handle = scheduler.register('r', 10n, () => {});
    const { generation, seq } = handle;
    assert.equal(scheduler.reschedule(handle, 20n), true);
    assert.equal(scheduler.reschedule(handle, 30n), true);
    assert.equal(scheduler.isActive(handle), true);
    assert.equal(scheduler.deadlineOf(handle), 30n);
    // Same registration, so tie-breaks still use the original sequence.
    assert.equal(handle.generation, generation);
    assert.equal(handle.seq, seq);
  });

  it('reclaims stale index nodes while rescheduling in bulk', () => {
    const scheduler = new DeadlineScheduler();
    const handles: DeadlineHandle[] = [];
    for (let i = 0; i < 1000; i++) handles.push(scheduler.register(`r${i}`, 100n, () => {}));
    for (let round = 0; round < 200; round++) {
      for (const handle of handles) scheduler.reschedule(handle, 1000n + BigInt(round));
      assert.ok(
        scheduler.staleIndexCount() <= scheduler.activeCount() + 1,
        `round ${round}: stale=${scheduler.staleIndexCount()} active=${scheduler.activeCount()}`,
      );
      assert.ok(scheduler.indexSize() <= 2 * scheduler.activeCount() + 2);
    }
  });
});

describe('cancellation', () => {
  it('prevents a cancelled registration from firing', () => {
    const scheduler = new DeadlineScheduler();
    let fired = 0;
    const handle = scheduler.register('c', 5n, () => fired++);
    assert.equal(scheduler.cancel(handle), true);
    assert.equal(scheduler.cancel(handle), false);
    scheduler.advance({ target: 10n });
    assert.equal(fired, 0);
    assert.equal(scheduler.activeCount(), 0);
  });

  it('produces exactly one terminal outcome per registration', () => {
    const scheduler = new DeadlineScheduler();
    const handle = scheduler.register('one', 5n, () => {});
    scheduler.cancel(handle);
    scheduler.cancel(handle); // repeated cancel is a no-op
    scheduler.advance({ target: 5n }); // would-be deadline must not fire
    assert.equal(scheduler.cancellations().length, 1);
    assert.equal(scheduler.expiries().length, 0);
    assert.equal(scheduler.timeouts().length, 0);
  });

  it('cancel and timeout cannot both apply to one registration', () => {
    const scheduler = new DeadlineScheduler();
    let handle!: DeadlineHandle;
    handle = scheduler.register('boom', 5n, () => {
      // self-cancel from inside the callback is a no-op: it already fired
      assert.equal(scheduler.cancel(handle), false);
      throw new Error('kaput');
    });
    scheduler.advance({ target: 5n });
    assert.equal(scheduler.cancellations().length, 0);
    assert.equal(scheduler.timeouts().length, 1);
    assert.equal(scheduler.expiries().length, 1);
  });

  it('cancels every active registration', () => {
    const scheduler = new DeadlineScheduler();
    for (let i = 0; i < 10; i++) scheduler.register(`r${i}`, 100n, () => {});
    assert.equal(scheduler.cancelAll(), 10);
    assert.equal(scheduler.activeCount(), 0);
    assert.equal(scheduler.indexSize(), 0);
  });
});

describe('callback failures', () => {
  it('attributes a thrown error to its item and keeps processing', () => {
    const scheduler = new DeadlineScheduler();
    const order: string[] = [];
    scheduler.register('ok1', 1n, () => order.push('ok1'));
    scheduler.register('bad', 2n, () => {
      order.push('bad');
      throw new Error('boom');
    });
    scheduler.register('ok2', 3n, () => order.push('ok2'));
    const result = scheduler.advance({ target: 10n });
    assert.deepEqual(order, ['ok1', 'bad', 'ok2']);
    assert.equal(result.callbacks, 3);
    assert.deepEqual(
      result.expired.map((e) => [e.rpcId, e.failed]),
      [
        ['ok1', false],
        ['bad', true],
        ['ok2', false],
      ],
    );
    assert.equal(result.expired[1].error instanceof Error, true);
    assert.equal((result.expired[1].error as Error).message, 'boom');
    assert.deepEqual(
      scheduler.timeouts().map((t) => t.rpcId),
      ['bad'],
    );
  });
});

describe('callbacks that mutate the schedule', () => {
  it('can cancel the next due item from inside a callback', () => {
    const scheduler = new DeadlineScheduler();
    const order: string[] = [];
    let second!: DeadlineHandle;
    scheduler.register('first', 1n, () => {
      order.push('first');
      scheduler.cancel(second);
    });
    second = scheduler.register('second', 2n, () => order.push('second'));
    scheduler.register('third', 3n, () => order.push('third'));
    scheduler.advance({ target: 10n });
    assert.deepEqual(order, ['first', 'third']);
  });

  it('can reschedule another item from inside a callback', () => {
    const scheduler = new DeadlineScheduler();
    const order: string[] = [];
    let other!: DeadlineHandle;
    scheduler.register('first', 1n, () => {
      order.push('first');
      scheduler.reschedule(other, 100n);
    });
    other = scheduler.register('other', 2n, () => order.push('other'));
    scheduler.advance({ target: 50n });
    assert.deepEqual(order, ['first']);
    scheduler.advance({ target: 100n });
    assert.deepEqual(order, ['first', 'other']);
  });

  it('lets newly registered already-due items join the same advance', () => {
    const scheduler = new DeadlineScheduler();
    const order: string[] = [];
    scheduler.register('first', 1n, () => {
      order.push('first');
      scheduler.register('spawned', 1n, () => order.push('spawned'));
    });
    scheduler.register('later', 5n, () => order.push('later'));
    const result = scheduler.advance({ target: 10n });
    assert.deepEqual(order, ['first', 'spawned', 'later']);
    assert.deepEqual(
      result.expired.map((e) => e.rpcId),
      ['first', 'spawned', 'later'],
    );
  });

  it('re-registering the current RPC id inside its callback fires only the new generation', () => {
    const scheduler = new DeadlineScheduler();
    const fired: string[] = [];
    let firstHandle!: DeadlineHandle;
    firstHandle = scheduler.register('rpc', 1n, () => {
      fired.push('old');
      scheduler.register('rpc', 1n, () => fired.push('new'));
      // the old handle must already be stale
      assert.equal(scheduler.isActive(firstHandle), false);
    });
    const result = scheduler.advance({ target: 10n });
    // The replacement is already due, so it joins this same advance — but only
    // once, and through its own generation.
    assert.deepEqual(fired, ['old', 'new']);
    assert.equal(result.callbacks, 2);
    assert.equal(result.expired[0].supersededDuringCallback, true);
    assert.equal(scheduler.activeCount(), 0);
  });
});

describe('advance budget', () => {
  it('stops at the budget and resumes from the same position', () => {
    const scheduler = new DeadlineScheduler();
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      scheduler.register(`r${i}`, BigInt(i + 1), () => order.push(`r${i}`));
    }
    const first = scheduler.advance({ target: 100n, maxCallbacks: 4 });
    assert.equal(first.callbacks, 4);
    assert.equal(first.hasMore, true);
    assert.deepEqual(order, ['r0', 'r1', 'r2', 'r3']);
    assert.equal(first.now, 4n, 'clock stops at the last executed deadline');

    const second = scheduler.advance({ target: 100n, maxCallbacks: 4 });
    assert.equal(second.callbacks, 4);
    assert.deepEqual(order.slice(4), ['r4', 'r5', 'r6', 'r7']);

    const third = scheduler.advance({ maxCallbacks: 4 });
    assert.deepEqual(order.slice(8), ['r8', 'r9']);
    assert.equal(third.hasMore, false);
    // No explicit target: the pending 100n target from the previous call resumes.
    assert.equal(third.now, 100n);
  });

  it('maxCallbacks: 0 observes without firing', () => {
    const scheduler = new DeadlineScheduler();
    let fired = 0;
    scheduler.register('r', 1n, () => fired++);
    const result = scheduler.advance({ target: 10n, maxCallbacks: 0 });
    assert.equal(result.callbacks, 0);
    assert.equal(result.hasMore, true);
    assert.equal(fired, 0);
    scheduler.advance();
    assert.equal(fired, 1);
  });

  it('does not report hasMore when work is exhausted exactly at the budget', () => {
    const scheduler = new DeadlineScheduler();
    for (let i = 0; i < 3; i++) scheduler.register(`r${i}`, BigInt(i + 1), () => {});
    const result = scheduler.advance({ target: 10n, maxCallbacks: 3 });
    assert.equal(result.callbacks, 3);
    assert.equal(result.hasMore, false);
    assert.equal(result.now, 10n);
  });
});

describe('forward jumps and indexing cost', () => {
  it('jumps across a huge idle interval in O(log n)', () => {
    const scheduler = new DeadlineScheduler();
    let fired = 0;
    scheduler.register('far', 1_000_000_000_000_000_000n, () => fired++);
    const result = scheduler.advance({ target: 9_000_000_000_000_000_000n });
    assert.equal(fired, 1);
    assert.equal(result.now, 9_000_000_000_000_000_000n);
    assert.ok(result.access.heap < 20, `heap accesses=${result.access.heap}`);
  });

  it('skips 100k not-yet-due deadlines visiting only the due ones', () => {
    const scheduler = new DeadlineScheduler();
    for (let i = 0; i < 100_000; i++) {
      scheduler.register(`r${i}`, 1_000_000_000_000n + BigInt(i), () => {});
    }
    for (let i = 0; i < 3; i++) scheduler.register(`due${i}`, BigInt(i + 1), () => {});
    const result = scheduler.advance({ target: 100n });
    assert.equal(result.callbacks, 3);
    assert.ok(
      result.access.heap < 500,
      `expected O(log n) work for 3 of 100003, got ${result.access.heap}`,
    );
    assert.equal(result.activeCount, 100_000);
    assert.equal(result.indexSize, 100_000);
  });

  it('keeps the index proportional to active registrations after mass cancellation', () => {
    const scheduler = new DeadlineScheduler();
    const handles: DeadlineHandle[] = [];
    for (let i = 0; i < 50_000; i++) {
      handles.push(scheduler.register(`r${i}`, 1000n + BigInt(i), () => {}));
    }
    for (let i = 0; i < handles.length; i += 2) {
      scheduler.cancel(handles[i]);
    }
    assert.equal(scheduler.activeCount(), 25_000);
    assert.ok(
      scheduler.indexSize() <= 2 * scheduler.activeCount() + 1,
      `index=${scheduler.indexSize()} active=${scheduler.activeCount()}`,
    );
  });

  it('reports access counts that are monotonic', () => {
    const scheduler = new DeadlineScheduler();
    const before = scheduler.heapAccessCount();
    scheduler.register('a', 1n, () => {});
    const afterRegister = scheduler.heapAccessCount();
    assert.ok(afterRegister > before);
    scheduler.advance({ target: 10n });
    assert.ok(scheduler.heapAccessCount() > afterRegister);
    assert.ok(scheduler.mapAccessCount() > 0);
  });
});

describe('the required interleaving scenario', () => {
  it('cancels the next item and re-registers the same RPC id inside a callback', () => {
    const scheduler = new DeadlineScheduler();
    const log: string[] = [];

    // 'a' is due first.  When it fires it cancels 'b' (the next item) and
    // re-registers id 'a' at a later deadline.  The old generation's expiry must
    // not trigger the new registration, and 'b' must never run.
    let newHandle!: DeadlineHandle;
    const aOld = scheduler.register('a', 10n, () => {
      log.push(`a-old fired at ${scheduler.now()}`);
      assert.equal(scheduler.cancel(nextB), true);
      newHandle = scheduler.register('a', 100n, () => log.push(`a-new fired at ${scheduler.now()}`));
    });
    const nextB = scheduler.register('b', 11n, () => log.push('b fired (wrong)'));

    const first = scheduler.advance({ target: 10n });
    assert.deepEqual(log, ['a-old fired at 10']);
    assert.equal(first.callbacks, 1);
    assert.equal(first.hasMore, false);

    // Old handle is dead; the new generation is the only active registration.
    assert.equal(scheduler.isActive(aOld), false);
    assert.equal(scheduler.isActive(newHandle), true);
    assert.equal(scheduler.activeCount(), 1);

    // A stale handle cannot cancel or reschedule the new generation.
    assert.equal(scheduler.cancel(aOld), false);
    assert.equal(scheduler.reschedule(aOld, 50n), false);
    assert.equal(scheduler.deadlineOf(newHandle), 100n);

    // 'b' was cancelled; it stays silent across every future target.
    scheduler.advance({ target: 99n });
    assert.deepEqual(log, ['a-old fired at 10']);

    scheduler.advance({ target: 100n });
    assert.deepEqual(log, ['a-old fired at 10', 'a-new fired at 100']);

    assert.deepEqual(
      scheduler.expiries().map((e) => [e.rpcId, e.generation, e.deadline]),
      [
        ['a', aOld.generation, 10n],
        ['a', newHandle.generation, 100n],
      ],
    );
    assert.notEqual(newHandle.generation, aOld.generation);
    assert.deepEqual(
      scheduler.cancellations().map((c) => [c.rpcId, c.generation]),
      [['b', nextB.generation]],
    );
  });

  it('keeps exactly one terminal per registration across a mixed workload', () => {
    const scheduler = new DeadlineScheduler();
    const handles: DeadlineHandle[] = [];
    for (let i = 0; i < 200; i++) {
      const shouldThrow = i % 7 === 0;
      handles.push(
        scheduler.register(`rpc-${i % 20}`, BigInt(i), () => {
          if (shouldThrow) throw new Error(`fail-${i}`);
        }),
      );
    }
    scheduler.advance({ target: 1000n });

    const byGeneration = new Map<number, string[]>();
    const add = (generation: number, kind: string) => {
      const list = byGeneration.get(generation) ?? [];
      list.push(kind);
      byGeneration.set(generation, list);
    };
    for (const e of scheduler.expiries()) add(e.generation, e.failed ? 'timeout' : 'fired');
    for (const c of scheduler.cancellations()) add(c.generation, 'cancelled');

    // Generation reuse: each id was registered 10 times; only its last
    // registration survives, so exactly 20 registrations reach a terminal.
    assert.equal(scheduler.activeCount(), 0);
    assert.equal(scheduler.expiries().length, 20);
    assert.equal(scheduler.cancellations().length, 0);
    for (const [generation, kinds] of byGeneration) {
      assert.equal(kinds.length, 1, `generation ${generation} ended ${kinds.length} times`);
    }
    // 20 ids x 10 generations each; only the last generation of each id (indices
    // 180..199) ever runs, so only those can throw.
    let expectedTimeouts = 0;
    for (let i = 180; i < 200; i++) if (i % 7 === 0) expectedTimeouts++;
    assert.equal(scheduler.timeouts().length, expectedTimeouts);
    assert.ok(expectedTimeouts > 0);
    assert.equal(
      scheduler.expiries().filter((e) => e.failed).length,
      scheduler.timeouts().length,
    );

    // Every handle that was superseded before finishing must be inactive.
    for (const handle of handles) {
      assert.equal(scheduler.isActive(handle), false);
    }
  });
});

describe('argument validation', () => {
  it('rejects empty rpc ids and non-function callbacks', () => {
    const scheduler = new DeadlineScheduler();
    assert.throws(() => scheduler.register('', 1n, () => {}), TypeError);
    // @ts-expect-error deliberately wrong callback type
    assert.throws(() => scheduler.register('x', 1n, 5), TypeError);
  });

  it('rejects invalid targets and budgets', () => {
    const scheduler = new DeadlineScheduler();
    assert.throws(() => scheduler.advance({ maxCallbacks: -1 }), RangeError);
    assert.throws(() => scheduler.advance({ maxCallbacks: 1.5 }), RangeError);
    // @ts-expect-error deliberately wrong number type
    assert.throws(() => scheduler.advance({ target: 1.5 }), RangeError);
  });

  it('never moves the clock backwards', () => {
    const scheduler = new DeadlineScheduler({ now: 100n });
    scheduler.advance({ target: 50n });
    assert.equal(scheduler.now(), 100n);
    scheduler.register('r', 10n, () => {});
    scheduler.advance();
    assert.equal(scheduler.now(), 100n, 'past deadlines fire without rewinding the clock');
  });
});
