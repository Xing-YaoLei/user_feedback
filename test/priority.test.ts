import test from "node:test";
import assert from "node:assert/strict";

import { DiscoverySynthesizer } from "../src/index.ts";
import { TOMBSTONE, at, batch, delta, snapshot, value } from "./helpers.ts";

const PRIORITIES = [
  { sourceId: "primary", priority: 0 },
  { sourceId: "fallback", priority: 10 },
];

function makeSynth(): DiscoverySynthesizer {
  return new DiscoverySynthesizer({ sources: PRIORITIES });
}

test("primary value is served, with fallback recorded as shadowed", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 10_000, { "svc-a": { i1: value({ host: "10.0.0.1" }) } })],
      [1_000, snapshot("fallback", 1, 0, 10_000, { "svc-a": { i1: value({ host: "10.0.0.9" }) } })],
    ),
  );

  const result = synth.resolve("svc-a", "i1", 2_000);
  assert.equal(result.state, "available");
  assert.deepEqual(result.state === "available" ? result.value : null, { host: "10.0.0.1" });
  assert.equal(result.source?.sourceId, "primary");
  assert.equal(result.shadowed.length, 1);
  assert.equal(result.shadowed[0]?.sourceId, "fallback");
  assert.equal(result.shadowed[0]?.reason, "lower-priority");
});

test("primary tombstone hides a fallback value and does not resurrect from fallback", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value({ host: "10.0.0.9" }) } })],
      // Primary snapshot advertises the instance...
      [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value({ host: "10.0.0.1" }) } })],
      // ...then explicitly deletes it.
      [2_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", TOMBSTONE)],
    ),
  );

  const result = synth.resolve("svc-a", "i1", 3_000);
  assert.equal(result.state, "deleted");
  assert.equal(result.source?.sourceId, "primary");
  assert.equal(result.source?.sequence, 1);
  assert.equal(result.shadowed.length, 1);
  assert.equal(result.shadowed[0]?.sourceId, "fallback");
  assert.equal(result.shadowed[0]?.reason, "overridden-by-tombstone");

  // Still deleted later while the primary window is open.
  assert.equal(synth.resolve("svc-a", "i1", 50_000).state, "deleted");
});

test("a snapshot that omits an instance releases it to a lower-priority source", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value({ primary: true }) } })],
      [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value({ fallback: true }) } })],
    ),
  );
  assert.equal(synth.resolve("svc-a", "i1", 2_000).source?.sourceId, "primary");

  // New full snapshot from the primary no longer lists i1: the primary holds no
  // fact for it, so the fallback's value becomes visible.
  synth.apply(batch([2_000, snapshot("primary", 1, 5, 60_000, { "svc-a": {} })]));

  const result = synth.resolve("svc-a", "i1", 3_000);
  assert.equal(result.state, "available");
  assert.deepEqual(result.state === "available" ? result.value : null, { fallback: true });
  assert.equal(result.source?.sourceId, "fallback");
});

test("a primary delta dropping an instance also releases it (absence is not deletion)", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p") } })],
      [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value("f") } })],
      [2_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", undefined)],
    ),
  );
  const result = synth.resolve("svc-a", "i1", 3_000);
  assert.equal(result.state, "available");
  assert.equal(result.state === "available" ? result.value : null, "f");
  assert.equal(result.source?.sourceId, "fallback");
});

test("when every source is silent the instance is absent", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value(1) } })]));
  const result = synth.resolve("svc-a", "unknown", 2_000);
  assert.equal(result.state, "absent");
  assert.deepEqual(result.shadowed, []);
});
