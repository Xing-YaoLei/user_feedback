import test from "node:test";
import assert from "node:assert/strict";

import {
  MetadataDecoder,
  MetadataEncoder,
  ProtocolError,
  encodeBlockAckFrame,
  parseFrame,
} from "../src/index.ts";
import { FrameBus, referenceFields } from "./support/harness.ts";

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

test("decoder restart: replaying the logged channels reproduces every block", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = warm(encoder, decoder);

  const payloads = [
    [...PAIRS, ...PAIRS],
    [{ key: "x-extra", value: "000011112222" }, { key: "x-extra", value: "000011112222" }],
    [{ ...PAIRS[0] }, { key: "x-extra", value: "000011112222" }],
  ];
  for (const payload of payloads) {
    bus.enqueue(encoder.encode(payload)).settle();
  }

  // Simulate a process crash: a brand-new decoder with no state.
  const restarted = new MetadataDecoder();
  // Frames may be redelivered in any interleaving after restart; replay the
  // dictionary channel entirely first so blocks are decodable on arrival.
  bus.replayDictionaryLog(restarted);
  bus.replayBlockLog(restarted);
  assert.equal(restarted.blockedBlockCount, 0);

  const decoded = restarted.decodedBlocks();
  assert.equal(decoded.length, payloads.length + 2);
  // The last three decoded blocks correspond to the three payloads, in order.
  const tail = decoded.slice(-payloads.length);
  assert.deepEqual(
    tail.map((block) => block.entries),
    payloads,
  );
});

test("decoder restart: replaying the same frames twice is idempotent", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = warm(encoder, decoder);
  bus.enqueue(encoder.encode(PAIRS)).settle();

  const restarted = new MetadataDecoder();
  for (let round = 0; round < 3; round += 1) {
    bus.replayDictionaryLog(restarted);
    bus.replayBlockLog(restarted);
  }
  // Exactly-once semantics per block id, even with at-least-once delivery.
  assert.equal(restarted.getDecodedBlock(3)?.entries.length, 2);
  assert.equal(restarted.dictionaryEntryCount, 2, "no duplicated dictionary entries");
  // Rounds 2 and 3 replay every already-decided block: 2 rounds x 3 blocks.
  assert.equal(restarted.getMetrics().duplicateBlocksIgnored, 6);
});

test("lost dictionary frame: block stays blocked, then recovers on resend", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const decoder = new MetadataDecoder();
  const bus = warm(encoder, decoder);

  const encoded = encoder.encode([{ key: "x-lost", value: "value-that-needs-insert" }, ...PAIRS]);
  // The block above is all references after warm-up except possibly the new
  // pair, which is literal on first sighting; force a repeat so an insert is
  // emitted, then drop that insert on the floor.
  const repeat = encoder.encode([
    { key: "x-lost", value: "value-that-needs-insert" },
    { key: "x-lost", value: "value-that-needs-insert" },
  ]);
  assert.equal(repeat.dictionaryFrames.length, 1);

  bus.enqueue(encoded);
  bus.enqueue(repeat);
  const dropped = bus.dictionaryQueue.splice(0, bus.dictionaryQueue.length);
  bus.drainBlocks();

  assert.equal(decoder.hasDecodedBlock(repeat.blockId), false);
  assert.equal(decoder.blockedBlockCount, 1);
  assert.deepEqual(
    decoder.blockedBlocks().map((report) => report.blockId),
    [repeat.blockId],
  );

  // Resending the lost dictionary instruction recovers the block.
  for (const frame of dropped) decoder.receiveDictionaryFrame(frame);
  assert.equal(decoder.blockedBlockCount, 0);
  assert.deepEqual(decoder.getDecodedBlock(repeat.blockId)?.entries, [
    { key: "x-lost", value: "value-that-needs-insert" },
    { key: "x-lost", value: "value-that-needs-insert" },
  ]);
});

