# Batched configuration release controller

A small, dependency-free TypeScript implementation of a **staged configuration
rollout** for Node.js:

* a candidate config is installed on one batch of instances at a time;
* the batch observes its instances for a fixed window and only then decides;
* on success the next batch starts; on failure later batches are stopped and
  every instance the release already touched is rolled back to **its own**
  previous config — unless somebody else changed it in the meantime.

Everything is deterministic and locally verifiable: the clock is manual, and
install receipts and health reports are delivered explicitly.

```bash
npm test          # full suite (node:test + built-in TS type stripping)
npm run demo      # narrated run of the failure/rollback scenario
```

Requirements: Node.js ≥ 22.6 (this repo is verified on Node 26). No build step,
no dependencies, no compiler — Node executes the `.ts` sources directly using
type erasure.

---

## Quick start

```ts
import {
  ConfigReleaseController,
  InMemoryInstanceAdapter,
  ManualClock,
} from './src/index.ts';

const clock = new ManualClock(0);
const controller = new ConfigReleaseController({ clock });

const original = { checkout: { timeoutMs: 2000 } };
const candidate = { checkout: { timeoutMs: 800 } };

for (const id of ['edge-1', 'edge-2', 'edge-3']) {
  controller.registerAdapter(
    new InMemoryInstanceAdapter({
      instanceId: id,
      generation: 1,          // process generation, frozen per batch
      initialConfig: original,
      clock,
    }),
  );
}

const releaseId = controller.startRelease({
  candidate,
  batches: [['edge-1'], ['edge-2', 'edge-3']],
  observationMs: 10_000,     // window length per batch
  minValidSamples: 1,        // valid samples required per batch
  successRatio: 1,           // successes / frozen instances
});

// Health reports are bound to the instance identity and the install id that
// the install receipt reported.
const view = controller.explain(releaseId);
const install = view.batches[0].instances[0];
controller.reportHealth({
  instanceId: 'edge-1',
  generation: install.generation,
  installId: install.installId,
  seq: 1,
  healthy: true,
});

clock.advance(10_000);
controller.tick();           // decides batch 0, opens batch 1
console.log(controller.explain(releaseId).summary.join('\n'));
```

---

## Domain model

| Concept | Meaning |
| --- | --- |
| **Release** | One candidate config rolled out over an ordered list of batches. |
| **Batch** | A set of instances. The batch freezes its instance ids **and process generations** when it starts. |
| **Install id** | Unique id generated per instance install. Receipts and health reports carry it. |
| **Intent** | Per-instance monotonic counter. Adapters reject any command whose intent is not strictly newer. |
| **Observation window** | `[openedAt, openedAt + observationMs)` per batch, started when the batch opens. |
| **Valid sample** | One per frozen identity: the latest health report received while the window is open, from an instance whose candidate install is confirmed with matching identity and install id. |
| **Decision** | Taken only once the window has closed. `successes / frozenTotal >= successRatio` **and** `validSamples >= minValidSamples`. |

### Where the clock and control points live

* `ManualClock` — only `advance()` / `set()` move time; nothing reads wall time.
* `controller.tick()` — the only place a batch can be decided. Calling `explain()`
  never mutates state.
* `adapter.holdCommands()`, `drainHeldCommands()`, `deliverCommand(cmd)` — model a
  slow or reordering link between controller and instance.
* `adapter.beginHold()`, `releaseHeld()`, `deliver(receipt)` — model a receipt
  that arrives after the controller has already moved on.
* `adapter.applyExternalConfig(cfg)` — an operator changing config out of band.
* `adapter.crash()` / `restart({ bumpGeneration })` — a host going away and
  coming back on a new process generation.
* `controller.reportHealth(report)` — every health report, with a per-instance
  `seq`.

---

## Guarantees and how they are enforced

### 1. Windows are timed from the batch start and identities are frozen

