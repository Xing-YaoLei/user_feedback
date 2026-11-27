/**
 * The Node stream adapter: item delivery, terminal states, backpressure and
 * cancellation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createDecoderStream, GrpcWebDecoderStream } from '../src/stream.ts';
import { CancelledError, GrpcStatusError, ProtocolError } from '../src/errors.ts';
import { encodeFrame, FLAG_DATA, FLAG_TRAILER } from '../src/frame.ts';
import { frameBytes, messages, toText, trailer } from './support/fixtures.ts';

function okBody(): Buffer {
  return frameBytes(...messages('one', 'two'), trailer({ 'grpc-status': '0' }));
}

test('emits messages in order then exactly one trailer, and ends', async () => {
  const stream = createDecoderStream();
  const seen: Array<{ type: string; text?: string; status?: number }> = [];
  stream.on('data', (item) => {
    seen.push(
      item.type === 'message'
        ? { type: item.type, text: item.data.toString() }
        : { type: item.type, status: item.status },
    );
  });
  const ended = once(stream, 'end');
  stream.end(okBody());
  await ended;
  assert.deepEqual(seen, [
    { type: 'message', text: 'one' },
    { type: 'message', text: 'two' },
    { type: 'trailer', status: 0 },
  ]);
  const result = await stream.completion;
  assert.equal(result.status, 0);
  assert.equal(result.messages, 2);
  assert.equal(result.trailer.statusText, 'OK');
});

test('a trailer arrives only after the writable side ends', async () => {
  const stream = createDecoderStream();
  const types: string[] = [];
  stream.on('data', (item) => types.push(item.type));
  // Write only the messages, no end yet.
  stream.write(frameBytes(...messages('one', 'two')));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(types, ['message', 'message'], 'no trailer before end()');
  const ended = once(stream, 'end');
  stream.end(frameBytes(trailer({ 'grpc-status': '0' })));
  await ended;
  assert.deepEqual(types, ['message', 'message', 'trailer']);
});

test('HTTP 200 with an empty body errors (MISSING_TRAILER), never succeeds', async () => {
  const stream = createDecoderStream();
  const errored = once(stream, 'error');
  stream.end(Buffer.alloc(0));
  const [error] = await errored;
  assert.equal((error as any).code, 'MISSING_TRAILER');
  await assert.rejects(stream.completion, (e: any) => e.code === 'MISSING_TRAILER');
  assert.equal(stream.readableLength, 0, 'no items are emitted for an empty body');
});

test('a valid trailer with non-zero status emits the trailer then rejects completion', async () => {
  const body = frameBytes(...messages('part'), trailer({ 'grpc-status': '5', 'grpc-message': 'gone' }));
  const stream = createDecoderStream();
  const items: string[] = [];
  stream.on('data', (item) =>
    items.push(item.type === 'trailer' ? `trailer:${item.status}` : `message:${item.data}`),
  );
  const ended = once(stream, 'end');
  stream.end(body);
  await ended;
  await assert.rejects(
    stream.completion,
    (e: any) => e instanceof GrpcStatusError && e.status === 5 && e.grpcMessage === 'gone',
  );
  assert.deepEqual(items, ['message:part', 'trailer:5']);
});

test('a protocol failure emits no trailer item', async () => {
  const stream = createDecoderStream();
  const items: string[] = [];
  stream.on('data', (item) => items.push(item.type));
  const errored = once(stream, 'error');
  stream.end(frameBytes(...messages('x'))); // no trailer frame
  const [error] = await errored;
  assert.equal((error as any).code, 'MISSING_TRAILER');
  await assert.rejects(stream.completion, (e: any) => e.code === 'MISSING_TRAILER');
  assert.deepEqual(items, ['message'], 'no trailer item on a protocol failure');
});

test('text mode stream decodes multi-segment base64 split into tiny chunks', async () => {
  const binary = okBody();
  const text = Buffer.from(toText(binary, [1, 2, 3, 5, 8, 13, 21]), 'ascii');
  const stream = createDecoderStream({ mode: 'text' });
  const texts: string[] = [];
  stream.on('data', (item) => {
    if (item.type === 'message') texts.push(item.data.toString());
  });
  const ended = once(stream, 'end');
  for (let i = 0; i < text.length; i++) stream.write(text.subarray(i, i + 1));
  stream.end();
  await ended;
  const result = await stream.completion;
  assert.deepEqual(texts, ['one', 'two']);
  assert.equal(result.messages, 2);
});

test('piping from a Readable works end-to-end', async () => {
  const body = okBody();
  const source = Readable.from([body.subarray(0, 3), body.subarray(3, 11), body.subarray(11)]);
  const stream = createDecoderStream();
  const seen: string[] = [];
  stream.on('data', (item) => seen.push(item.type));
  const ended = once(stream, 'end');
  source.pipe(stream);
  await ended;
  const result = await stream.completion;
  assert.equal(result.messages, 2);
  assert.deepEqual(seen, ['message', 'message', 'trailer']);
});

test('unconsumed stream applies backpressure: write() eventually returns false', async () => {
  const body = okBody();
  const stream = createDecoderStream({ readableHighWaterMark: 1, writableHighWaterMark: 8 });
  stream.on('error', () => {});
  stream.pause(); // simulate a consumer that stopped reading

  let accepted = 0;
  let sawFalse = false;
  for (let i = 0; i < body.length; i++) {
    accepted++;
    if (!stream.write(body.subarray(i, i + 1))) {
      sawFalse = true;
      break;
    }
  }
  assert.equal(sawFalse, true, 'write() must report backpressure when the consumer is paused');
  assert.ok(accepted < body.length, 'the whole body must not be accepted while paused');

  // Nothing was lost: resuming delivers the full sequence.
  const items: string[] = [];
  stream.on('data', (item) => items.push(item.type));
  const ended = once(stream, 'end');
  stream.resume();
  stream.end(body.subarray(accepted));
  await ended;
  const result = await stream.completion;
  assert.equal(result.messages, 2);
  assert.deepEqual(items, ['message', 'message', 'trailer']);
});

test('a paused consumer stops decoding rather than buffering messages', async () => {
  // Many messages in one chunk; with a paused reader the stream must not
  // decode all of them into its readable buffer.
  const many = frameBytes(
    ...messages(...Array.from({ length: 60 }, (_, i) => `m${i}`)),
    trailer({ 'grpc-status': '0' }),
  );
  const stream = createDecoderStream({ readableHighWaterMark: 2 });
  stream.on('error', () => {});
  stream.pause();
  stream.end(many);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    stream.messagesEmitted <= 4,
    `expected decoding to stop early, but emitted ${stream.messagesEmitted}`,
  );
  assert.equal(stream.isWaitingForRead, true);

  const received: string[] = [];
  stream.on('data', (item) => {
    if (item.type === 'message') received.push(item.data.toString());
  });
  const ended = once(stream, 'end');
  stream.resume();
  await ended;
  const result = await stream.completion;
  assert.equal(result.messages, 60);
  assert.equal(received.length, 60);
});

test('cancel() stops message output and rejects completion with CancelledError', async () => {
  const stream = createDecoderStream({ readableHighWaterMark: 1 });
  stream.on('error', () => {});
  stream.pause();
  const many = frameBytes(
    ...messages(...Array.from({ length: 30 }, (_, i) => `m${i}`)),
    trailer({ 'grpc-status': '0' }),
  );
  stream.write(many);
  await new Promise((r) => setTimeout(r, 10));
  const emittedAtCancel = stream.messagesEmitted;
  assert.ok(emittedAtCancel > 0, 'some messages should have been emitted');

  const items: string[] = [];
  stream.on('data', (item) => items.push(item.type));
  stream.cancel();

  await assert.rejects(stream.completion, (e: any) => e instanceof CancelledError);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stream.messagesEmitted, emittedAtCancel, 'no messages after cancel');
  assert.equal(items.includes('trailer'), false, 'no trailer is emitted after cancel');
});

test('cancel() before any input is safe and idempotent', async () => {
  const stream = createDecoderStream();
  stream.on('error', () => {});
  stream.cancel();
  stream.cancel();
  await assert.rejects(stream.completion, (e: any) => e.code === 'CANCELLED');
});

test('AbortSignal cancels decoding', async () => {
  const controller = new AbortController();
  const stream = createDecoderStream({ signal: controller.signal });
  stream.on('error', () => {});
  const pending = stream.completion;
  controller.abort();
  await assert.rejects(pending, (e: any) => e.code === 'CANCELLED');
});

test('an already-aborted signal cancels immediately', async () => {
  const controller = new AbortController();
  controller.abort();
  const stream = createDecoderStream({ signal: controller.signal });
  stream.on('error', () => {});
  await assert.rejects(stream.completion, (e: any) => e.code === 'CANCELLED');
});

test('cancel() releases a pending write callback so upstream does not hang', async () => {
  const stream = createDecoderStream({ readableHighWaterMark: 1, writableHighWaterMark: 8 });
  stream.on('error', () => {});
  stream.pause();
  const many = frameBytes(
    ...messages(...Array.from({ length: 20 }, (_, i) => `m${i}`)),
    trailer({ 'grpc-status': '0' }),
  );
  let writeSettled = false;
  stream.write(many, () => {
    writeSettled = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  stream.cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(writeSettled, true, 'the withheld write callback must be released on cancel');
  await assert.rejects(stream.completion);
});

test('pipeline() fails with a protocol error', async () => {
  const stream = createDecoderStream();
  const sink = async function* (source: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    for await (const item of source) yield item;
  };
  const done = pipeline(stream, sink);
  stream.end(Buffer.concat([encodeFrame(FLAG_DATA, Buffer.from('a'))]));
  await assert.rejects(
    done,
    (e: any) => e instanceof ProtocolError && e.code === 'MISSING_TRAILER',
  );
});

test('pipeline() delivers all items for a non-zero status; completion carries the failure', async () => {
  const body = frameBytes(...messages('m'), trailer({ 'grpc-status': '13', 'grpc-message': 'boom' }));
  const stream = createDecoderStream();
  const seen: string[] = [];
  const consume = async (source: AsyncIterable<any>): Promise<void> => {
    for await (const item of source) seen.push(item.type);
  };
  const done = pipeline(stream, consume);
  stream.end(body);
  await done;
  await assert.rejects(stream.completion, (e: any) => e instanceof GrpcStatusError && e.status === 13);
  assert.deepEqual(seen, ['message', 'trailer']);
});

test('decoder stream rejects invalid options', () => {
  assert.throws(() => createDecoderStream({ readableHighWaterMark: 0 }), RangeError);
  assert.throws(() => createDecoderStream({ writableHighWaterMark: -5 }), RangeError);
});

test('bytesReceived and messagesEmitted track progress', async () => {
  const body = okBody();
  const stream = createDecoderStream();
  stream.on('data', () => {});
  stream.write(body.subarray(0, 5));
  await new Promise((r) => setImmediate(r));
  assert.equal(stream.bytesReceived, 5);
  assert.equal(stream.messagesEmitted, 0);
  assert.equal(stream.trailerSeen, false);
  const ended = once(stream, 'end');
  stream.end(body.subarray(5));
  await ended;
  await stream.completion;
  assert.equal(stream.bytesReceived, body.length);
  assert.equal(stream.trailerSeen, true);
});
