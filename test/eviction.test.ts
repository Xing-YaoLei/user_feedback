import test from "node:test";
import assert from "node:assert/strict";

import {
  MetadataDecoder,
  MetadataEncoder,
  ProtocolError,
  encodeBlockAckFrame,
  encodeEntryAckFrame,
  encodeEvictFrame,
  encodeInsertFrame,
  encodeRequestBlockFrame,
  parseFrame,
} from "../src/index.ts";
import { FrameBus, blockFields, referenceFields } from "./support/harness.ts";

/** A pair that repeats so it is worth a dictionary entry. */
const PAIR_A = [
  { key: "x-alpha", value: "aaaaaaaaaaaaaaaa" },
  { key: "x-alpha", value: "aaaaaaaaaaaaaaaa" },
];
const PAIR_B = [
  { key: "x-bravo", value: "bbbbbbbbbbbbbbbb" },
  { key: "x-bravo", value: "bbbbbbbbbbbbbbbb" },
];
const PAIR_C = [
  { key: "x-charlie", value: "cccccccccccccccc" },
  { key: "x-charlie", value: "cccccccccccccccc" },
];

function dictionaryFramesOf(encoded: { dictionaryFrames: Uint8Array[] }) {
  return encoded.dictionaryFrames.map((frame) => parseFrame(frame));
}

test("a protected entry is never evicted; the new pair stays literal", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096, maxSlots: 1 });

  const first = encoder.encode(PAIR_A);
  assert.equal(dictionaryFramesOf(first).filter((f) => f.type === "insert").length, 1);

  // The entry for PAIR_A is unacknowledged and referenced by block 1, so it is
  // protected: PAIR_B must not evict it and must fall back to literals.
  const protection = encoder.referenceProtection();
  assert.equal(protection.length, 1);
  assert.deepEqual(protection[0].protectingBlockIds, [first.blockId]);
  assert.deepEqual(encoder.evictionCandidates(), []);

  const second = encoder.encode(PAIR_B);
  assert.equal(second.dictionaryFrames.length, 0, "no eviction or insert");
  assert.equal(
    blockFields(second.blockFrame).every((field) => field.kind === "literal"),
    true,
  );
  assert.equal(
    second.blockByteLength,
    second.literalEquivalentBlockByteLength,
    "the entire block is literal",
  );

  // Acknowledge block 1: the entry is released and becomes evictable.
  encoder.receiveAck(encodeEntryAckFrame({ slot: 0, generation: 1 }));
  encoder.receiveAck(
    encodeBlockAckFrame({
      blockId: first.blockId,
      outcome: "decoded",
      refs: [{ slot: 0, generation: 1 }],
    }),
  );
  assert.equal(encoder.blockedBlockCount, 0);
  assert.deepEqual(encoder.evictionCandidates(), [{ slot: 0, generation: 1 }]);

  const third = encoder.encode(PAIR_B);
  const frames = dictionaryFramesOf(third);
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["evict", "insert"],
  );
  const evict = frames[0];
  const insert = frames[1];
  assert.equal(evict.type === "evict" ? evict.slot : -1, 0);
  assert.equal(evict.type === "evict" ? evict.generation : -1, 1);
  assert.equal(insert.type === "insert" ? insert.slot : -1, 0, "slot is reused");
  assert.equal(insert.type === "insert" ? insert.generation : -1, 2, "with a new generation");
  assert.equal(insert.type === "insert" ? insert.key : "", "x-bravo");
});

test("evicted slots come back with strictly increasing generations", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096, maxSlots: 1 });
  for (const pair of [PAIR_A, PAIR_B, PAIR_C]) {
    encoder.encode(pair);
    for (const ack of encoder.referenceProtection()) {
      encoder.receiveAck(
        encodeEntryAckFrame({ slot: ack.slot, generation: ack.generation }),
      );
    }
    for (const blockId of [1, 2, 3]) {
      const state = encoder.getBlockState(blockId);
      if (state === undefined || state.acknowledged) continue;
      encoder.receiveAck(
        encodeBlockAckFrame({ blockId, outcome: "decoded", refs: state.refs }),
      );
    }
  }
  const snapshot = encoder.dictionarySnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].slot, 0);
  assert.equal(snapshot[0].generation, 3, "slot 0 was reused twice");
  assert.equal(snapshot[0].key, "x-charlie");
});