`startRelease` opens batch 0 and records `openedAt`; each later batch opens at
the clock time of the tick that decided the previous one — never backdated.
Frozen `{ instanceId, generation }` pairs are the only identities whose reports
can count. A report from another generation is refused with
`generation-mismatch`; a report naming an unconnected instance with
`unknown-instance`.

### 2. Only confirmed installs produce samples

An install command carries `installId` and the frozen `generation`. Its
receipt reports the **config that was actually replaced** (`replacedConfig`)
and the same `installId`. A health report counts only if all of the following
hold:

1. the batch is currently observing (not `pending`, not decided);
2. `now < closesAt` (`window-closed` otherwise);
3. `report.generation === frozen generation` (`generation-mismatch`);
4. the install for this instance is `confirmed` (`install-not-confirmed`);
5. `report.installId === installId` (`install-mismatch`);
6. `report.seq` is greater than any sequence already seen
   (`duplicate-or-stale-seq`).

Because of (6), repeated reports never add another sample, and a later report
**replaces** the earlier one — so a batch that looked healthy early can still
fail if the last report before the close is unhealthy.

`reportHealth` always answers with an `accepted` flag and a reason, so callers
can tell *why* a report did not count:

| reason | when |
| --- | --- |
| `accepted` | became (or replaced) this identity's sample |
| `duplicate-or-stale-seq` | `seq` was not newer than the highest already seen |
| `generation-mismatch` | report came from a process generation other than the frozen one |
| `install-mismatch` | report named a different install id than this batch's candidate |
| `install-not-confirmed` | the install receipt for this batch's install has not arrived |
| `window-closed` | the batch was already decided, or `now >= closesAt` |
| `release-not-active` | no release is running, or the instance belongs to an older one |
| `unknown-instance` | the instance is not part of this release (or its batch has not started) |

### 3. Decisions happen only when the window closes

`tick()` decides a batch only when `clock.now() >= closesAt`. The sample set is
therefore whatever existed inside the window, even if `tick()` itself is called
late. A not-yet-ticked but elapsed window is reported as
`window.pendingDecision = true`.

The ratio denominator is `frozenTotal`, the number of instances frozen at batch
start. Instances whose install was never confirmed, or that never produced an
accepted report, are counted in the denominator and cannot be successes.

### 4. Failure stops the release and rolls back what was touched

A failed batch marks later batches `skipped` and starts a rollback over every
instance in earlier batches and the failed one:

* `confirmed` install → conditional restore is sent immediately, targeting the
  `replacedConfig` from that instance's own receipt;
* `pending-receipt` → rollback is **parked** (`awaiting-install-receipt`) and
  sent the moment the install receipt arrives;
* `rejected` / `not-delivered` → nothing was changed, nothing to undo.

Rollback outcomes are reported per instance:

| status | meaning |
| --- | --- |
| `restored` | conditional restore applied |
| `awaiting-install-receipt` | parked, install receipt still missing |
| `awaitingRestoreReceipt` (summary) | restore sent, receipt outstanding |
| `skipped-condition` | current install is no longer ours (external edit, another release, already restored, or a newer intent already won) — **change preserved** |
| `not-delivered` | adapter refused the command (e.g. process down) |
| `not-needed` | install never took effect |

### 5. Adapters fence by intent and restore conditionally

`InMemoryInstanceAdapter` applies commands only when `command.intent >
lastIntent`; the fence advances even when the newer command is rejected by its
own condition, so an older retry can never resurrect stale intent. Installs
also require a matching process generation (`wrong-generation`). Restores are
conditional: they apply only if the currently installed config is still owned
by the release that requests the rollback (`expectedReleaseId`), otherwise the
adapter answers `condition-mismatch` and leaves state untouched.

### 6. A new release supersedes the old one

`startRelease` while another release is running marks the old one `superseded`,
abandons its observing/pending batches, and ignores every later receipt for it
(`ignoredReceipts`). Its already-applied installs are replaced by the new
release's installs through the intent fence. A rollback that was still parked
waiting for an install receipt is **withdrawn** for any instance the new
release claims, so it can never fire later from stale data; a rollback for an
instance nobody else took over stays parked and still completes.