test("lost request block: encoder keeps protecting its entry until decided", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096, maxSlots: 1 });
  const decoder = new MetadataDecoder();
  const bus = warm(encoder, decoder);

  const encoded = encoder.encode([
    { key: "x-inflight", value: "inflight-value-0000" },
    { key: "x-inflight", value: "inflight-value-0000" },
  ]);
  // With a single slot the warm entry is evicted and the slot reused.
  assert.deepEqual(
    encoded.dictionaryFrames.map((frame) => parseFrame(frame).type),
    ["evict", "insert"],
  );
  // The block is lost in transit, but the dictionary instructions at least
  // reach the peer; the encoder still treats the block as outstanding.
  for (const frame of encoded.dictionaryFrames) decoder.receiveDictionaryFrame(frame);
  bus.pumpAcks();

  // The peer acknowledged the entry, so the blocked-block quota is free, but
  // the encoder still treats the block as outstanding.  Protection is about
  // undecided blocks, not about unacknowledged entries.
  assert.equal(encoder.blockedBlockCount, 0);
  assert.deepEqual(encoder.evictionCandidates(), []);
  const protection = encoder.referenceProtection();
  assert.equal(protection.length, 1);
  assert.equal(protection[0].acknowledged, true);
  assert.deepEqual(protection[0].protectingBlockIds, [encoded.blockId]);

  // An unrelated block must therefore fall back to literals.
  const other = encoder.encode([
    { key: "x-other", value: "other-value-1111" },
    { key: "x-other", value: "other-value-1111" },
  ]);
  assert.equal(other.dictionaryFrames.length, 0);

  // Abandoning the lost block (out-of-band timeout) releases the protection.
  encoder.receiveAck(
    encodeBlockAckAbandoned(encoded.blockId, encoded.blockFrame),
  );
  assert.equal(encoder.blockedBlockCount, 0);
  assert.equal(encoder.evictionCandidates().length, 1);
});

test("a corrupted frame is rejected without mutating decoder state", () => {
  const decoder = new MetadataDecoder();
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const encoded = encoder.encode(PAIRS);
  for (const frame of encoded.dictionaryFrames) decoder.receiveDictionaryFrame(frame);
  const before = decoder.getMetrics();

  const corrupt = Uint8Array.from(encoded.dictionaryFrames[0] ?? encoded.blockFrame);
  corrupt[0] = 0x00;
  assert.throws(() => decoder.receiveDictionaryFrame(corrupt), ProtocolError);
  assert.throws(() => decoder.receiveBlockFrame(corrupt), ProtocolError);

  const after = decoder.getMetrics();
  assert.equal(after.dictionaryEntryCount, before.dictionaryEntryCount);
  assert.equal(after.blocksReceived, before.blocksReceived);
});

test("a truncated frame never decodes partially", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const encoded = encoder.encode([
    { key: "x-trunc", value: "0123456789abcdef" },
    { key: "x-trunc", value: "0123456789abcdef" },
  ]);
  const insert = encoded.dictionaryFrames[0];
  assert.ok(insert);

  const decoder = new MetadataDecoder();
  assert.throws(() => decoder.receiveDictionaryFrame(insert.subarray(0, insert.length - 1)));
  assert.equal(decoder.dictionaryEntryCount, 0);
  assert.equal(decoder.dictionaryBytes, 0);

  decoder.receiveDictionaryFrame(insert);
  assert.equal(decoder.dictionaryEntryCount, 1);
});

test("encoder ignores feedback for unknown blocks and entries", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const result = encoder.receiveAck({
    type: "block-ack",
    blockId: 12345,
    outcome: "decoded",
    refs: [{ slot: 4, generation: 4 }],
  });
  assert.equal(result.applied, false);
  const entryResult = encoder.receiveAck({ type: "entry-ack", slot: 4, generation: 4 });
  assert.equal(entryResult.applied, false);
  assert.equal(encoder.getMetrics().staleAcksIgnored, 2);
});

test("encoder rejects a non-ack frame on the feedback path", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 64 });
  const encoded = encoder.encode(PAIRS);
  const result = encoder.receiveAck(encoded.blockFrame);
  assert.equal(result.applied, false);
  assert.equal(result.type, "ignored");
});

function encodeBlockAckAbandoned(blockId: number, blockFrame: Uint8Array): Uint8Array {
  return encodeBlockAckFrame({
    blockId,
    outcome: "abandoned",
    refs: referenceFields(blockFrame),
  });
}

test("parse of a valid frame after a rejected one still works", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 4096 });
  const encoded = encoder.encode(PAIRS);
  assert.throws(() => parseFrame(Uint8Array.from([1, 2, 3])));
  assert.equal(parseFrame(encoded.blockFrame).type, "block");
});