test("an entry that cannot fit the byte budget is sent literally", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 8, maxSlots: 4 });
  const big = [
    { key: "x-too-big", value: "0123456789" },
    { key: "x-too-big", value: "0123456789" },
  ];
  encoder.encode(big);
  const encoded = encoder.encode(big);
  assert.equal(encoded.dictionaryFrames.length, 0);
  assert.equal(encoded.blockByteLength, encoded.literalEquivalentBlockByteLength);
  assert.equal(encoder.getMetrics().insertedEntries, 0);
});

test("the dictionary respects its total UTF-8 byte limit", () => {
  const limit = 60;
  const encoder = new MetadataEncoder({ maxDictionaryBytes: limit });
  const decoder = new MetadataDecoder();
  const bus = new FrameBus(encoder, decoder);

  for (let round = 0; round < 40; round += 1) {
    const pair = {
      key: `x-k${round % 9}`,
      value: `value-value-${round % 9}-${"z".repeat(5)}`,
    };
    const encoded = encoder.encode([pair, { ...pair }]);
    bus.enqueue(encoded).settle();
    assert.ok(
      encoder.dictionaryByteSize <= limit,
      `round ${round}: occupancy ${encoder.dictionaryByteSize} exceeded ${limit}`,
    );
    assert.deepEqual(decoder.getDecodedBlock(encoded.blockId)?.entries, [pair, pair]);
  }
  assert.ok(encoder.getMetrics().evictedEntries > 0, "pressure should cause evictions");
});

test("cancelling a blocked block emits an abandon ack and frees the entry", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();

  const encoded = encoder.encode(PAIR_A);
  assert.equal(encoded.dictionaryFrames.length, 1);
  // Deliver only the request block: it is blocked on the insert.
  decoder.receiveBlockFrame(encoded.blockFrame);
  assert.equal(decoder.blockedBlockCount, 1);

  const cancel = decoder.cancelBlock(encoded.blockId);
  assert.equal(cancel.acknowledged, true);
  assert.ok(cancel.frame);
  const ack = parseFrame(cancel.frame);
  assert.equal(ack.type, "block-ack");
  if (ack.type !== "block-ack") return;
  assert.equal(ack.blockId, encoded.blockId);
  assert.equal(ack.outcome, "abandoned");
  assert.deepEqual(ack.refs, referenceFields(encoded.blockFrame));

  // The encoder learns that the block will never decode and releases it.
  const applied = encoder.receiveAck(cancel.frame);
  assert.equal(applied.applied, true);
  assert.equal(encoder.blockedBlockCount, 0);
  assert.deepEqual(encoder.evictionCandidates(), [{ slot: 0, generation: 1 }]);

  // No metadata was produced for the abandoned block.
  assert.equal(decoder.hasDecodedBlock(encoded.blockId), false);
  assert.equal(decoder.getMetrics().blocksAbandoned, 1);

  // Repeated cancellation is a no-op and does not produce another ack.
  const again = decoder.cancelBlock(encoded.blockId);
  assert.equal(again.acknowledged, false);
  assert.equal(again.frame, undefined);
});

test("a decoded block cannot be cancelled", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = new FrameBus(encoder, decoder);
  const encoded = encoder.encode(PAIR_A);
  bus.enqueue(encoded).settle();
  assert.ok(decoder.hasDecodedBlock(encoded.blockId));
  const cancel = decoder.cancelBlock(encoded.blockId);
  assert.equal(cancel.acknowledged, false);
});

test("duplicate acknowledgements release references exactly once", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const encoded = encoder.encode(PAIR_A);
  const entryAck = encodeEntryAckFrame({ slot: 0, generation: 1 });
  const blockAck = encodeBlockAckFrame({
    blockId: encoded.blockId,
    outcome: "decoded",
    refs: [{ slot: 0, generation: 1 }],
  });

  assert.equal(encoder.receiveAck(entryAck).applied, true);
  assert.equal(encoder.receiveAck(entryAck).applied, false);
  assert.equal(encoder.receiveAck(blockAck).applied, true);
  assert.equal(encoder.receiveAck(blockAck).applied, false);

  const protection = encoder.referenceProtection();
  assert.deepEqual(protection[0].protectingBlockIds, []);
  assert.equal(protection[0].referenceCount, 0);
  assert.equal(encoder.getMetrics().duplicateAcksIgnored, 2);
  assert.equal(encoder.getMetrics().receivedEntryAcks, 1);
  assert.equal(encoder.getMetrics().receivedBlockAcks, 1);

  // Idempotency: a third application cannot drive counters negative.
  encoder.receiveAck(blockAck);
  assert.deepEqual(encoder.referenceProtection()[0].protectingBlockIds, []);
});

