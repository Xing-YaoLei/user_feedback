/**
 * Runnable demonstration of the two-channel metadata codec.
 *
 *   npm run demo
 *
 * Shows the frames produced on each channel, decodes a request block that
 * deliberately overtakes its dictionary instruction, and prints the byte
 * savings, blocked-block counter, dictionary occupancy and the reference
 * protection basis.
 */
import {
  MetadataDecoder,
  MetadataEncoder,
  parseFrame,
  type ParsedFrame,
} from "./index.ts";

const HEADERS = [
  { key: "x-request-id", value: "9f1c2b7a-4d5e-4f60-8a11-000000000001" },
  { key: "x-user-agent", value: "Mozilla/5.0 (compatible; metadata-demo/1.0)" },
  { key: "x-b3-traceid", value: "80f198ee56343ba864fe8b2a57d3eff7" },
];

function describe(frame: Uint8Array): string {
  const parsed: ParsedFrame = parseFrame(frame);
  switch (parsed.type) {
    case "insert":
      return `insert slot=${parsed.slot} gen=${parsed.generation} "${parsed.key}" = "${parsed.value}"`;
    case "evict":
      return `evict slot=${parsed.slot} gen=${parsed.generation}`;
    case "block":
      return `block #${parsed.blockId} [${parsed.fields
        .map((field) =>
          field.kind === "literal"
            ? `literal("${field.key}")`
            : `ref(${field.slot}:${field.generation})`,
        )
        .join(", ")}]`;
    case "block-ack":
      return `block-ack #${parsed.blockId} ${parsed.outcome}`;
    case "entry-ack":
      return `entry-ack slot=${parsed.slot} gen=${parsed.generation}`;
  }
}

function pumpAcks(encoder: MetadataEncoder, decoder: MetadataDecoder): void {
  for (const frame of decoder.drainAcks()) encoder.receiveAck(frame);
}

const encoder = new MetadataEncoder({
  maxDictionaryBytes: 256,
  maxSlots: 8,
  peerMaxBlockedBlocks: 4,
});
const decoder = new MetadataDecoder({ maxBlockedBlocks: 4, maxDictionaryBytes: 256 });

function encodeAndLog(entries: { key: string; value: string }[]) {
  const block = encoder.encode(entries);
  console.log(
    `\nencoded block #${block.blockId}: block=${block.blockByteLength}B ` +
      `dictionary=${block.dictionaryByteLength}B total=${block.totalByteLength}B ` +
      `(literal-only ${block.literalEquivalentBlockByteLength}B)`,
  );
  for (const frame of block.dictionaryFrames) console.log("  dict  ->", describe(frame));
  console.log("  block ->", describe(block.blockFrame));
  return block;
}

console.log("== block 1: first sighting, so everything stays literal ==");
const first = encodeAndLog(HEADERS);
for (const frame of first.dictionaryFrames) decoder.receiveDictionaryFrame(frame);
decoder.receiveBlockFrame(first.blockFrame);
pumpAcks(encoder, decoder);

console.log("\n== block 2: pairs repeat, so the encoder emits dictionary inserts ==");
const second = encodeAndLog(HEADERS);

console.log("\n   deliver the request block first, ahead of its dictionary frames:");
decoder.receiveBlockFrame(second.blockFrame);
console.log(
  `   decoder blocked blocks=${decoder.blockedBlockCount}, ` +
    `waiting on ${JSON.stringify(decoder.blockedBlocks()[0]?.missing ?? [])}`,
);
console.log("   dictionary instructions are still processed while the block waits:");
for (const frame of second.dictionaryFrames) {
  console.log("  dict  ->", describe(frame));
  decoder.receiveDictionaryFrame(frame);
}
console.log(
  `   decoder blocked blocks=${decoder.blockedBlockCount}; decoded #${second.blockId} = ` +
    JSON.stringify(decoder.getDecodedBlock(second.blockId)?.entries),
);
pumpAcks(encoder, decoder);

console.log("\n== blocks 3..7: warm dictionary, repeated metadata is far shorter ==");
let total = 0;
let literal = 0;
let warmBlockBytes = 0;
for (let round = 0; round < 5; round += 1) {
  const block = encoder.encode(HEADERS);
  total += block.totalByteLength;
  literal += block.literalEquivalentBlockByteLength;
  warmBlockBytes = block.blockByteLength;
  for (const frame of block.dictionaryFrames) decoder.receiveDictionaryFrame(frame);
  decoder.receiveBlockFrame(block.blockFrame);
  pumpAcks(encoder, decoder);
}
console.log(`   5 blocks on the wire: ${total}B vs ${literal}B literal-only`);
console.log(`   a single warm block: ${warmBlockBytes}B request-block frame`);

console.log("\n== telemetry ==");
const metrics = encoder.getMetrics();
console.log(
  `  dictionary occupancy: ${metrics.dictionaryBytes}/${metrics.dictionaryCapacity} bytes ` +
    `across ${metrics.dictionaryEntryCount} entries`,
);
console.log(
  `  blocked blocks: encoder=${metrics.blockedBlockCount}/${metrics.peerMaxBlockedBlocks}, ` +
    `decoder=${decoder.getMetrics().blockedBlockCount}/${decoder.maxBlockedBlocks}`,
);
console.log(
  `  fields: ${metrics.literalFields} literal, ${metrics.referencedFields} referenced; ` +
    `inserts=${metrics.insertedEntries}, evictions=${metrics.evictedEntries}`,
);
console.log("  reference protection basis:");
for (const entry of encoder.referenceProtection()) {
  console.log(
    `    slot=${entry.slot} gen=${entry.generation} "${entry.key}" ` +
      `blocks=[${entry.protectingBlockIds.join(",")}] refs=${entry.referenceCount}`,
  );
}
console.log("\ndemo complete");
