import test from "node:test";
import assert from "node:assert/strict";

import {
  MetadataDecoder,
  MetadataEncoder,
  encodeEvictFrame,
  encodeInsertFrame,
  encodeRequestBlockFrame,
  parseFrame,
  type EncodableBlockField,
} from "../src/index.ts";
import {
  FrameBus,
  blockFields,
  referenceFields,
  seededRandom,
  shuffle,
} from "./support/harness.ts";

const PAIRS = [
  { key: "x-request-id", value: "9f1c2b7a-4d5e-4f60-8a11-000000000001" },
  { key: "x-user-agent", value: "Mozilla/5.0 (compatible; metadata-test/1.0)" },
  { key: "x-b3-traceid", value: "80f198ee56343ba864fe8b2a57d3eff7" },
];

/** Warms the dictionary so later blocks use references. */
function warm(encoder: MetadataEncoder, decoder: MetadataDecoder): FrameBus {
  const bus = new FrameBus(encoder, decoder);
  bus.enqueue(encoder.encode(PAIRS)).settle();
  bus.enqueue(encoder.encode(PAIRS)).settle();
  return bus;
}

test("a block that overtakes its dictionary instruction waits, then resumes", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = warm(encoder, decoder);

  const encoded = encoder.encode([...PAIRS, ...PAIRS]);
  assert.ok(encoded.dictionaryFrames.length === 0, "dictionary is already warm");
  bus.enqueue(encoded);
  const second = encoder.encode([{ key: "x-new-header", value: "brand-new-value" }, ...PAIRS]);
  // Force a fresh entry by making the new pair repeat.
  const third = encoder.encode([
    { key: "x-new-header", value: "brand-new-value" },
    { key: "x-new-header", value: "brand-new-value" },
  ]);
  assert.equal(third.dictionaryFrames.length, 1);

  bus.enqueue(third);
  const decodedBefore = decoder.blockedBlockCount;
  bus.drainBlocks();
  assert.equal(decoder.blockedBlockCount, decodedBefore + 1);

  const report = decoder.blockedBlocks().find((entry) => entry.blockId === third.blockId);
  assert.ok(report, "third block must be reported as blocked");
  assert.equal(report.missing.length, 1);
  assert.equal(decoder.hasDecodedBlock(third.blockId), false);

  // Necessary dictionary instructions still flow while a block is blocked.
  bus.drainDictionary();
  assert.equal(decoder.blockedBlockCount, decodedBefore);
  assert.deepEqual(decoder.getDecodedBlock(third.blockId)?.entries, [
    { key: "x-new-header", value: "brand-new-value" },
    { key: "x-new-header", value: "brand-new-value" },
  ]);

  // Everything else still arrives intact afterwards.
  bus.drain();
  assert.deepEqual(decoder.getDecodedBlock(encoded.blockId)?.entries, [...PAIRS, ...PAIRS]);
});

test("blocks submitted before any dictionary instruction all recover in order", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = warm(encoder, decoder);

  const payloads = [
    [{ key: "fresh-a", value: "aaaaaaaaaaaa" }, { key: "fresh-a", value: "aaaaaaaaaaaa" }],
    [{ key: "fresh-b", value: "bbbbbbbbbbbb" }, { key: "fresh-b", value: "bbbbbbbbbbbb" }],
    [...PAIRS, { key: "fresh-c", value: "cccccccccccc" }, { key: "fresh-c", value: "cccccccccccc" }],
  ];
  const blocks = payloads.map((payload) => encoder.encode(payload));
  for (const block of blocks) bus.enqueue(block);

  // Deliver every request block first: the block channel is fully ahead of the
  // dictionary channel.  Nothing decodes yet.
  bus.drainBlocks();
  assert.equal(decoder.blockedBlockCount, 3);
  assert.equal(decoder.decodedBlocks().length, 2, "only the pre-warm blocks decoded");

  // Now the dictionary channel catches up; everything resumes.
  bus.drainDictionary();
  assert.equal(decoder.blockedBlockCount, 0);
  for (let index = 0; index < blocks.length; index += 1) {
    assert.deepEqual(decoder.getDecodedBlock(blocks[index].blockId)?.entries, payloads[index]);
  }
});