test("a late old-generation ack cannot touch a reused slot", () => {
  // Capacity is ample; pressure comes from having a single slot.
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096, maxSlots: 1 });

  // Insert PAIR_A at slot 0 generation 1 and fully acknowledge it.
  const first = encoder.encode(PAIR_A);
  encoder.receiveAck(encodeEntryAckFrame({ slot: 0, generation: 1 }));
  encoder.receiveAck(encodeBlockAckFrame({ blockId: first.blockId, outcome: "decoded", refs: [] }));
  assert.equal(encoder.evictionCandidates().length, 1);

  // Reuse slot 0 for PAIR_B; the entry now has generation 2 and is protected
  // by the new, unacknowledged block.
  const second = encoder.encode(PAIR_B);
  const types = dictionaryFramesOf(second).map((frame) => frame.type);
  assert.deepEqual(types, ["evict", "insert"]);
  const snapshot = encoder.dictionarySnapshot();
  assert.equal(snapshot[0].generation, 2);
  assert.equal(snapshot[0].key, "x-bravo");

  // Stale entry acknowledgement for generation 1 must not mark generation 2.
  const stale = encoder.receiveAck(encodeEntryAckFrame({ slot: 0, generation: 1 }));
  assert.equal(stale.applied, false);
  assert.equal(encoder.dictionarySnapshot()[0].acknowledged, false);
  assert.equal(encoder.getMetrics().staleAcksIgnored, 1);

  // A stale block ack for an unknown block is ignored too.
  const bogus = encoder.receiveAck(
    encodeBlockAckFrame({
      blockId: 9999,
      outcome: "abandoned",
      refs: [{ slot: 0, generation: 1 }],
    }),
  );
  assert.equal(bogus.applied, false);

  // Protection for the live generation is untouched.
  const live = encoder.referenceProtection().find((entry) => entry.generation === 2);
  assert.ok(live);
  assert.deepEqual(live.protectingBlockIds, [second.blockId]);
  assert.equal(encoder.blockedBlockCount, 1);

  // The real acknowledgement for the live block releases it.
  encoder.receiveAck(encodeEntryAckFrame({ slot: 0, generation: 2 }));
  encoder.receiveAck(
    encodeBlockAckFrame({
      blockId: second.blockId,
      outcome: "decoded",
      refs: [{ slot: 0, generation: 2 }],
    }),
  );
  assert.equal(encoder.blockedBlockCount, 0);
  assert.deepEqual(encoder.referenceProtection()[0].protectingBlockIds, []);
});

test("decoder defers an eviction while a blocked block still needs the entry", () => {
  const decoder = new MetadataDecoder();

  // Insert slot 0 gen 1, then withhold a block that references it and needs a
  // second, missing entry (slot 1 gen 1).
  const block = encodeTwoRefBlock(0, 1, 1, 1);
  decoder.receiveDictionaryFrame(insertFrame(0, 1, "k", "value-one"));
  decoder.receiveBlockFrame(block);
  assert.equal(decoder.blockedBlockCount, 1);
  assert.deepEqual(decoder.protectedSlots(), [
    { slot: 0, generation: 1, blockingBlockIds: [1] },
  ]);

  // An eviction of the referenced entry must be deferred, not applied.
  decoder.receiveDictionaryFrame(evictFrame(0, 1));
  assert.equal(decoder.dictionaryEntryCount, 1);
  assert.deepEqual(decoder.deferredEvictions(), [
    { slot: 0, generation: 1, blockingBlockIds: [1] },
  ]);

  // Insert the missing entry: the block decodes and the deferred eviction runs.
  decoder.receiveDictionaryFrame(insertFrame(1, 1, "k2", "value-two"));
  assert.equal(decoder.blockedBlockCount, 0);
  assert.deepEqual(decoder.getDecodedBlock(1)?.entries, [
    { key: "k", value: "value-one" },
    { key: "k2", value: "value-two" },
  ]);
  assert.equal(decoder.dictionaryEntryCount, 1, "deferred eviction applied after decode");
  assert.deepEqual(decoder.deferredEvictions(), []);
});

