/**
 * Deterministic end-to-end demo of the deadline propagation module.
 *
 * Run with: npm run demo
 *
 * Everything uses a ManualClock, so the "queue wait" is exact and the demo
 * finishes in milliseconds without sleeping.
 */

import {
  DeadlineDispatcher,
  ManualClock,
  ScopeEndedError,
  parseProtocolABudget,
  receiveCall,
  withCall,
} from '../src/index.ts';

const clock = new ManualClock(0n);
const dispatcher = new DeadlineDispatcher({ clock });

// 1. A request arrives carrying protocol-A's maximum timeout (24.8 days).
const root = receiveCall(parseProtocolABudget(2_147_483_647), {
  clock,
  root: true,
  label: 'inbound',
});
console.log(`root deadline: ${root.deadline}ns (receipt ${clock.now()}ns)`);

// 2. Two sibling downstream calls are queued. Neither gets a timeout yet.
const slow = dispatcher.submit({ parent: root, protocol: 'A', label: 'slow' });
clock.advance(10_000_000_000n);
const fast = dispatcher.submit({ parent: root, protocol: 'B', budget: '10S', label: 'fast' });
const doomed = dispatcher.submit({ parent: root, protocol: 'B', budget: '5S', label: 'doomed' });

// 3. The transport leaves them in the queue for a while. `fast` asked for 10s
//    but only 1ms remains when it is dequeued.
clock.advance(9_999_000_000n);
console.log(`after queue hold, root remaining: ${root.remainingNanos()}ns`);
console.log(`fast remaining at dequeue:        ${fast.scope.remainingNanos()}ns`);

// 4. Only now, at actual dequeue, is each outgoing budget computed.
const fastOutcome = dispatcher.dispatch(fast);
console.log(`fast  -> ${fastOutcome.status} ${fastOutcome.status === 'sent' ? fastOutcome.wire : ''}`);

const slowOutcome = dispatcher.dispatch(slow);
console.log(`slow  -> ${slowOutcome.status} ${slowOutcome.status === 'sent' ? slowOutcome.wire : ''}`);

// 5. Siblings are independent: cancelling one leaves the others alone.
doomed.scope.cancel();
console.log(`doomed scope: ${doomed.scope.endState?.reason}; slow settled: ${slow.status}`);

// 6. A late dequeue notification for the cancelled call never sends it and
//    never revives its scope.
const late = dispatcher.dispatch(doomed);
console.log(`late dequeue for doomed -> ${late.status} (scope still ${doomed.scope.endState?.reason})`);

// 7. withCall turns a relative budget into a scope and refuses to run when the
//    parent has already ended.
try {
  await withCall({ budget: '1S', parent: doomed.scope, clock }, () => {
    throw new Error('unreachable: body must not run');
  });
} catch (error) {
  if (error instanceof ScopeEndedError) {
    console.log(`child of cancelled scope rejected: ${error.reason}/${error.endCause}`);
  } else {
    throw error;
  }
}

root.complete();
console.log(`root ended: ${root.endState?.reason}; pending calls: ${dispatcher.pending.length}`);
