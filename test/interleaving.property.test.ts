import test from "node:test";
import assert from "node:assert/strict";

import { DiscoverySynthesizer } from "../src/index.ts";
import type { Receipt } from "../src/types.ts";
import { TOMBSTONE, at, batch, delta, snapshot, value } from "./helpers.ts";

/** Deterministic PRNG so a failure is always reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSynth(): DiscoverySynthesizer {
  return new DiscoverySynthesizer({
    sources: [
      { sourceId: "primary", priority: 0 },
      { sourceId: "mirror", priority: 5 },
      { sourceId: "fallback", priority: 10 },
    ],
  });
}

/**
 * A fixed per-source stream. Reordering may only shuffle *across* sources; a
 * source's own updates must stay in order (they are sequence-numbered).
 */
const STREAMS: Record<string, Receipt[]> = {
  primary: batch(
    [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p1"), i2: value("p2") } })],
    [2_000, delta("primary", 1, 1, 60_000, "svc-a", "i2", TOMBSTONE)],
    [3_000, delta("primary", 1, 2, 60_000, "svc-a", "i3", value("p3"))],
    [4_000, delta("primary", 1, 3, 60_000, "svc-a", "i1", undefined)],
  ),
  mirror: batch(
    [1_000, snapshot("mirror", 1, 0, 60_000, { "svc-a": { i1: value("m1"), i2: value("m2") } })],
    [2_500, delta("mirror", 1, 1, 60_000, "svc-a", "i4", value("m4"))],
    [4_500, delta("mirror", 1, 2, 60_000, "svc-a", "i2", value("m2b"))],
  ),
  fallback: batch(
    [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value("f1"), i2: value("f2"), i3: value("f3") } })],
    [3_500, delta("fallback", 1, 1, 60_000, "svc-a", "i2", value("f2b"))],
  ),
};

/** Merge streams while keeping each source's internal order intact. */
function interleave(order: string[], rand: () => number): Receipt[] {
  const cursors = new Map(order.map((source) => [source, 0]));
  const out: Receipt[] = [];
  const remaining = () => order.reduce((sum, source) => sum + STREAMS[source]!.length - cursors.get(source)!, 0);
  while (remaining() > 0) {
    const available = order.filter((source) => cursors.get(source)! < STREAMS[source]!.length);
    const pick = available[Math.floor(rand() * available.length)]!;
    const index = cursors.get(pick)!;
    out.push(STREAMS[pick]![index]!);
    cursors.set(pick, index + 1);
  }
  return out;
}

function canonical(synth: DiscoverySynthesizer, now: number): string {
  const view = synth.query(now);
  return JSON.stringify({
    instances: view.instances,
    sources: view.sources.map((source) => ({
      sourceId: source.sourceId,
      generation: source.generation,
      sequence: source.sequence,
      usable: source.usable,
      blocked: source.blocked,
      expired: source.expired,
      receivedAt: source.receivedAt,
      expiresAt: source.expiresAt,
    })),
  });
}

test("randomised cross-source interleavings always yield the same view", () => {
  const reference = makeSynth();
  for (const source of Object.keys(STREAMS)) reference.apply(STREAMS[source]!);
  const expected = canonical(reference, 5_000);

  const rand = mulberry32(0xc0ffee);
  for (let trial = 0; trial < 200; trial += 1) {
    const order = ["primary", "mirror", "fallback"].sort(() => rand() - 0.5);
    const synth = makeSynth();
    synth.apply(interleave(order, rand));
    assert.equal(canonical(synth, 5_000), expected, `trial ${trial} order ${order.join(",")}`);
  }
});

test("applying the same interleaving twice in two calls matches one call", () => {
  const rand = mulberry32(7);
  const stream = interleave(["primary", "mirror", "fallback"], rand);

  const oneCall = makeSynth();
  oneCall.apply(stream);

  const split = makeSynth();
  const cut = Math.floor(stream.length / 2);
  split.apply(stream.slice(0, cut));
  split.apply(stream.slice(cut));

  assert.equal(canonical(split, 5_000), canonical(oneCall, 5_000));
});

test("queries are pure: repeating them changes nothing and never renews expiry", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 5_000, { "svc-a": { i1: value("v") } })]));

  const first = canonical(synth, 2_000);
  for (let i = 0; i < 5; i += 1) {
    synth.query(2_000);
    synth.resolve("svc-a", "i1", 2_000);
    synth.status("primary", 2_000);
    synth.issueOf("primary", 2_000);
  }
  assert.equal(canonical(synth, 2_000), first);

  // Querying close to the boundary must not have moved it.
  synth.query(5_999);
  assert.equal(synth.status("primary", 6_000).expiresAt, 6_000);
  assert.equal(synth.resolve("svc-a", "i1", 6_000).state, "absent");
});
