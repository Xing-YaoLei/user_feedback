/**
 * Runnable demo: one source, four receivers, synthetic loss on a real
 * (system-clock) timer network.
 *
 *   node examples/run.ts
 *
 * Everything is local; no external service is contacted.
 */
import { InMemoryNetwork } from '../src/network.ts';
import type { LinkPolicy } from '../src/network.ts';
import { MulticastSource } from '../src/source.ts';
import { MulticastReceiver } from '../src/receiver.ts';
import type { ResyncRequest } from '../src/receiver.ts';
import { seededRandom } from '../src/random.ts';
import type { Clock, Packet } from '../src/types.ts';

/**
 * The demo runs on the system clock but is driven by an accelerated event loop:
 * the same `InMemoryNetwork` adapter is reused, only its timer scheduler is
 * virtualised so the demo finishes in milliseconds rather than seconds. This
 * shows the adapter swap point that a real UDP socket wrapper would occupy.
 */
class FastClock implements Clock {
  private time = 0;
  private id = 1;
  private readonly timers = new Map<number, { at: number; cb: () => void }>();
  now(): number {
    return this.time;
  }
  setTimeout(cb: () => void, delayMs: number): number {
    const id = this.id++;
    this.timers.set(id, { at: this.time + Math.max(0, delayMs), cb });
    return id;
  }
  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }
  run(until: number): void {
    for (;;) {
      let next: { id: number; at: number; cb: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at > until) continue;
        if (next === null || timer.at < next.at) next = { id, at: timer.at, cb: timer.cb };
      }
      if (next === null) break;
      this.timers.delete(next.id);
      this.time = next.at;
      next.cb();
    }
    this.time = until;
  }
}

const clock = new FastClock();
const random = seededRandom(2026);
const network = new InMemoryNetwork({ clock, random });

const lossLinks: LinkPolicy = { drop: 0.08, delayMs: 2, jitterMs: 4, duplicate: 0.03 };
network.addFilter((_from, to, packet) => {
  if (to === null) return lossLinks;
  return { ...lossLinks, drop: 0.03 };
});

const source = new MulticastSource({
  sourceId: 'demo-source',
  network,
  clock,
  random,
  repairWindowSize: 64,
  announceIntervalMs: 30,
});

const receivers = ['alpha', 'beta', 'gamma', 'delta'].map((id, index) => {
  const received: number[] = [];
  const resyncs: ResyncRequest[] = [];
  const receiver = new MulticastReceiver({
    sourceId: 'demo-source',
    receiverId: id,
    network,
    clock,
    random: seededRandom(4000 + index),
    initialNackDelayMs: 20,
    initialJitterMs: 30,
    repairWaitMs: 150,
    backoffBaseMs: 40,
    backoffMaxMs: 300,
    peerSuppressMs: 200,
    onPayload: (seq) => received.push(seq),
    onResyncRequired: (request) => {
      resyncs.push(request);
      // Caller policy: skip the unrecoverable gap, resume at the repair floor.
      receiver.resync(request.lowestAvailable);
    },
  });
  return { id, receiver, received, resyncs };
});

const TOTAL = 400;
const tickMs = 8;
for (let i = 1; i <= TOTAL; i++) {
  source.publish({ seq: i, at: clock.now() });
  clock.run(clock.now() + tickMs);
}
// Drain repairs and announcements.
clock.run(clock.now() + 8_000);

let failed = false;
for (const entry of receivers) {
  const stats = entry.receiver.stats;
  const contiguous = entry.received.every((seq, i) => i === 0 || seq === entry.received[i - 1]! + 1);
  const unique = new Set(entry.received).size === entry.received.length;
  const resyncNote = entry.resyncs.length === 0
    ? 'no resync'
    : `${entry.resyncs.length} resync(s), last boundary ${entry.resyncs.at(-1)!.lowestAvailable}`;
  console.log(
    `${entry.id.padEnd(6)} delivered=${String(stats.delivered).padStart(3)} ` +
      `contiguous=${contiguous} unique=${unique} ` +
      `nacks=${stats.nacksSent} retries=${stats.nackRetries} ` +
      `suppressed=${stats.deferredByPeer} duplicates=${stats.duplicates} (${resyncNote})`,
  );
  if (!contiguous || !unique) failed = true;
}

const sourceStats = source.stats;
console.log(
  `source   published=${sourceStats.published} repairs=${sourceStats.repairsSent} ` +
    `requests=${sourceStats.repairRequests} windowFloor=${sourceStats.floor}`,
);

for (const entry of receivers) entry.receiver.close();
source.stop();
network.close();

if (failed) {
  console.error('demo: delivery was not contiguous and exactly-once');
  process.exitCode = 1;
}