test("randomized interleavings decode identically", () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = seededRandom(seed);
    const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
    const decoder = new MetadataDecoder();
    const bus = new FrameBus(encoder, decoder);

    const expected = new Map<number, { key: string; value: string }[]>();
    const frames: { channel: "dictionary" | "block"; frame: Uint8Array }[] = [];

    for (let round = 0; round < 12; round += 1) {
      const payload: { key: string; value: string }[] = [];
      const count = 1 + Math.floor(random() * 5);
      for (let index = 0; index < count; index += 1) {
        const pair = PAIRS[Math.floor(random() * PAIRS.length)];
        payload.push({ ...pair });
      }
      // Occasionally add a brand-new pair so the dictionary keeps changing.
      if (random() < 0.35) {
        const fresh = { key: "x-fresh", value: `fresh-${seed}-${round}` };
        payload.push(fresh, { ...fresh });
      }
      const encoded = encoder.encode(payload);
      expected.set(encoded.blockId, payload);
      for (const frame of encoded.dictionaryFrames) {
        frames.push({ channel: "dictionary", frame });
      }
      frames.push({ channel: "block", frame: encoded.blockFrame });
    }

    // Shuffle across channels; per-channel order is preserved by construction
    // because we stable-partition the shuffled order.
    const shuffled = shuffle(frames, random);
    const dictionaryOrder = shuffled.filter((item) => item.channel === "dictionary");
    const blockOrder = shuffled.filter((item) => item.channel === "block");
    const interleaved: typeof frames = [];
    let d = 0;
    let b = 0;
    while (d < dictionaryOrder.length || b < blockOrder.length) {
      const takeDictionary =
        b >= blockOrder.length ||
        (d < dictionaryOrder.length && random() < 0.5);
      if (takeDictionary) interleaved.push(dictionaryOrder[d++]);
      else interleaved.push(blockOrder[b++]);
    }

    for (const item of interleaved) {
      if (item.channel === "dictionary") decoder.receiveDictionaryFrame(item.frame);
      else decoder.receiveBlockFrame(item.frame);
    }

    bus.pumpAcks();
    assert.equal(
      decoder.blockedBlockCount,
      0,
      `seed ${seed}: every block should have decoded`,
    );
    for (const [blockId, payload] of expected) {
      assert.deepEqual(
        decoder.getDecodedBlock(blockId)?.entries,
        payload,
        `seed ${seed}: block ${blockId} mismatch`,
      );
    }
  }
});

test("dictionary instructions keep flowing while a block is stuck", () => {
  const decoder = new MetadataDecoder();
  const stuck = encodeRequestBlockFrameFor([
    { kind: "reference", slot: 5, generation: 3 },
  ]);

  // A block referencing a slot that will never exist.
  decoder.receiveBlockFrame(stuck);
  assert.equal(decoder.blockedBlockCount, 1);

  // Unrelated inserts and evicts are still processed and observable.
  decoder.receiveDictionaryFrame(
    encodeInsertFrame({ slot: 0, generation: 1, key: "k0", value: "v0" }),
  );
  decoder.receiveDictionaryFrame(
    encodeInsertFrame({ slot: 1, generation: 1, key: "k1", value: "v1" }),
  );
  assert.equal(decoder.dictionaryEntryCount, 2);
  assert.ok(decoder.dictionaryBytes > 0);

  decoder.receiveDictionaryFrame(encodeEvictFrame({ slot: 0, generation: 1 }));
  assert.equal(decoder.dictionaryEntryCount, 1);

  // A worse generation for a live slot never replaces the entry.
  decoder.receiveDictionaryFrame(
    encodeInsertFrame({ slot: 1, generation: 0, key: "stale", value: "stale" }),
  );
  assert.equal(decoder.dictionaryEntryCount, 1);

  // The stuck block is still stuck and still reported.
  assert.equal(decoder.blockedBlockCount, 1);
  assert.deepEqual(decoder.blockedBlocks()[0].missing, [{ slot: 5, generation: 3 }]);

  // Creating the missing slot generation releases it.
  decoder.receiveDictionaryFrame(
    encodeInsertFrame({ slot: 5, generation: 3, key: "late", value: "arrival" }),
  );
  assert.equal(decoder.blockedBlockCount, 0);
});

