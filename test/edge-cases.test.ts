import test from "node:test";
import assert from "node:assert/strict";

import { DiscoverySynthesizer } from "../src/index.ts";
import { TOMBSTONE, batch, delta, snapshot, value } from "./helpers.ts";

function makeSynth(): DiscoverySynthesizer {
  return new DiscoverySynthesizer({
    sources: [
      { sourceId: "primary", priority: 0 },
      { sourceId: "mirror", priority: 5 },
      { sourceId: "fallback", priority: 10 },
    ],
  });
}

test("shadowed evidence is listed in priority order for both values and tombstones", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p") } })],
      [1_000, snapshot("mirror", 1, 0, 60_000, { "svc-a": { i1: value("m") } })],
      [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value("f") } })],
    ),
  );

  const live = synth.resolve("svc-a", "i1", 2_000);
  assert.deepEqual(
    live.shadowed.map((entry) => entry.sourceId),
    ["mirror", "fallback"],
  );

  synth.apply(batch([2_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", TOMBSTONE)]));
  const deleted = synth.resolve("svc-a", "i1", 3_000);
  assert.equal(deleted.state, "deleted");
  assert.deepEqual(
    deleted.shadowed.map((entry) => [entry.sourceId, entry.reason]),
    [
      ["mirror", "overridden-by-tombstone"],
      ["fallback", "overridden-by-tombstone"],
    ],
  );
});

test("an update from an unconfigured source is rejected without throwing", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p") } })]));
  const before = JSON.stringify(synth.query(2_000));

  const result = synth.apply(
    batch([2_000, snapshot("intruder", 1, 0, 60_000, { "svc-a": { i1: value("evil") } })]),
  );
  assert.equal(result.results[0]?.reason, "unknown-source");
  assert.equal(JSON.stringify(synth.query(2_000)), before);
  assert.equal(synth.resolve("svc-a", "i1", 2_000).source?.sourceId, "primary");
});

test("a single source configuration is valid and answers on its own", () => {
  const synth = new DiscoverySynthesizer({ sources: [{ sourceId: "only", priority: 3 }] });
  synth.apply(batch([1_000, snapshot("only", 1, 0, 60_000, { "svc-a": { i1: value("solo") } })]));
  const result = synth.resolve("svc-a", "i1", 2_000);
  assert.equal(result.state === "available" ? result.value : null, "solo");
  assert.deepEqual(result.shadowed, []);
});

test("negative priorities are allowed and ordered correctly", () => {
  const synth = new DiscoverySynthesizer({
    sources: [
      { sourceId: "low", priority: 0 },
      { sourceId: "high", priority: -5 },
    ],
  });
  synth.apply(
    batch(
      [1_000, snapshot("high", 1, 0, 60_000, { "svc-a": { i1: value("H") } })],
      [1_000, snapshot("low", 1, 0, 60_000, { "svc-a": { i1: value("L") } })],
    ),
  );
  assert.equal(synth.sourceIds()[0], "high");
  const result = synth.resolve("svc-a", "i1", 2_000);
  assert.equal(result.state === "available" ? result.value : null, "H");
});

test("a source that never published contributes nothing and reports no issue", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p") } })]));
  const status = synth.status("fallback", 2_000);
  assert.equal(status.usable, false);
  assert.equal(status.generation, null);
  assert.equal(status.issue, null);
  assert.equal(synth.issueOf("fallback", 2_000), null);
});

test("byte-identical payloads under different key insertion orders are the same content", () => {
  const synth = makeSynth();
  synth.apply(
    batch([
      1_000,
      snapshot("primary", 1, 0, 60_000, {
        "svc-a": { i1: value({ host: "h", port: 1 }) },
      }),
    ]),
  );
  // Same content, keys listed in the opposite order: a replay, not a conflict.
  const outcome = synth.apply(
    batch([
      2_000,
      snapshot("primary", 1, 0, 60_000, {
        "svc-a": { i1: value({ port: 1, host: "h" }) },
      }),
    ]),
  );
  assert.equal(outcome.results[0]?.status, "ignored");
  assert.equal(outcome.results[0]?.reason, "duplicate");
  assert.equal(synth.issueOf("primary", 2_500), null);
});
