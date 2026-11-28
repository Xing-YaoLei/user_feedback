import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageStore, InvalidLineageError, type RecordId, type Topology } from "../src/index.ts";

/**
 * A topology with two sink partitions so per-partition terminal reporting and
 * independent source-partition commit frontiers can be exercised.
 */
const TOPOLOGY: Topology = {
  stages: [
    { name: "src", kind: "source" },
    { name: "mid", kind: "intermediate" },
    { name: "out", kind: "sink" },
  ],
  edges: [
    { from: "src", to: "mid" },
    { from: "mid", to: "out" },
  ],
};

const rid = (
  stage: string,
  partition: number,
  offset: number,
  generation = 0,
): RecordId => ({ stage, partition, generation, offset });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lineage-recovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("partitions are independent streams with their own frontier and reports", () => {
  const dir = join(root, "multi");
  const store = LineageStore.open(dir, TOPOLOGY);

  // Two source partitions, each with its own gap-free offsets.
  store.registerRecord(rid("src", 0, 0));
  store.registerRecord(rid("src", 1, 0));
  store.registerRecord(rid("src", 0, 1));

  store.registerOutput(rid("mid", 0, 0), [rid("src", 0, 0)]);
  store.registerOutput(rid("mid", 1, 0), [rid("src", 1, 0)]);
  store.registerOutput(rid("mid", 0, 1), [rid("src", 0, 1)]);
  store.registerOutput(rid("out", 0, 0), [rid("mid", 0, 0)]);
  store.registerOutput(rid("out", 1, 0), [rid("mid", 1, 0)]);
  store.registerOutput(rid("out", 0, 1), [rid("mid", 0, 1)]);

  for (const p of [0, 1]) {
    store.seal(rid("src", p, 0));
  }
  store.seal(rid("src", 0, 1));
  store.seal(rid("mid", 0, 0));
  store.seal(rid("mid", 1, 0));
  store.seal(rid("mid", 0, 1));
  store.seal(rid("out", 0, 0));
  store.seal(rid("out", 1, 0));
  store.seal(rid("out", 0, 1));

  // Confirm only partition 0 of the sink, both offsets.
  store.confirm(rid("out", 0, 0));
  store.confirm(rid("out", 0, 1));

  assert.equal(store.getSourceCommitFrontier("src", 0, 0), 2);
  assert.equal(store.getSourceCommitFrontier("src", 1, 0), 0);

  const reportP0 = store.getSinkReport("out", 0, 0);
  assert.equal(reportP0.confirmedFrontier, 2);
  assert.deepEqual(reportP0.intervals, [{ start: 0, end: 2 }]);

  const reportP1 = store.getSinkReport("out", 1, 0);
  assert.equal(reportP1.confirmedFrontier, 0);
  assert.deepEqual(reportP1.intervals, []);
  assert.equal(reportP1.maxOffset, 1);

  // Rejecting a gap inside one partition does not affect the other partition.
  assert.throws(() => store.registerRecord(rid("src", 0, 3)), InvalidLineageError);
  store.registerRecord(rid("src", 1, 1)); // partition 1 still contiguous
  store.close();
});

test("crash recovery: WAL-only replay reproduces state and keeps published frontier", () => {
  const dir = join(root, "crash");
  const store = LineageStore.open(dir, TOPOLOGY);

  store.registerRecord(rid("src", 0, 0));
  store.registerOutput(rid("mid", 0, 0), [rid("src", 0, 0)]);
  store.registerOutput(rid("out", 0, 0), [rid("mid", 0, 0)]);
  store.seal(rid("src", 0, 0));
  store.seal(rid("mid", 0, 0));
  store.seal(rid("out", 0, 0));

  // Force a snapshot/WAL rotation, then keep mutating WITHOUT another
  // checkpoint — simulating a crash with un-snapshotted WAL events.
  store.checkpoint();
  assert.equal(readdirSync(dir).filter((f) => f === "wal.log").length, 1);

  store.confirm(rid("out", 0, 0));
  assert.equal(store.getSourceCommitFrontier("src", 0, 0), 1);
  store.registerRecord(rid("src", 0, 1)); // incomplete, must be re-materialized
  store.close();

  const walText = readdirSync(dir);
  assert.ok(walText.includes("snapshot.json"));
  assert.ok(walText.includes("wal.log"));

  const reopened = LineageStore.open(dir);
  // Published safe frontier survives the replay.
  assert.equal(reopened.getSourceCommitFrontier("src", 0, 0), 1);
  // The un-snapshotted registration was replayed too.
  assert.equal(reopened.getStats().totalRecords, 4);
  assert.equal(
    reopened.getRecordState(rid("src", 0, 1)).complete,
    false,
  );
  assert.deepEqual(reopened.getSinkReport("out", 0, 0).intervals, [
    { start: 0, end: 1 },
  ]);

  // The lineage can continue after recovery and eventually drain.
  reopened.registerOutput(rid("mid", 0, 1), [rid("src", 0, 1)]);
  reopened.registerOutput(rid("out", 0, 1), [rid("mid", 0, 1)]);
  reopened.seal(rid("src", 0, 1));
  reopened.seal(rid("mid", 0, 1));
  reopened.seal(rid("out", 0, 1));
  reopened.confirm(rid("out", 0, 1));
  assert.equal(reopened.getSourceCommitFrontier("src", 0, 0), 2);
  reopened.close();

  // A second restart from the rotated WAL is still consistent.
  const again = LineageStore.open(dir);
  assert.equal(again.getSourceCommitFrontier("src", 0, 0), 2);
  assert.equal(again.getSinkReport("out", 0, 0).confirmedFrontier, 2);
  again.close();
});

test("compaction preserves multi-generation summaries and uncommitted live lineage", () => {
  const dir = join(root, "compact");
  const store = LineageStore.open(dir, TOPOLOGY);

  // Generation 0: fully drain two offsets.
  for (const off of [0, 1]) {
    store.registerRecord(rid("src", 0, off));
    store.registerOutput(rid("mid", 0, off), [rid("src", 0, off)]);
    store.registerOutput(rid("out", 0, off), [rid("mid", 0, off)]);
    store.seal(rid("src", 0, off));
    store.seal(rid("mid", 0, off));
    store.seal(rid("out", 0, off));
    store.confirm(rid("out", 0, off));
  }
  assert.equal(store.getSourceCommitFrontier("src", 0, 0), 2);
  const firstStats = store.compact();
  assert.ok(firstStats.evictedRecords >= 6);

  // Generation 1: an incomplete record must survive compaction.
  store.registerRecord({ stage: "src", partition: 0, generation: 1, offset: 0 });
  const secondStats = store.compact();
  assert.equal(secondStats.evictedRecords, 0);
  assert.equal(secondStats.remainingRecords, 1);
  assert.equal(store.getSourceCommitFrontier("src", 0, 0), 2);
  assert.equal(store.getSourceCommitFrontier("src", 0, 1), 0);

  // Late confirmation against the compacted generation is still recognized.
  assert.equal(store.confirm({ stage: "out", partition: 0, generation: 0, offset: 0 }), false);

  // Restart after compaction: summaries alone keep frontiers valid.
  store.close();
  const reopened = LineageStore.open(dir);
  assert.equal(reopened.getSourceCommitFrontier("src", 0, 0), 2);
  assert.equal(reopened.getSourceCommitFrontier("src", 0, 1), 0);
  assert.equal(reopened.getStats().totalRecords, 1);
  assert.ok(existsSync(join(dir, "snapshot.json")));
  reopened.close();
});
