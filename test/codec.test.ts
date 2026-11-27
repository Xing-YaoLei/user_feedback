import test from "node:test";
import assert from "node:assert/strict";

import {
  MetadataDecoder,
  MetadataEncoder,
  encodeBlockAckFrame,
  encodeEntryAckFrame,
  parseFrame,
} from "../src/index.ts";
import { FrameBus, blockFields, referenceFields } from "./support/harness.ts";

const PAIR = [
  { key: "x-request-id", value: "9f1c2b7a-4d5e-4f60-8a11-000000000001" },
  { key: "x-user-agent", value: "Mozilla/5.0 (compatible; metadata-test/1.0)" },
];

test("codec round-trips metadata preserving order and duplicates", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = new FrameBus(encoder, decoder);

  const entries = [
    { key: "b", value: "2" },
    { key: "a", value: "1" },
    { key: "b", value: "2" },
    { key: "a", value: "1" },
    { key: "c", value: "3" },
    { key: "a", value: "1" },
  ];

  const encoded = encoder.encode(entries);
  bus.enqueue(encoded).settle();

  const decoded = decoder.getDecodedBlock(encoded.blockId);
  assert.ok(decoded, "block should decode");
  assert.deepEqual(decoded.entries, entries);
});

test("duplicate metadata is actually shorter once the dictionary is warm", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = new FrameBus(encoder, decoder);

  const sizes: { total: number; literal: number }[] = [];
  for (let index = 0; index < 6; index += 1) {
    const encoded = encoder.encode(PAIR);
    sizes.push({
      total: encoded.totalByteLength,
      literal: encoded.literalEquivalentBlockByteLength,
    });
    bus.enqueue(encoded).settle();
  }

  // The steady state must be strictly smaller than the literal encoding.
  const last = sizes[sizes.length - 1];
  assert.ok(
    last.total < last.literal,
    `expected ${last.total} < ${last.literal} for a repeated block`,
  );
  // And the total over the whole exchange must beat literal-only encoding.
  const totalBytes = sizes.reduce((sum, size) => sum + size.total, 0);
  const literalBytes = sizes.reduce((sum, size) => sum + size.literal, 0);
  assert.ok(totalBytes < literalBytes, `expected ${totalBytes} < ${literalBytes}`);
});

test("one-off metadata is not inflated by dictionary inserts", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  let literalOnly = 0;
  let actual = 0;
  for (let index = 0; index < 8; index += 1) {
    const encoded = encoder.encode([
      { key: "x-unique-id", value: `value-${index}` },
      { key: "x-seq", value: `${index}` },
    ]);
    literalOnly += encoded.literalEquivalentBlockByteLength;
    actual += encoded.totalByteLength;
  }
  assert.equal(encoder.getMetrics().insertedEntries, 0);
  assert.equal(actual, literalOnly);
});

test("encoder emits one dictionary insert per distinct pair when pairs first repeat", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = new FrameBus(encoder, decoder);

  const first = encoder.encode(PAIR);
  assert.equal(first.dictionaryFrames.length, 0);
  bus.enqueue(first).settle();

  const second = encoder.encode(PAIR);
  assert.equal(second.dictionaryFrames.length, 2);
  const inserts = second.dictionaryFrames.map((frame) => parseFrame(frame));
  for (const insert of inserts) {
    assert.equal(insert.type, "insert");
    assert.equal(insert.type === "insert" ? insert.generation : -1, 1);
  }
  const firstInsert = inserts[0];
  assert.equal(firstInsert.type === "insert" ? firstInsert.key : "", PAIR[0].key);
  assert.equal(firstInsert.type === "insert" ? firstInsert.value : "", PAIR[0].value);

  // The block references both fresh slots in field order.
  const refs = referenceFields(second.blockFrame);
  assert.deepEqual(refs, [
    { slot: 0, generation: 1 },
    { slot: 1, generation: 1 },
  ]);

  // And delivery in either order round-trips.
  bus.enqueue(second).settle();
  assert.deepEqual(decoder.getDecodedBlock(second.blockId)?.entries, PAIR);
});

test("more than one new pair in a block yields one insert per distinct pair", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = new FrameBus(encoder, decoder);

  // One sighting per pair: not yet worth an insert.
  const warmup = encoder.encode([
    { key: "a", value: "1234567890" },
    { key: "b", value: "0987654321" },
  ]);
  assert.equal(warmup.dictionaryFrames.length, 0);
  bus.enqueue(warmup).settle();

  const block = [
    { key: "a", value: "1234567890" },
    { key: "a", value: "1234567890" },
    { key: "b", value: "0987654321" },
    { key: "b", value: "0987654321" },
  ];
  const encoded = encoder.encode(block);
  const inserts = encoded.dictionaryFrames
    .map((frame) => parseFrame(frame))
    .filter((frame) => frame.type === "insert");
  assert.equal(inserts.length, 2);
  assert.notEqual(
    inserts[0].type === "insert" ? inserts[0].slot : -1,
    inserts[1].type === "insert" ? inserts[1].slot : -1,
    "distinct pairs use distinct slots",
  );

  // Order and duplicates survive even with mixed literals and references.
  bus.enqueue(encoded).settle();
  assert.deepEqual(decoder.getDecodedBlock(encoded.blockId)?.entries, block);
});

