import test from "node:test";
import assert from "node:assert/strict";

import {
  MetadataDecoder,
  MetadataEncoder,
  TwoChannelLink,
  createLinkedCodec,
  parseFrame,
} from "../src/index.ts";

const HEADERS = [
  { key: "x-request-id", value: "9f1c2b7a-4d5e-4f60-8a11-000000000001" },
  { key: "x-user-agent", value: "Mozilla/5.0 (compatible; metadata-link/1.0)" },
];

test("link delivers dictionary and block frames on independent channels", () => {
  const { encoder, decoder, link } = createLinkedCodec({ maxDictionaryBytes: 512 });
  // Warm: first block is literal, second emits inserts.
  link.encodeAndSend(HEADERS);
  link.settle();

  const second = link.encodeAndSend(HEADERS);
  assert.equal(second.dictionaryFrames.length, 2);
  assert.equal(link.pendingDictionaryFrames, 2);
  assert.equal(link.pendingBlockFrames, 1);

  // Block channel overtakes the dictionary channel.
  link.deliverBlocks();
  assert.equal(decoder.blockedBlockCount, 1);
  assert.deepEqual(link.blockedBlockIds(), [second.blockId]);

  link.deliverDictionary();
  assert.equal(decoder.blockedBlockCount, 0);
  assert.deepEqual(decoder.getDecodedBlock(second.blockId)?.entries, HEADERS);

  link.pumpAcks();
  assert.equal(encoder.blockedBlockCount, 0);
});

test("link can deliver dictionary frames one at a time", () => {
  const { decoder, link } = createLinkedCodec({ maxDictionaryBytes: 512 });
  link.encodeAndSend(HEADERS);
  link.settle();
  const second = link.encodeAndSend(HEADERS);
  link.deliverBlocks();

  assert.equal(link.deliverDictionary(1), 1);
  assert.equal(decoder.blockedBlockCount, 1, "still one insert short");
  assert.equal(link.deliverDictionary(1), 1);
  assert.equal(decoder.blockedBlockCount, 0);
  assert.ok(decoder.getDecodedBlock(second.blockId));
});

test("link settle drains everything and leaves no pending state", () => {
  const { encoder, decoder, link } = createLinkedCodec({
    maxDictionaryBytes: 256,
    maxSlots: 4,
    maxBlockedBlocks: 2,
  });
  for (let round = 0; round < 25; round += 1) {
    link.encodeAndSend([
      { key: `x-k${round % 4}`, value: `value-${round % 4}-${"q".repeat(8)}` },
      { key: "x-const", value: "constant-value" },
      { key: `x-k${round % 4}`, value: `value-${round % 4}-${"q".repeat(8)}` },
    ]);
  }
  link.settle();
  assert.equal(link.pending, 0);
  assert.equal(decoder.blockedBlockCount, 0);
  assert.equal(encoder.blockedBlockCount, 0);
  assert.equal(decoder.drainAcks().length, 0);
  assert.ok(decoder.decodedBlocks().length >= 25);
});

test("link reports frames on all three paths", () => {
  const seen: string[] = [];
  const { link } = createLinkedCodec({
    maxDictionaryBytes: 512,
    link: {
      onFrame: (channel, frame) => {
        const type = parseFrame(frame).type;
        seen.push(`${channel}:${type}`);
      },
    },
  });
  link.encodeAndSend(HEADERS);
  link.settle();
  link.encodeAndSend(HEADERS);
  link.settle();
  assert.equal(seen.filter((entry) => entry === "dictionary:insert").length, 2);
  assert.ok(seen.includes("block:block"));
  assert.ok(seen.includes("feedback:entry-ack"));
  assert.ok(seen.includes("feedback:block-ack"));
});

test("link cancelBlock abandons a withheld block and frees encoder protection", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 512 });
  const decoder = new MetadataDecoder();
  const link = new TwoChannelLink(encoder, decoder);

  link.encodeAndSend(HEADERS);
  link.settle();
  const second = link.encodeAndSend(HEADERS);
  // Overtake: block arrives, dictionary frames are lost.
  link.deliverBlocks();
  assert.deepEqual(link.blockedBlockIds(), [second.blockId]);
  assert.equal(encoder.blockedBlockCount, 1);

  const cancel = link.cancelBlock(second.blockId);
  assert.equal(cancel.acknowledged, true);
  assert.equal(link.blockedBlockIds().length, 0);
  assert.equal(encoder.blockedBlockCount, 0);
  // The entries are now evictable, having never been confirmed decoded.
  assert.ok(encoder.evictionCandidates().length > 0);
});

test("link with autoPumpAcks disabled requires explicit pumping", () => {
  const encoder = new MetadataEncoder({ maxDictionaryBytes: 512 });
  const decoder = new MetadataDecoder();
  const link = new TwoChannelLink(encoder, decoder, { autoPumpAcks: false });

  link.encodeAndSend(HEADERS);
  link.deliverDictionary();
  link.deliverBlocks();
  assert.ok(decoder.getDecodedBlock(1));
  // Acks are still queued in the decoder, so the encoder has not seen them.
  assert.equal(encoder.getMetrics().receivedBlockAcks, 0);
  // The first block is literal-only, so the sole ack is the decoded-block ack.
  assert.equal(decoder.drainAcks().length, 1);
});

test("TwoChannelLink.refsOf returns a defensive copy", () => {
  const { decoder, link } = createLinkedCodec({ maxDictionaryBytes: 512 });
  link.encodeAndSend(HEADERS);
  link.settle();
  const second = link.encodeAndSend(HEADERS);
  link.settle();
  const decoded = decoder.getDecodedBlock(second.blockId);
  assert.ok(decoded);
  const refs = TwoChannelLink.refsOf(decoded);
  assert.equal(refs.length, 2);
  refs[0].slot = 999;
  assert.notEqual(decoded.refs[0].slot, 999);
});
