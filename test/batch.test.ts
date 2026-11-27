import test from "node:test";
import assert from "node:assert/strict";

import { DiscoverySynthesizer } from "../src/index.ts";
import { at, batch, delta, snapshot, value } from "./helpers.ts";

function makeSynth(): DiscoverySynthesizer {
  return new DiscoverySynthesizer({
    sources: [
      { sourceId: "primary", priority: 0 },
      { sourceId: "fallback", priority: 10 },
    ],
  });
}

test("a batch is atomic: a query never sees a half-applied batch", () => {
  const synth = makeSynth();
  // Promote the primary in one batch that also carries a fallback change.
  synth.apply(
    batch(
      [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p") } })],
      [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value("f"), i2: value("f2") } })],
    ),
  );

  // Observe the view before the batch, then after. There is no intermediate
  // point at which only one of the two updates is visible, because both are
  // applied inside a single `apply` call.
  const before = synth.query(2_000);
  const batchResult = synth.apply(
    batch(
      [2_000, snapshot("primary", 1, 1, 60_000, { "svc-a": { i1: value("p2"), i3: value("p3") } })],
      [2_000, snapshot("fallback", 1, 1, 60_000, { "svc-a": { i2: value("f2b") } })],
    ),
  );
  const after = synth.query(2_000);

  assert.equal(batchResult.outcome, "applied");
  assert.notEqual(JSON.stringify(before.instances), JSON.stringify(after.instances));
  const byId = new Map(after.instances.map((entry) => [entry.instanceId, entry]));
  assert.equal(byId.get("i1")?.source?.sourceId, "primary");
  assert.equal(byId.get("i2")?.source?.sourceId, "fallback");
  assert.equal(byId.get("i3")?.source?.sourceId, "primary");
});

test("a rejected update in a batch does not prevent the rest of the batch applying", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p") } })]));

  const result = synth.apply(
    batch(
      // A gap on the primary...
      [2_000, delta("primary", 1, 5, 60_000, "svc-a", "i1", value("bad"))],
      // ...and a healthy fallback snapshot in the same batch.
      [2_000, snapshot("fallback", 3, 0, 60_000, { "svc-b": { i9: value("ok") } })],
    ),
  );

  assert.equal(result.outcome, "partially-applied");
  assert.equal(result.applied, 1);
  assert.equal(result.rejected, 1);

  const view = synth.query(3_000);
  const i9 = view.instances.find((entry) => entry.instanceId === "i9");
  assert.equal(i9?.state, "available");
  // The primary's gap dropped i1 everywhere.
  assert.equal(view.instances.find((entry) => entry.instanceId === "i1"), undefined);
});

test("a query result is a snapshot: later updates do not mutate it", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("first") } })]));
  const view = synth.query(2_000);
  const resolution = synth.resolve("svc-a", "i1", 2_000);

  synth.apply(batch([3_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", value("second"))]));

  const original = view.instances.find((entry) => entry.instanceId === "i1");
  assert.equal(original?.state === "available" ? original.value : null, "first");
  assert.equal(resolution.state === "available" ? resolution.value : null, "first");
  assert.equal(view.sources[0]?.sequence, 0);
});

test("malformed receipts throw and leave the previous state intact (crash safety)", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("v") } })]));
  const before = JSON.stringify(synth.query(2_000));

  assert.throws(() => synth.apply([{ receivedAt: Number.NaN, update: {} as never }] as never));
  assert.throws(() => synth.apply([{ receivedAt: 1, update: null } as never]));
  assert.throws(() => synth.apply("not-an-array" as never));

  assert.equal(JSON.stringify(synth.query(2_000)), before);
});

test("a malformed update is rejected in-band without corrupting the view", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("v") } })]));

  const result = synth.apply([
    {
      receivedAt: 2_000,
      update: {
        kind: "delta",
        sourceId: "primary",
        generation: 1,
        sequence: 1,
        ttlMs: -1, // invalid
        serviceId: "svc-a",
        instanceId: "i1",
        record: value("bad"),
      } as never,
    },
  ]);
  assert.equal(result.results[0]?.reason, "invalid");
  assert.equal(synth.issueOf("primary", 3_000)?.reason, "invalid");
  const result2 = synth.resolve("svc-a", "i1", 3_000);
  assert.equal(result2.state === "available" ? result2.value : null, "v");
});

test("configuration errors are explicit", () => {
  assert.throws(() => new DiscoverySynthesizer({ sources: [] }));
  assert.throws(
    () =>
      new DiscoverySynthesizer({
        sources: [
          { sourceId: "a", priority: 0 },
          { sourceId: "b", priority: 0 },
        ],
      }),
  );
  assert.throws(
    () =>
      new DiscoverySynthesizer({
        sources: [
          { sourceId: "a", priority: 0 },
          { sourceId: "a", priority: 1 },
        ],
      }),
  );
  const synth = makeSynth();
  assert.throws(() => synth.status("nope", 0));
  assert.throws(() => synth.issueOf("nope", 0));
});