test("a stale generation never satisfies a reference", () => {
  const decoder = new MetadataDecoder();
  const block = encodeRequestBlockFrameFor([{ kind: "reference", slot: 0, generation: 2 }]);
  decoder.receiveDictionaryFrame(
    encodeInsertFrame({ slot: 0, generation: 1, key: "old", value: "value" }),
  );
  decoder.receiveBlockFrame(block);
  assert.equal(decoder.blockedBlockCount, 1, "generation 1 must not satisfy generation 2");

  decoder.receiveDictionaryFrame(
    encodeInsertFrame({ slot: 0, generation: 2, key: "new", value: "value" }),
  );
  assert.equal(decoder.blockedBlockCount, 0);
  const decoded = decoder.getDecodedBlock(1);
  assert.deepEqual(decoded?.entries, [{ key: "new", value: "value" }]);
});

test("blocks with no references are never blocked", () => {
  const decoder = new MetadataDecoder();
  const frame = encodeRequestBlockFrameFor([
    { kind: "literal", key: "a", value: "b" },
  ]);
  const decoded = decoder.receiveBlockFrame(frame);
  assert.ok(decoded);
  assert.deepEqual(decoded.entries, [{ key: "a", value: "b" }]);
  assert.equal(decoder.blockedBlockCount, 0);
});

test("duplicate delivery of the same block id is ignored", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = warm(encoder, decoder);
  const encoded = encoder.encode(PAIRS);
  for (const frame of encoded.dictionaryFrames) decoder.receiveDictionaryFrame(frame);
  decoder.receiveBlockFrame(encoded.blockFrame);
  const acksBefore = decoder.getMetrics().blockAcksEmitted;
  decoder.receiveBlockFrame(encoded.blockFrame);
  assert.equal(decoder.getMetrics().blockAcksEmitted, acksBefore);
  assert.equal(decoder.getMetrics().duplicateBlocksIgnored, 1);
  assert.ok(bus);
});

test("dictionary channel rejects request blocks and vice versa", () => {
  const decoder = new MetadataDecoder();
  const block = encodeRequestBlockFrameFor([{ kind: "literal", key: "a", value: "b" }]);
  assert.throws(() => decoder.receiveDictionaryFrame(block), TypeError);
  const insert = encodeInsertFrame({ slot: 0, generation: 1, key: "a", value: "b" });
  assert.throws(() => decoder.receiveBlockFrame(insert), TypeError);
});

// Local helper: encode a block with explicit fields through the public API.
function encodeRequestBlockFrameFor(fields: EncodableBlockField[]): Uint8Array {
  return encodeRequestBlockFrame({ blockId: 1, fields });
}

test("parseFrame sees the same frames the harness logged", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = warm(encoder, decoder);
  const encoded = encoder.encode(PAIRS);
  bus.enqueue(encoded);
  for (const frame of bus.wireLog) {
    const parsed = parseFrame(frame.frame);
    assert.ok(frame.channel === "dictionary" ? parsed.type !== "block" : parsed.type === "block");
  }
  assert.ok(blockFields(encoded.blockFrame).length > 0);
  assert.ok(referenceFields(encoded.blockFrame).length > 0);
});
