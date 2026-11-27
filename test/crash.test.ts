import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscoverySynthesizer } from "../src/index.ts";
import type { Receipt } from "../src/types.ts";
import { batch, delta, snapshot, value } from "./helpers.ts";

function makeSynth(): DiscoverySynthesizer {
  return new DiscoverySynthesizer({
    sources: [
      { sourceId: "primary", priority: 0 },
      { sourceId: "fallback", priority: 10 },
    ],
  });
}

/**
 * Replays a fixed, ordered stream of receipts, stopping right before index
 * `crashAt`, then builds a fresh instance and replays the rest. Because the
 * synthesizer is a pure function of its received updates, resuming from a
 * crash must yield exactly the view that an uninterrupted run would.
 */
function canonical(synth: DiscoverySynthesizer, now: number): string {
  return JSON.stringify(synth.query(now));
}

const STREAM: Receipt[] = [
  ...batch(
    [1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("p1"), i2: value("p2") } })],
    [1_000, snapshot("fallback", 1, 0, 60_000, { "svc-a": { i1: value("f1") } })],
    [2_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", value("p1b"))],
    [2_000, delta("primary", 1, 2, 60_000, "svc-a", "i2", undefined)],
    [3_000, delta("fallback", 1, 1, 60_000, "svc-a", "i2", value("f2"))],
    [4_000, delta("primary", 1, 3, 60_000, "svc-a", "i3", value("p3"))],
  ),
];

test("resuming after a crash at every possible point yields the uninterrupted view", () => {
  const reference = makeSynth();
  reference.apply(STREAM);
  const expected = canonical(reference, 5_000);

  for (let crashAt = 0; crashAt <= STREAM.length; crashAt += 1) {
    const first = makeSynth();
    first.apply(STREAM.slice(0, crashAt));

    // A crash between batches loses in-flight work but not applied state.
    const resumed = makeSynth();
    // Simulate durable handoff: replay everything committed before the crash,
    // then continue with the remainder.
    resumed.apply(STREAM.slice(0, crashAt));
    resumed.apply(STREAM.slice(crashAt));

    assert.equal(canonical(resumed, 5_000), expected, `crash at ${crashAt}`);
  }
});

test("state survives a JSON round-trip of the committed receipt log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-view-"));
  try {
    const logPath = join(dir, "receipts.json");
    const serialisable = STREAM.map((receipt) => ({
      receivedAt: receipt.receivedAt,
      update:
        receipt.update.kind === "snapshot"
          ? {
              kind: "snapshot",
              sourceId: receipt.update.sourceId,
              generation: receipt.update.generation,
              sequence: receipt.update.sequence,
              ttlMs: receipt.update.ttlMs,
              records: Object.fromEntries(
                [...receipt.update.records].map(([service, byInstance]) => [
                  service,
                  Object.fromEntries(byInstance),
                ]),
              ),
            }
          : receipt.update,
    }));
    await writeFile(logPath, JSON.stringify(serialisable), "utf8");

    const raw = JSON.parse(await readFile(logPath, "utf8")) as Array<{
      receivedAt: number;
      update: {
        kind: "snapshot" | "delta";
        sourceId: string;
        generation: number;
        sequence: number;
        ttlMs: number;
        records?: Record<string, Record<string, unknown>>;
      } & Record<string, unknown>;
    }>;

    const restored = makeSynth();
    const receipts: Receipt[] = raw.map(({ receivedAt, update }) => {
      if (update.kind === "snapshot" && update.records) {
        const records = new Map(
          Object.entries(update.records).map(([service, byInstance]) => [
            service,
            new Map(Object.entries(byInstance)),
          ]),
        ) as never;
        return {
          receivedAt,
          update: { ...update, records } as never,
        };
      }
      return { receivedAt, update: update as never };
    });
    restored.apply(receipts);

    const reference = makeSynth();
    reference.apply(STREAM);
    assert.equal(canonical(restored, 5_000), canonical(reference, 5_000));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an interrupted batch does not partially apply (all-or-nothing publish)", () => {
  const synth = makeSynth();
  synth.apply(batch([1_000, snapshot("primary", 1, 0, 60_000, { "svc-a": { i1: value("a") } })]));
  const before = canonical(synth, 2_000);

  // The batch's second receipt is structurally malformed; the call throws.
  assert.throws(() =>
    synth.apply([
      { receivedAt: 2_000, update: delta("primary", 1, 1, 60_000, "svc-a", "i1", value("b")) },
      { receivedAt: 2_000, update: null as never },
    ]),
  );

  // Nothing from that batch is visible.
  assert.equal(canonical(synth, 2_000), before);
  // Retrying the valid receipt afterwards works normally.
  synth.apply(batch([2_000, delta("primary", 1, 1, 60_000, "svc-a", "i1", value("b"))]));
  const retried = synth.resolve("svc-a", "i1", 3_000);
  assert.equal(retried.state === "available" ? retried.value : null, "b");
});
