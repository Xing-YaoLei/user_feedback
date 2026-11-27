import test from "node:test";
import assert from "node:assert/strict";

import { DiscoverySynthesizer } from "../src/index.ts";
import { batch, delta, snapshot, value } from "./helpers.ts";

function makeSynth(): DiscoverySynthesizer {
  return new DiscoverySynthesizer({
    sources: [
      { sourceId: "primary", priority: 0 },
      { sourceId: "fallback", priority: 10 },
    ],
  });
}

test("outdated generation never changes the current state", () => {
  const synth = makeSynth();
  synth.apply(batch([5_000, snapshot("primary", 3, 0, 60_000, { "svc-a": { i1: value("gen3") } })]));
  const outcome = synth.apply(
    batch([6_000, snapshot("primary", 2, 99, 60_000, { "svc-a": { i1: value("gen2") } })]),
  );

  assert.equal(outcome.results[0]?.status, "ignored");
  assert.equal(outcome.results[0]?.reason, "outdated-generation");
  const result = synth.resolve("svc-a", "i1", 7_000);
  assert.equal(result.state === "available" ? result.value : null, "gen3");
  assert.equal(result.source?.generation, 3);
});

test("outdated sequence within the active generation never changes state", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("zero") } })],
      [2_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", value("one"))],
    ),
  );
  const outcome = synth.apply(
    batch([3_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", value("one"))]),
  );
  assert.equal(outcome.results[0]?.status, "ignored");

  // A strictly older delta is inert even if its payload differs.
  const older = synth.apply(
    batch([4_000, delta("primary", 1, 0, 60_000, "svc-a", "i1", value("zero-again"))]),
  );
  assert.equal(older.results[0]?.reason, "outdated-sequence");

  const result = synth.resolve("svc-a", "i1", 5_000);
  assert.equal(result.state === "available" ? result.value : null, "one");
  assert.equal(result.source?.sequence, 1);
});

test("same generation and same sequence with different content reports a conflict and keeps the view", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("a") } })]));
  const before = JSON.stringify(synth.query(2_000).instances);

  const outcome = synth.apply(
    batch([3_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("b") } })]),
  );
  assert.equal(outcome.outcome, "rejected");
  assert.equal(outcome.results[0]?.reason, "conflict");
  assert.equal(synth.issueOf("primary", 3_000)?.reason, "source-conflict");

  const after = synth.resolve("svc-a", "i1", 4_000);
  assert.equal(after.state === "available" ? after.value : null, "a");
  // The instance view is unchanged; only the reported diagnostic differs.
  assert.equal(JSON.stringify(synth.query(2_000).instances), before);
});

test("a delta conflict against the last accepted delta is detected too", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 60_000, {})],
      [2_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", value("a"))],
    ),
  );
  const outcome = synth.apply(
    batch([3_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", value("b"))]),
  );
  assert.equal(outcome.results[0]?.reason, "conflict");
  assert.equal(synth.issueOf("primary", 3_000)?.reason, "source-conflict");
  const result = synth.resolve("svc-a", "i1", 4_000);
  assert.equal(result.state === "available" ? result.value : null, "a");
});

test("replaying the exact last update is inert and does not extend validity", () => {
  const synth = makeSynth();
  const snap = snapshot("primary", 1, 0, 5_000, { "svc-a": { i1: value("v") } });
  synth.apply(batch([1_000, snap]));

  // Replay much later, still before expiry. Must be a no-op.
  const replay = synth.apply(batch([5_500, snap]));
  assert.equal(replay.results[0]?.status, "ignored");
  assert.equal(replay.results[0]?.reason, "duplicate");

  // Window still closes at 1_000 + 5_000 = 6_000, not at 5_500 + 5_000.
  assert.equal(synth.status("primary", 5_999).usable, true);
  assert.equal(synth.status("primary", 6_000).usable, false);
  assert.equal(synth.resolve("svc-a", "i1", 6_000).state, "absent");
});

test("expiry and gap are reported as different reasons", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 2_000, { "svc-a": { i1: value("v") } })]));
  synth.apply(batch([1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value("f") } })]));

  // Before expiry: healthy.
  assert.equal(synth.issueOf("primary", 2_999), null);

  // After the declared window: normal expiry.
  assert.equal(synth.issueOf("primary", 3_000)?.reason, "expired");
  assert.equal(synth.status("primary", 3_000).usable, false);
  assert.equal(synth.status("primary", 3_000).expired, true);

  // A fresh snapshot that then skips a sequence reports a gap, not expiry.
  // (Recovery uses a strictly newer sequence: a byte-identical replay never
  // re-opens a lapsed window, by design.)
  synth.apply(batch([4_000, snapshot("primary", 1, 1, 60_000, { "svc-a": { i1: value("v2") } })]));
  assert.equal(synth.issueOf("primary", 4_500), null);
  synth.apply(batch([5_000, delta("primary", 1, 3, 60_000, "svc-a", "i1", value("v3"))]));
  assert.equal(synth.issueOf("primary", 5_500)?.reason, "gap");
});

test("a delta cannot revive a lapsed view", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 1_000, { "svc-a": { i1: value("v") } })]));
  const outcome = synth.apply(
    batch([2_500, delta("primary", 1, 1, 60_000, "svc-a", "i1", value("late"))]),
  );
  assert.equal(outcome.results[0]?.status, "rejected");
  assert.equal(outcome.results[0]?.reason, "expired");
  // Still no view; the late delta did not create one.
  assert.equal(synth.resolve("svc-a", "i1", 2_600).state, "absent");
  assert.equal(synth.issueOf("primary", 2_600)?.reason, "expired");
});

test("a stale update arriving after expiry is inert, not a revival", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 1_000, { "svc-a": { i1: value("v") } })]));
  // An old generation update after expiry: ignored, nothing rebuilt.
  const outcome = synth.apply(
    batch([5_000, snapshot("primary", 0, 0, 60_000, { "svc-a": { i1: value("ancient") } })]),
  );
  assert.equal(outcome.results[0]?.reason, "outdated-generation");
  assert.equal(synth.resolve("svc-a", "i1", 6_000).state, "absent");
});
