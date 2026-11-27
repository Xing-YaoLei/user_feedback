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

test("the validity window is measured from local receipt and ends exactly at receiptAt + ttl", () => {
  const synth = makeSynth();
  synth.apply(batch([10_000, snapshot("primary", 1, 0, 3_000, { "svc-a": { i1: value("v") } })]));

  assert.equal(synth.status("primary", 12_999).usable, true);
  assert.equal(synth.status("primary", 13_000).usable, false);
  assert.equal(synth.status("primary", 12_999).expiresAt, 13_000);
  assert.equal(synth.resolve("svc-a", "i1", 12_999).state, "available");
  assert.equal(synth.resolve("svc-a", "i1", 13_000).state, "absent");
});

test("each accepted update re-declares the whole view's validity from its own receipt", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 2_000, { "svc-a": { i1: value("a") } })]));
  // Accepted delta at 2_500, before the window closes at 3_000.
  synth.apply(batch([2_500, delta("primary", 1, 1, 5_000, "svc-a", "i2", value("b"))]));

  assert.equal(synth.status("primary", 5_000).expiresAt, 7_500);
  // i1 survives too: the whole view shares one window.
  assert.equal(synth.resolve("svc-a", "i1", 7_499).state, "available");
  assert.equal(synth.resolve("svc-a", "i1", 7_500).state, "absent");
});

test("a replay never re-declares validity", () => {
  const synth = makeSynth();
  const first = snapshot("primary", 1, 0, 2_000, { "svc-a": { i1: value("a") } });
  synth.apply(batch([1_000, first]));
  // The same snapshot bytes arrive again just before expiry.
  synth.apply(batch([2_900, first]));
  assert.equal(synth.status("primary", 2_900).expiresAt, 3_000);
  assert.equal(synth.resolve("svc-a", "i1", 3_000).state, "absent");
});

test("an identical snapshot after lapse does not resurrect the view", () => {
  const synth = makeSynth();
  const first = snapshot("primary", 1, 0, 1_000, { "svc-a": { i1: value("a") } });
  synth.apply(batch([1_000, first]));
  // Same generation, same sequence, same content: a replay, even after lapse.
  synth.apply(batch([5_000, first]));
  assert.equal(synth.resolve("svc-a", "i1", 5_001).state, "absent");
  assert.equal(synth.issueOf("primary", 5_001)?.reason, "expired");

  // A genuinely new full snapshot (new sequence) revives it.
  synth.apply(batch([6_000, snapshot("primary", 1, 1, 10_000, { "svc-a": { i1: value("a2") } })]));
  const revived = synth.resolve("svc-a", "i1", 6_001);
  assert.equal(revived.state, "available");
  assert.equal(revived.state === "available" ? revived.value : null, "a2");
});

test("when a source lapses the answer falls back and names the lapsed source as shadowed evidence", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 1_000, { "svc-a": { i1: value("p") } })],
      [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value("f") } })],
    ),
  );

  const live = synth.resolve("svc-a", "i1", 1_500);
  assert.equal(live.source?.sourceId, "primary");
  assert.equal(live.shadowed[0]?.sourceId, "fallback");
  assert.equal(live.shadowed[0]?.reason, "lower-priority");

  const after = synth.resolve("svc-a", "i1", 2_000);
  assert.equal(after.state, "available");
  assert.equal(after.state === "available" ? after.value : null, "f");
  assert.equal(after.source?.sourceId, "fallback");
  const primaryEvidence = after.shadowed.find((entry) => entry.sourceId === "primary");
  assert.ok(primaryEvidence, "the lapsed primary is reported as evidence");
  assert.equal(primaryEvidence?.reason, "source-unusable");
});

test("values and tombstones lapse together at the same instant", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 2_000, { "svc-a": { i1: value("v"), i2: value("v2") } })],
      [1_000, delta("primary", 1, 1, 2_000, "svc-a", "i2", TOMBSTONE)],
    ),
  );
  assert.equal(synth.resolve("svc-a", "i1", 2_999).state, "available");
  assert.equal(synth.resolve("svc-a", "i2", 2_999).state, "deleted");

  // Both are gone at 3_000: neither the value nor the tombstone survives.
  assert.equal(synth.resolve("svc-a", "i1", 3_000).state, "absent");
  assert.equal(synth.resolve("svc-a", "i2", 3_000).state, "absent");
});

test("a zero-ttl update contributes nothing after its own receipt instant", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 0, { "svc-a": { i1: value("v") } })]));
  assert.equal(synth.status("primary", 1_000).usable, false);
  assert.equal(synth.resolve("svc-a", "i1", 1_000).state, "absent");
});
