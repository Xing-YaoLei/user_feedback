import { DeadlineScheduler } from './index.ts';

/**
 * Demonstrates the scheduler end to end on synthetic data:
 *  - a large set of not-yet-due deadlines is skipped without scanning,
 *  - a single RPC is rescheduled many times without retaining stale nodes,
 *  - a callback cancels the next due item and re-registers the same RPC id.
 */
function main(): void {
  const scheduler = new DeadlineScheduler({ now: 0n });

  // One hundred thousand deadlines; only four are due at t=1_000.
  for (let i = 0; i < 100_000; i++) {
    scheduler.register(`rpc-${i}`, 1_000_000_000_000n + BigInt(i), () => {});
  }
  for (let i = 0; i < 4; i++) {
    scheduler.register(`urgent-${i}`, 1_000n, () => {});
  }

  const first = scheduler.advance({ target: 1_000n });
  console.log(
    `due now: ${first.callbacks} callback(s), ` +
      `${first.access.heap} heap access(es), ${first.access.map} map lookup(s)`,
  );

  // A single active RPC rescheduled a million times: the index stays tiny.
  const repeated = scheduler.register('churn', 2n, () => {});
  for (let i = 0; i < 1_000_000; i++) {
    scheduler.reschedule(repeated, 2_000_000_000n + BigInt(i));
  }
  console.log(
    `after 1e6 reschedules: active=${scheduler.activeCount()} index=${scheduler.indexSize()}`,
  );

  // Cancel the next due item from inside a callback, then re-register the same id.
  let fired: string[] = [];
  scheduler.register('a', 10_000n, () => {
    fired.push('old-a');
    scheduler.cancel(handleB);
    scheduler.register('a', 10_000n, () => {
      fired.push('new-a');
    });
  });
  const handleB = scheduler.register('b', 10_001n, () => {
    fired.push('b');
  });

  scheduler.advance({ target: 10_000n });
  scheduler.advance({ target: 10_001n });
  console.log(`fired: ${fired.join(', ')} (expected: old-a, new-a)`);

  const cancels = scheduler.cancellations();
  const timeouts = scheduler.timeouts();
  console.log(
    `records: ${scheduler.expiries().length} expiry, ${cancels.length} cancel, ` +
      `${timeouts.length} timeout`,
  );
}

main();