test("decoder applies deferred evictions when the block is abandoned", () => {
  const decoder = new MetadataDecoder();
  decoder.receiveDictionaryFrame(insertFrame(0, 1, "k", "value-one"));
  decoder.receiveBlockFrame(encodeTwoRefBlock(0, 1, 1, 1));
  decoder.receiveDictionaryFrame(evictFrame(0, 1));
  assert.equal(decoder.dictionaryEntryCount, 1);

  const cancel = decoder.cancelBlock(1);
  assert.equal(cancel.acknowledged, true);
  assert.equal(decoder.dictionaryEntryCount, 0);
  assert.deepEqual(decoder.deferredEvictions(), []);
});

test("decoder refuses more blocked blocks than the advertised allowance", () => {
  const decoder = new MetadataDecoder({ maxBlockedBlocks: 1 });
  const first = encodeTwoRefBlock(0, 1, 1, 1, 1);
  const second = encodeTwoRefBlock(0, 1, 1, 1, 2);

  decoder.receiveBlockFrame(first);
  assert.equal(decoder.blockedBlockCount, 1);

  const decoderAcks = decoder.drainAcks();
  assert.equal(decoderAcks.length, 0);
  decoder.receiveBlockFrame(second);
  // The second block cannot be withheld, so it is abandoned with an ack.
  assert.equal(decoder.blockedBlockCount, 1);
  const acks = decoder.drainAcks();
  assert.equal(acks.length, 1);
  const ack = parseFrame(acks[0]);
  assert.equal(ack.type, "block-ack");
  if (ack.type !== "block-ack") return;
  assert.equal(ack.outcome, "abandoned");
  assert.equal(ack.blockId, 2);
  assert.equal(decoder.getMetrics().blocksRejectedOverLimit, 1);
});

test("the decoder advertises the same allowance the encoder enforces", () => {
  const decoder = new MetadataDecoder({ maxBlockedBlocks: 3 });
  assert.equal(decoder.advertisedMaxBlockedBlocks, 3);
  const encoder = new MetadataEncoder({
    maxDictionaryBytes: 64,
    peerMaxBlockedBlocks: decoder.advertisedMaxBlockedBlocks,
  });
  assert.equal(encoder.peerMaxBlockedBlocks, 3);
});

test("an insert cannot replace a generation a withheld block still needs", () => {
  const decoder = new MetadataDecoder();
  decoder.receiveDictionaryFrame(insertFrame(0, 1, "k1", "v1"));
  // Withheld block needs slot 0 gen 1 plus a slot that does not exist yet.
  decoder.receiveBlockFrame(encodeTwoRefBlock(0, 1, 3, 1));
  assert.equal(decoder.blockedBlockCount, 1);

  // A newer generation for slot 0 would silently break the withheld block.
  assert.throws(
    () => decoder.receiveDictionaryFrame(insertFrame(0, 2, "k2", "v2")),
    ProtocolError,
  );
  // State is untouched: the old generation is still resolvable.
  assert.equal(decoder.dictionaryEntryCount, 1);
  assert.equal(decoder.dictionaryBytes, "k1".length + "v1".length);
  assert.deepEqual(decoder.blockedBlocks()[0].referenced, [
    { slot: 0, generation: 1 },
    { slot: 3, generation: 1 },
  ]);

  // Once the missing entry arrives, the block decodes and the replacement is
  // then accepted.
  decoder.receiveDictionaryFrame(insertFrame(3, 1, "k3", "v3"));
  assert.equal(decoder.blockedBlockCount, 0);
  decoder.receiveDictionaryFrame(insertFrame(0, 2, "k2", "v2"));
  assert.equal(decoder.dictionaryEntryCount, 2);
  assert.equal(decoder.getMetrics().deferredEvictions, 0);
});

// --- wire helpers ---------------------------------------------------------

function insertFrame(slot: number, generation: number, key: string, value: string): Uint8Array {
  return encodeInsertFrame({ slot, generation, key, value });
}

function evictFrame(slot: number, generation: number): Uint8Array {
  return encodeEvictFrame({ slot, generation });
}

function encodeTwoRefBlock(
  slotA: number,
  generationA: number,
  slotB: number,
  generationB: number,
  blockId = 1,
): Uint8Array {
  return encodeRequestBlockFrame({
    blockId,
    fields: [
      { kind: "reference", slot: slotA, generation: generationA },
      { kind: "reference", slot: slotB, generation: generationB },
    ],
  });
}
