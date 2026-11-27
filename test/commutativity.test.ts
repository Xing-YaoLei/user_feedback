import test from "node:test";
import assert from "node:assert/strict";

import { DiscoverySynthesizer } from "../src/index.ts";
import { TOMBSTONE, at, batch, delta, snapshot, value } from "./helpers.ts";
import type { Receipt } from "../src/types.ts";

function makeSynth(): DiscoverySynthesizer {
  return new DiscoverySynthesizer({
    sources: [
      { sourceId: "primary", priority: 0 },
      { sourceId: "middle", priority: 5 },
      { sourceId: "fallback", priority: 10 },
    ],
  });
}

/** Canonical, comparable form of a whole view (ignoring the query instant). */
function canonicalView(synth: DiscoverySynthesizer, now: number): string {
  const view = synth.query(now);
  return JSON.stringify({
    instances: view.instances,
    sources: view.sources.map((source) => ({
      sourceId: source.sourceId,
      generation: source.generation,
      sequence: source.sequence,
      usable: source.usable,
      issue: source.issue,
      receivedAt: source.receivedAt,
      expiresAt: source.expiresAt,
    })),
  });
}

const PRIMARY_A = snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p") } });
const MIDDLE_A = snapshot("middle", 1, 0, 60_000, { "svc-a": { i1: value("m"), i2: value("m2") } });
const FALLBACK_A = snapshot("fallback", 1, 0, 60_000, { "svc-a": { i2: value("f2") } });

test("interleaving the same source updates three ways yields one view", () => {
  const orders: Receipt[][] = [
    [at(1_000, PRIMARY_A), at(1_000, MIDDLE_A), at(1_000, FALLBACK_A)],
    [at(1_000, FALLBACK_A), at(1_000, MIDDLE_A), at(1_000, PRIMARY_A)],
    [at(1_000, MIDDLE_A), at(1_000, FALLBACK_A), at(1_000, PRIMARY_A)],
  ];

  const views = orders.map((receipts) => {
    const synth = makeSynth();
    synth.apply(receipts);
    return canonicalView(synth, 2_000);
  });

  assert.equal(views[0], views[1]);
  assert.equal(views[1], views[2]);
});

test("splitting a batch across calls commutes for independent sources", () => {
  const all = makeSynth();
  all.apply([at(1_000, PRIMARY_A), at(1_000, MIDDLE_A), at(1_000, FALLBACK_A)]);
  const expected = canonicalView(all, 2_000);

  const split = makeSynth();
  split.apply([at(1_000, MIDDLE_A)]);
  split.apply([at(1_000, FALLBACK_A)]);
  split.apply([at(1_000, PRIMARY_A)]);

  assert.equal(canonicalView(split, 2_000), expected);
});

test("tombstone plus reorderings of independent sources give the same answer", () => {
  const tombstoneDelta = delta("primary", 1, 1, 60_000, "svc-a", "i1", TOMBSTONE);
  const fallbackFlight = snapshot("fallback", 2, 0, 60_000, { "svc-a": { i1: value("f-new") } });

  const orders: Receipt[][] = [
    [at(1_000, PRIMARY_A), at(2_000, tombstoneDelta), at(1_500, fallbackFlight)],
    [at(1_500, fallbackFlight), at(1_000, PRIMARY_A), at(2_000, tombstoneDelta)],
    [at(1_000, PRIMARY_A), at(1_500, fallbackFlight), at(2_000, tombstoneDelta)],
  ];

  const results = orders.map((receipts) => {
    const synth = makeSynth();
    synth.apply(receipts);
    return canonicalView(synth, 3_000);
  });

  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);

  const synth = makeSynth();
  synth.apply(orders[0]!);
  const resolved = synth.resolve("svc-a", "i1", 3_000);
  assert.equal(resolved.state, "deleted");
  assert.equal(resolved.source?.sourceId, "primary");
});