test("exposes blocked-block count, dictionary occupancy and protection basis", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = new FrameBus(encoder, decoder);

  const warm = encoder.encode(PAIR);
  bus.enqueue(warm).settle();
  const encoded = encoder.encode(PAIR);
  bus.enqueue(encoded);

  // Deliver request blocks ahead of every dictionary instruction: the block
  // must be withheld, and the pending count must be visible.
  bus.drainBlocks();
  assert.equal(decoder.blockedBlockCount, 1);
  assert.equal(encoder.blockedBlockCount, 1);

  const blocked = decoder.blockedBlocks();
  assert.deepEqual(blocked.map((report) => report.blockId), [encoded.blockId]);
  assert.equal(blocked[0].missing.length, 2);
  assert.equal(blocked[0].referenced.length, 2);

  // Protection basis on the encoder side: the blocked block is the sole
  // protector of both entries.
  assert.equal(encoder.dictionaryEntryCount, 2);
  assert.equal(encoder.dictionaryCapacity, 4096);
  assert.ok(encoder.dictionaryByteSize > 0);
  assert.ok(encoder.dictionaryByteSize <= 4096);
  const protection = encoder.referenceProtection();
  assert.equal(protection.length, 2);
  for (const entry of protection) {
    assert.deepEqual(entry.protectingBlockIds, [encoded.blockId]);
    assert.equal(entry.referenceCount, 1);
  }
  assert.ok(encoder.getMetrics().dictionaryBytes > 0);

  // Protection basis on the decoder side before dictionary delivery: the
  // entries are not yet present, so nothing is listed as protected.
  assert.deepEqual(decoder.protectedSlots(), []);

  // Once the dictionary instructions arrive the block resumes on its own.
  bus.drainDictionary();
  assert.equal(decoder.blockedBlockCount, 0);
  assert.deepEqual(decoder.getDecodedBlock(encoded.blockId)?.entries, PAIR);
});

test("a later block cannot reference entries while the quota is exhausted", () => {
  const encoder = new MetadataEncoder({
    maxDictionaryBytes: 4096,
    peerMaxBlockedBlocks: 1,
  });

  const first = encoder.encode(PAIR);
  assert.equal(first.dictionaryFrames.length, 0, "first block is literal");

  const second = encoder.encode(PAIR);
  assert.equal(second.dictionaryFrames.length, 2);
  assert.equal(encoder.blockedBlockCount, 1);

  // Quota used up by the second block: a third block must not add references
  // to the still-unacknowledged entries.
  const third = encoder.encode(PAIR);
  assert.equal(third.dictionaryFrames.length, 0);
  const fields = blockFields(third.blockFrame);
  assert.equal(fields.filter((field) => field.kind === "reference").length, 0);
  assert.equal(fields.filter((field) => field.kind === "literal").length, 2);
  assert.equal(encoder.blockedBlockCount, 1);

  // Acknowledge the second block and both of its entries: the quota frees up
  // and references resume.
  encoder.receiveAck(encodeEntryAckFrame({ slot: 0, generation: 1 }));
  encoder.receiveAck(encodeEntryAckFrame({ slot: 1, generation: 1 }));
  encoder.receiveAck(
    encodeBlockAckFrame({
      blockId: second.blockId,
      outcome: "decoded",
      refs: [
        { slot: 0, generation: 1 },
        { slot: 1, generation: 1 },
      ],
    }),
  );
  assert.equal(encoder.blockedBlockCount, 0);

  const fourth = encoder.encode(PAIR);
  assert.equal(fourth.dictionaryFrames.length, 0);
  assert.deepEqual(referenceFields(fourth.blockFrame), [
    { slot: 0, generation: 1 },
    { slot: 1, generation: 1 },
  ]);
});

test("a reference is never chosen when it would not be smaller than a literal", () => {
  // key="" value="" costs 3 literal bytes (tag + two zero lengths), exactly
  // the size of a reference with single-byte slot and generation.  Equal cost
  // is not a saving, so the encoder must stay literal.
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const equal = [
    { key: "", value: "" },
    { key: "", value: "" },
  ];
  encoder.encode(equal);
  const second = encoder.encode(equal);
  assert.equal(second.dictionaryFrames.length, 0);
  assert.equal(referenceFields(second.blockFrame).length, 0);
  assert.equal(
    second.blockByteLength,
    second.literalEquivalentBlockByteLength,
    "an equal-cost reference must not be used",
  );
});

test("encoder rejects malformed input instead of guessing", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 64 });
  assert.throws(() => encoder.encode(null as unknown as []), TypeError);
  assert.throws(() => encoder.encode([null] as unknown as []), TypeError);
  assert.throws(
    () => encoder.encode([{ key: "a", value: 1 }] as unknown as []),
    TypeError,
  );
  assert.throws(() => new MetadataEncoder({ maxDictionaryBytes: -1 }), RangeError);
  assert.throws(
    () => new MetadataEncoder({ maxDictionaryBytes: 8, maxSlots: -1 }),
    RangeError,
  );
});
