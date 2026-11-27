/**
 * End-to-end demo: build a synthetic gRPC-Web response entirely in memory,
 * then decode it through each public entry point.
 *
 * Run with:  node examples/basic.ts
 * (No network, no files, no external services.)
 */

import { Readable } from 'node:stream';
import {
  createDecoderForResponse,
  createDecoderStream,
  decodeHttpResponseBody,
  decodeResponse,
  encodeFrame,
  FLAG_DATA,
  FLAG_TRAILER,
} from '../src/index.ts';

/** Build one data frame carrying a UTF-8 string. */
function dataFrame(text: string): Buffer {
  return encodeFrame(FLAG_DATA, Buffer.from(text, 'utf8'));
}

/** Build the trailer frame from `name: value` pairs. */
function trailerFrame(fields: Array<[string, string]>): Buffer {
  const text = fields.map(([name, value]) => `${name}: ${value}`).join('\r\n');
  return encodeFrame(FLAG_TRAILER, Buffer.from(text, 'latin1'));
}

const binaryBody = Buffer.concat([
  dataFrame('first message'),
  dataFrame('second message'),
  trailerFrame([
    ['grpc-status', '0'],
    ['grpc-message', ''],
    ['x-request-id', 'demo-123'],
  ]),
]);

// ---------------------------------------------------------------- binary ----
const binary = decodeResponse(binaryBody);
console.log('binary messages :', binary.messages.map((m) => m.toString()));
console.log('binary status   :', binary.trailer.status, binary.trailer.statusText);

// ------------------------------------------------------------------ text ----
// Encode the frame stream as two independently padded base64 segments whose
// boundary falls inside a frame payload — the decoder must not care.
const cut = 9;
const textBody = Buffer.from(
  [
    binaryBody.subarray(0, cut).toString('base64'),
    binaryBody.subarray(cut).toString('base64'),
  ].join(''),
  'ascii',
);
const text = decodeResponse(textBody, { mode: 'text' });
console.log('text   messages :', text.messages.map((m) => m.toString()));
console.log('text   status   :', text.trailer.status, text.trailer.statusText);

// ---------------------------------------------------------------- stream ----
const decoder = createDecoderStream({ mode: 'binary' });
const items: string[] = [];
decoder.on('data', (item) => {
  items.push(item.type === 'message' ? `message(${item.data.length}B)` : `trailer(${item.status})`);
});
// Feed one byte at a time: every boundary is split somewhere.
for (const byte of binaryBody) decoder.write(Buffer.from([byte]));
const ended = new Promise<void>((resolve) => decoder.once('end', resolve));
decoder.end();
await ended; // all items delivered
const completed = await decoder.completion;
console.log('stream items    :', items.join(' -> '));
console.log('stream result   :', completed.messages, 'messages, status', completed.trailer.status);

// ------------------------------------------------------------------ http ----
const http = await decodeHttpResponseBody(
  Readable.from([binaryBody.subarray(0, 7), binaryBody.subarray(7)]),
  { status: 200, contentType: 'application/grpc-web+proto' },
);
console.log('http   messages :', http.messages.map((m) => m.toString()));

// A non-zero status is a *decoded* response whose call failed.
const failedBody = Buffer.concat([
  dataFrame('partial'),
  trailerFrame([
    ['grpc-status', '14'],
    ['grpc-message', 'backend%20unavailable'],
  ]),
]);
try {
  await decodeHttpResponseBody(Readable.from([failedBody]), {
    status: 200,
    contentType: 'application/grpc-web',
  });
} catch (error) {
  console.log('failed call     :', (error as { code: string }).code, (error as Error).message);
}

// A malformed body is a decoding failure, not a failed call.
const { GrpcStatusError } = await import('../src/errors.ts');
try {
  decodeResponse(Buffer.concat([dataFrame('only a message')]), { throwOnNonZeroStatus: true });
} catch (error) {
  console.log('malformed body  :', error instanceof GrpcStatusError ? 'status error' : (error as { code: string }).code);
}

void createDecoderForResponse;