---

## Querying

`controller.explain(releaseId?)` returns a complete, side-effect-free account:

```ts
{
  releaseId, status: 'running' | 'succeeded' | 'failed' | 'superseded',
  active, candidate, observationMs, minValidSamples, successRatio,
  createdAt, finishedAt, currentBatchIndex,
  batches: [{
    index, status, plannedInstanceIds, frozen: [{ instanceId, generation }],
    window: { openedAt, closesAt, closedAt, elapsed, pendingDecision },
    live: { frozenTotal, confirmedInstalls, validSamples, successes,
            unhealthy, pendingReceipt, installRejected, notDelivered,
            missingReport, ratio },
    decision?: { advanced, reasons, message, decidedAt, ...counts },
    instances: [{
      instanceId, generation, installId,
      install: { status, intent, commandSentAt, confirmedAt,
                 replacedConfig, rejectionReason, note },
      health:  { hasReport, latestSeq, healthy, receivedAt,
                 acceptedReports, sampleStatus, lastRejection },
      restore: { status, intent, targetConfig, requestedAt, settledAt, reason },
      ignoredReceipts,
    }],
  }],
  restoreRequested,
  restoreSummary: { restored, awaitingInstallReceipt, awaitingRestoreReceipt,
                    notDelivered, skippedCondition, rejected, notNeeded },
  ignoredReceipts,
  summary: ['batch 0: advanced: …', 'batch 1: failed: …', 'rollback: 4 restored, …'],
}
```

`summary` is the human-readable version: one line per batch plus rollback
outcomes, including which instances are parked, skipped, or not delivered.

---

## The demo scenario (`npm run demo`)

Five instances, two batches, `observationMs = 10_000`, `successRatio = 0.9`,
`minValidSamples = 2`:

1. batch 0 (`edge-1..3`) all healthy → advances;
2. batch 1 (`edge-4`, `edge-5`) opens; `edge-5` is healthy early and reports
   unhealthy 100 ms before the window closes; `edge-4`'s install receipt is
   held in transit, so it is not a valid sample either;
3. `edge-3` is hotfixed by an operator before the rollback is sent;
4. the window closes → batch 1 fails on both ratio and sample count; later
   batches would be skipped; `edge-1`, `edge-2`, `edge-5` are restored;
   `edge-3` is skipped (external change preserved); `edge-4` is parked;
5. `edge-4`'s receipt finally arrives → its parked rollback is sent and
   `edge-4` is restored.

The exit code is non-zero if the demo does not end in exactly this state.

## Layout

```
src/types.ts        shared domain types (commands, receipts, reports, views)
src/clock.ts        ManualClock, config cloning/equality helpers
src/adapter.ts      InMemoryInstanceAdapter: intent fence, conditional restore,
                    controllable delivery of commands and receipts
src/controller.ts   ConfigReleaseController: batching, windows, health
                    accounting, decisions, rollback, explanation
src/index.ts        public module entry point
src/demo.ts         narrated end-to-end scenario (npm run demo)
test/*.test.ts      node:test suites (npm test)
```

## Test suites

| file | covers |
| --- | --- |
| `test/batches.test.ts` | batching, window timing, thresholds, denominators |
| `test/health.test.ts` | identity/install binding, latest-seq semantics, window edges |
| `test/rollback.test.ts` | failure rollback, per-instance target config, parked rollback, rejections |
| `test/intent.test.ts` | intent fence, superseded releases, stale rollback, withdrawn rollback |
| `test/adapter.test.ts` | adapter-level receipts, fences, conditions, crash |
| `test/query.test.ts` | validation, explanation accuracy, pending decisions |
| `test/port.test.ts` | controller driven through a hand-written `AdapterPort` |
| `test/scenario.test.ts` | the full spec scenario and a superseded-race variant |
