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

test("identical instance ids in different services are independent facts", () => {
  const synth = makeSynth();
  synth.apply(
    batch(
      [
        1_000,
        snapshot("primary", 1, 0, 60_000, {
          checkout: { "i-1": value({ host: "checkout-primary" }) },
          search: { "i-1": value({ host: "search-primary" }) },
        }),
      ],
      [
        1_000,
        snapshot("fallback", 1, 0, 60_000, {
          checkout: { "i-1": value({ host: "checkout-fallback" }) },
        }),
      ],
    ),
  );

  const checkout = synth.resolve("checkout", "i-1", 2_000);
  const search = synth.resolve("search", "i-1", 2_000);
  assert.deepEqual(checkout.state === "available" ? checkout.value : null, { host: "checkout-primary" });
  assert.deepEqual(search.state === "available" ? search.value : null, { host: "search-primary" });

  // Deleting the checkout instance in the primary must not touch search.
  synth.apply(batch([3_000, delta("primary", 1, 1, 60_000, "checkout", "i-1", TOMBSTONE)]));
  assert.equal(synth.resolve("checkout", "i-1", 4_000).state, "deleted");
  assert.equal(synth.resolve("search", "i-1", 4_000).state, "available");
});

test("the view can be filtered by service and instance", () => {
  const synth = makeSynth();
  synth.apply(
    batch([
      1_000,
      snapshot("primary", 1, 0, 60_000, {
        checkout: { "i-1": value(1), "i-2": value(2) },
        search: { "i-1": value(3) },
      }),
    ]),
  );

  const reloadView = synth.query(2_000);
  assert.deepEqual(
    reloadView.instances.map((entry) => `${entry.serviceId}/${entry.instanceId}`),
    ["checkout/i-1", "checkout/i-2", "search/i-1"],
  );

  const checkoutOnly = synth.query(2_000, { serviceId: "checkout" });
  assert.deepEqual(
    checkoutOnly.instances.map((entry) => entry.instanceId),
    ["i-1", "i-2"],
  );

  const oneInstance = synth.query(2_000, { serviceId: "search", instanceId: "i-1" });
  assert.equal(oneInstance.instances.length, 1);
  assert.equal(oneInstance.instances[0]?.serviceId, "search");
});

test("an explicitly requested missing instance yields an absent resolution", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { checkout: { "i-1": value(1) } })]));
  const view = synth.query(2_000, { serviceId: "checkout", instanceId: "missing" });
  assert.equal(view.instances.length, 1);
  assert.equal(view.instances[0]?.state, "absent");
  assert.equal(view.instances[0]?.instanceId, "missing");
});

test("sources are reported highest priority first", () => {
  const synth = new DiscoverySynthesizer({
    sources: [
      { sourceId: "fallback", priority: 99 },
      { sourceId: "primary", priority: 0 },
      { sourceId: "mirror", priority: 50 },
    ],
  });
  assert.deepEqual(synth.sourceIds(), ["primary", "mirror", "fallback"]);
  const statuses = synth.query(0).sources.map((source) => source.sourceId);
  assert.deepEqual(statuses, ["primary", "mirror", "fallback"]);
});
