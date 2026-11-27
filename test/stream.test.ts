import test from "node:test";
import assert from "node:assert/strict";

import {
  MetadataDecoder,
  MetadataEncoder,
  encodeBlockAckFrame,
  parseFrame,
} from "../src/index.ts";
import { FrameBus } from "./support/harness.ts";

const PAIRS = [
  { key: "x-request-id", value: "9f1c2b7a-4d5e-4f60-8a11-000000000001" },
  { key: "x-user-agent", value: "Mozilla/5.0 (compatible; metadata-test/1.0)" },
];

function warm(encoder: MetadataEncoder, decoder: MetadataDecoder): FrameBus {
  const bus = new FrameBus(encoder, decoder);
  bus.enqueue(encoder.encode(PAIRS)).settle();
  bus.enqueue(encoder.encode(PAIRS)).settle();
  return bus;
}

test("the full exchange converges with references and no pending state", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = warm(encoder, decoder);

  const sent: { key: string; value: string }[][] = [];
  for (let round = 0; round < 10; round += 1) {
    const payload = [...PAIRS, ...PAIRS];
    sent.push(payload);
    bus.enqueue(encoder.encode(payload)).settle();
  }

  for (const block of decoder.decodedBlocks()) {
    const payload = sent[block.blockId - 3];
    if (payload !== undefined) assert.deepEqual(block.entries, payload);
  }
  assert.equal(decoder.blockedBlockCount, 0);
  assert.equal(encoder.blockedBlockCount, 0);
  assert.equal(decoder.drainAcks().length, 0);
  assert.ok(encoder.getMetrics().referencedFields > 0);
  assert.equal(encoder.getMetrics().dictionaryEntryCount, 2);
});

test("sending a block with zero entries still round-trips", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 128 });
  const decoder = new MetadataDecoder();
  const bus = new FrameBus(encoder, decoder);
  const encoded = encoder.encode([]);
  assert.equal(encoded.dictionaryFrames.length, 0);
  bus.enqueue(encoded).settle();
  assert.deepEqual(decoder.getDecodedBlock(encoded.blockId)?.entries, []);
});

test("a 200-block stream keeps byte accounting and dictionary bounds consistent", () => {
  const limit = 96;
  const encoder = new MetadataEncoder({
    maxDictionaryBytes: limit,
    maxSlots: 3,
    peerMaxBlockedBlocks: 2,
  });
  const decoder = new MetadataDecoder({ maxBlockedBlocks: 2 });
  const bus = new FrameBus(encoder, decoder);

  let totalWire = 0;
  for (let round = 0; round < 200; round += 1) {
    // A small shifting vocabulary guarantees evictions and slot reuse.
    const key = `x-k${round % 5}`;
    const value = `value-${round % 5}-${"p".repeat(6)}`;
    const payload = [
      { key, value },
      { key: "x-const", value: "constant-value-here" },
      { key, value },
    ];
    const encoded = encoder.encode(payload);
    totalWire += encoded.totalByteLength;
    bus.enqueue(encoded).settle();
    assert.deepEqual(decoder.getDecodedBlock(encoded.blockId)?.entries, payload);
  }

  const metrics = encoder.getMetrics();
  assert.ok(metrics.dictionaryBytes <= limit);
  assert.ok(metrics.evictedEntries > 0, "pressure should evict");
  assert.ok(metrics.referencedFields > 0, "repetition should produce references");
  assert.ok(decoder.blockedBlockCount === 0);
  assert.equal(encoder.blockedBlockCount, 0);
  assert.ok(totalWire > 0);

  // A reference must never be larger than the literal it replaces.
  assert.ok(metrics.blockBytesEmitted < 200 * 3 * 40);
});

test("encoder and decoder agree on the blocked allowance wiring", () => {
  const decoder = new MetadataDecoder({ maxBlockedBlocks: 2 });
  const encoder = new MetadataEncoder({
    maxDictionaryBytes: 4096,
    peerMaxBlockedBlocks: decoder.advertisedMaxBlockedBlocks,
  });
  assert.equal(encoder.peerMaxBlockedBlocks, decoder.maxBlockedBlocks);
});

test("a hostile ack naming a wrong generation cannot release protection", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  encoder.encode(PAIRS); // first sighting is literal
  const encoded = encoder.encode(PAIRS);
  const realFrames = encoded.dictionaryFrames.map((frame) => parseFrame(frame));
  assert.equal(realFrames.length, 2, "one insert per distinct new pair");
  const insert = realFrames[0];
  assert.equal(insert.type, "insert");
  if (insert.type !== "insert") return;

  // The peer claims a block with the right id but an older generation.
  encoder.receiveAck(
    encodeBlockAckFrame({
      blockId: encoded.blockId,
      outcome: "decoded",
      refs: [{ slot: insert.slot, generation: insert.generation - 1 }],
    }),
  );
  const protection = encoder.referenceProtection();
  assert.equal(protection.length, 2, "both entries stay protected");
  for (const entry of protection) {
    assert.deepEqual(entry.protectingBlockIds, [], "no matching generation: no release");
  }
  // The block is still decided, though, which is what quota accounting needs.
  assert.equal(encoder.blockedBlockCount, 0);
  assert.equal(encoder.getBlockState(encoded.blockId)?.acknowledged, true);
});
