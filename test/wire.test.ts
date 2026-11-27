import test from "node:test";
import assert from "node:assert/strict";

import {
  AckOutcome,
  FRAME_MAGIC,
  FRAME_VERSION,
  FrameType,
  ProtocolError,
  encodeBlockAckFrame,
  encodeEntryAckFrame,
  encodeEvictFrame,
  encodeInsertFrame,
  encodeRequestBlockFrame,
  literalFieldByteLength,
  parseFrame,
  referenceFieldByteLength,
  utf8ByteLength,
} from "../src/index.ts";

test("frame header carries magic, version and type", () => {
  const frame = encodeEntryAckFrame({ slot: 3, generation: 2 });
  assert.equal(frame[0], FRAME_MAGIC);
  assert.equal(frame[1], FRAME_VERSION);
  assert.equal(frame[2], FrameType.EntryAck);
  assert.deepEqual(parseFrame(frame), { type: "entry-ack", slot: 3, generation: 2 });
});

test("insert frame round-trips non-ASCII keys and values by UTF-8 byte length", () => {
  const key = "x-标签-";
  const value = "值🙂";
  const frame = encodeInsertFrame({ slot: 7, generation: 4, key, value });
  const parsed = parseFrame(frame);
  assert.equal(parsed.type, "insert");
  if (parsed.type !== "insert") return;
  assert.equal(parsed.slot, 7);
  assert.equal(parsed.generation, 4);
  assert.equal(parsed.key, key);
  assert.equal(parsed.value, value);
  assert.equal(parsed.keyByteLength, utf8ByteLength(key));
  assert.equal(parsed.valueByteLength, utf8ByteLength(value));
  assert.notEqual(parsed.keyByteLength, key.length);
});

test("evict frame round-trips slot and generation", () => {
  const parsed = parseFrame(encodeEvictFrame({ slot: 11, generation: 9 }));
  assert.deepEqual(parsed, { type: "evict", slot: 11, generation: 9 });
});

test("block frame preserves order and duplicate references", () => {
  const frame = encodeRequestBlockFrame({
    blockId: 42,
    fields: [
      { kind: "literal", key: "a", value: "1" },
      { kind: "reference", slot: 2, generation: 3 },
      { kind: "reference", slot: 2, generation: 3 },
      { kind: "literal", key: "a", value: "1" },
    ],
  });
  const parsed = parseFrame(frame);
  assert.equal(parsed.type, "block");
  if (parsed.type !== "block") return;
  assert.equal(parsed.blockId, 42);
  assert.deepEqual(parsed.fields, [
    { kind: "literal", key: "a", value: "1" },
    { kind: "reference", slot: 2, generation: 3 },
    { kind: "reference", slot: 2, generation: 3 },
    { kind: "literal", key: "a", value: "1" },
  ]);
});

test("block ack round-trips outcome and referenced slot generations", () => {
  const decoded = parseFrame(
    encodeBlockAckFrame({
      blockId: 5,
      outcome: "decoded",
      refs: [
        { slot: 1, generation: 2 },
        { slot: 9, generation: 1 },
      ],
    }),
  );
  assert.deepEqual(decoded, {
    type: "block-ack",
    blockId: 5,
    outcome: "decoded",
    refs: [
      { slot: 1, generation: 2 },
      { slot: 9, generation: 1 },
    ],
  });

  const abandoned = parseFrame(
    encodeBlockAckFrame({ blockId: 6, outcome: "abandoned", refs: [] }),
  );
  assert.equal(abandoned.type, "block-ack");
  if (abandoned.type !== "block-ack") return;
  assert.equal(abandoned.outcome, "abandoned");
  assert.deepEqual(abandoned.refs, []);
  assert.equal(AckOutcome.Abandoned, 1);
});

test("large varints survive a round trip", () => {
  const frame = encodeInsertFrame({
    slot: 1_000_000,
    generation: 123_456,
    key: "k",
    value: "v",
  });
  const parsed = parseFrame(frame);
  assert.equal(parsed.type, "insert");
  if (parsed.type !== "insert") return;
  assert.equal(parsed.slot, 1_000_000);
  assert.equal(parsed.generation, 123_456);
});

test("size estimates match emitted frame sizes", () => {
  assert.equal(literalFieldByteLength("abc", "defgh"), 1 + 1 + 3 + 1 + 5);
  assert.equal(referenceFieldByteLength(0, 1), 3);
  const block = encodeRequestBlockFrame({
    blockId: 1,
    fields: [
      { kind: "literal", key: "abc", value: "defgh" },
      { kind: "reference", slot: 0, generation: 1 },
    ],
  });
  // header(3) + blockId(1) + fieldCount(1) + literal tag+len+bytes (1+1+3+1+5) + reference (1+1+1)
  assert.equal(block.byteLength, 3 + 1 + 1 + 11 + 3);
});

test("malformed frames are rejected with ProtocolError", () => {
  const good = encodeEntryAckFrame({ slot: 1, generation: 1 });

  const badMagic = Uint8Array.from(good);
  badMagic[0] = 0x00;
  assert.throws(() => parseFrame(badMagic), ProtocolError);

  const badVersion = Uint8Array.from(good);
  badVersion[1] = 0x7f;
  assert.throws(() => parseFrame(badVersion), ProtocolError);

  const badType = Uint8Array.from(good);
  badType[2] = 0xfe;
  assert.throws(() => parseFrame(badType), ProtocolError);

  assert.throws(() => parseFrame(good.subarray(0, 3)), ProtocolError);
  assert.throws(() => parseFrame(Uint8Array.from([...good, 0x00])), ProtocolError);

  const badTag = encodeRequestBlockFrame({
    blockId: 1,
    fields: [{ kind: "literal", key: "a", value: "b" }],
  });
  badTag[5] = 0x7e;
  assert.throws(() => parseFrame(badTag), ProtocolError);
});

test("invalid UTF-8 is rejected rather than silently replaced", () => {
  const frame = encodeInsertFrame({ slot: 0, generation: 1, key: "k", value: "v" });
  // Corrupt the key bytes (header 3 + slot 1 + gen 1 + keyLen 1 -> key at 6).
  frame[6] = 0xff;
  assert.throws(() => parseFrame(frame), /invalid UTF-8/);
});

test("encoding rejects non-string fields", () => {
  assert.throws(
    () =>
      encodeInsertFrame({
        slot: 0,
        generation: 1,
        key: 1 as unknown as string,
        value: "v",
      }),
    TypeError,
  );
});
