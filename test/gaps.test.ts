import test from "node:test";
import assert from "node:assert/strict";

import { DiscoverySynthesizer } from "../src/index.ts";
import { TOMBSTONE, batch, delta, snapshot, value } from "./helpers.ts";

function makeSynth(): DiscoverySynthesizer {
  return new DiscoverySynthesizer({
    sources: [
      { sourceId: "primary", priority: 0 },
      { sourceId: "fallback", priority: 10 },
    ],
  });
}

const FALLBACK_RECORD = snapshot("fallback", 1, 0, 60_000, {
  "svc-a": { i1: value("fallback-value") },
});

test("gap disables the whole source view until a fresh snapshot", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("primary-value") } })],
      [1_000, FALLBACK_RECORD],
      // sequence 1 is missing
      [2_000, delta("primary", 1, 2, 60_000, "svc-a", "i1", value("stale"))],
    ),
  );

  // The primary contributed nothing and its whole view is dropped: the
  // fallback answers instead.
  const afterGap = synth.resolve("svc-a", "i1", 3_000);
  assert.equal(afterGap.state, "available");
  assert.equal(afterGap.state === "available" ? afterGap.value : null, "fallback-value");
  assert.equal(afterGap.source?.sourceId, "fallback");
  assert.equal(synth.issueOf("primary", 3_000)?.reason, "gap");
  assert.equal(synth.status("primary", 3_000).blocked, true);

  // Deltas cannot recover it.
  synth.apply(batch([3_000, delta("primary", 1, 3, 60_000, "svc-a", "i1", value("later"))]));
  assert.equal(synth.resolve("svc-a", "i1", 4_000).source?.sourceId, "fallback");

  // A fresh full snapshot can.
  synth.apply(batch([4_000, snapshot("primary", 1, 9, 60_000, { "svc-a": { i1: value("rebuilt") } })]));
  const rebuilt = synth.resolve("svc-a", "i1", 5_000);
  assert.equal(rebuilt.source?.sourceId, "primary");
  assert.equal(rebuilt.state === "available" ? rebuilt.value : null, "rebuilt");
  assert.equal(synth.issueOf("primary", 5_000), null);
});

test("a failed gap recovery attempt is not re-reported with an invalid reason", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 60_000, {})],
      [2_000, delta("primary", 1, 5, 60_000, "svc-a", "i1", value("x"))],
    ),
  );
  assert.equal(synth.issueOf("primary", 2_500)?.reason, "gap");
  // A well-formed but out-of-order update leaves the gap issue intact.
  synth.apply(batch([3_000, delta("primary", 1, 6, 60_000, "svc-a", "i2", value("y"))]));
  assert.equal(synth.issueOf("primary", 3_500)?.reason, "gap");
});

test("a gap only affects its own source, never the rest of the view", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p"), i2: value("p2") } })],
      [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value("f") } })],
      [2_000, delta("primary", 1, 4, 60_000, "svc-a", "i1", value("gap"))],
    ),
  );
  const view = synth.query(3_000);
  const i2 = view.instances.find((entry) => entry.instanceId === "i2");
  // i2 was only ever in the primary, whose view is now unusable.
  assert.equal(i2, undefined);
  assert.equal(synth.status("fallback", 3_000).usable, true);
});

test("a delta with no baseline at all is rejected as a gap", () => {
  const synth = makeSynth();
  const outcome = synth.apply(
    batch([1_000, delta("primary", 1, 0, 60_000, "svc-a", "i1", value("x"))]),
  );
  assert.equal(outcome.outcome, "rejected");
  assert.equal(outcome.results[0]?.reason, "gap");
  assert.equal(synth.issueOf("primary", 1_000)?.reason, "gap");
});

test("a delta for a new generation does not carry the old generation's facts", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("old") } })]));
  // Generation 2 arrives as a delta (missing its snapshot).
  synth.apply(batch([2_000, delta("primary", 2, 1, 60_000, "svc-a", "i2", value("new"))]));
  assert.equal(synth.resolve("svc-a", "i1", 3_000).state, "absent");
  assert.equal(synth.resolve("svc-a", "i2", 3_000).state, "absent");
  assert.equal(synth.status("primary", 3_000).generation, 2);
});

test("tombstones disappear with the rest of a lapsed view", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 5_000, { "svc-a": { i1: value("v"), i2: value("v2") } })],
      [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value("f"), i2: value("f2") } })],
      [2_000, delta("primary", 1, 1, 5_000, "svc-a", "i2", TOMBSTONE)],
    ),
  );
  assert.equal(synth.resolve("svc-a", "i2", 3_000).state, "deleted");

  // The primary's window closes; its tombstone lapses with its values.
  const after = synth.resolve("svc-a", "i2", 10_000);
  assert.equal(after.state, "available");
  assert.equal(after.state === "available" ? after.value : null, "f2");
  assert.equal(after.source?.sourceId, "fallback");
});
