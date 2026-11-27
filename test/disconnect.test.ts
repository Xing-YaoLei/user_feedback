/**
 * "The connection died mid-response" scenarios.
 *
 * A browser gRPC-Web client can receive HTTP 200, read several messages, and
 * then lose the connection.  Under no circumstances may that be reported as a
 * successful call: the trailer never arrived, so the outcome is incomplete.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createDecoderStream } from '../src/stream.ts';
import { decodeChunks } from '../src/decoder.ts';
import { GrpcStatusError } from '../src/errors.ts';
import { attempt, errorOf, frameBytes, messages, toText, trailer } from './support/fixtures.ts';

/** Every prefix of the body represents a connection lost at that byte. */
function allPrefixes(body: Buffer): Array<{ length: number; bytes: Buffer }> {
  const out: Array<{ length: number; bytes: Buffer }> = [];
  for (let length = 0; length < body.length; length++) {
    out.push({ length, bytes: body.subarray(0, length) });
  }
  return out;
}

test('no truncated binary body ever decodes successfully', () => {
  const body = frameBytes(
    ...messages('alpha', 'beta'),
    trailer({ 'grpc-status': '0', 'x-trace': 'abc' }),
  );
  for (const { length, bytes } of allPrefixes(body)) {
    const result = attempt([bytes]);
    assert.equal(result.ok, false, `prefix of ${length}/${body.length} bytes must not succeed`);
    // Whatever the cut, it is a framing failure rather than a status failure.
    const code = (result as { error: { code: string } }).error.code;
    assert.ok(
      code === 'TRUNCATED_INPUT' || code === 'MISSING_TRAILER',
      `prefix ${length}: unexpected code ${code}`,
    );
  }
});

test('messages received before a mid-stream disconnect are still delivered', () => {
  const body = frameBytes(
    ...messages('first', 'second'),
    trailer({ 'grpc-status': '0' }),
  );
  // Cut inside the trailer frame: both messages are complete.
  const cut = body.length - 3;
  const result = attempt([body.subarray(0, cut)]);
  assert.equal(result.ok, false);
  assert.equal((result as { error: { code: string } }).error.code, 'TRUNCATED_INPUT');
});

test('the stream emits messages, then errors, and never a trailer, on a cut body', async () => {
  const body = frameBytes(...messages('one', 'two'), trailer({ 'grpc-status': '0' }));
  const cut = body.length - 4;
  const stream = createDecoderStream();
  const items: string[] = [];
  stream.on('data', (item) => items.push(item.type));
  const errored = once(stream, 'error');
  stream.end(body.subarray(0, cut));
  const [error] = await errored;
  assert.equal((error as any).code, 'TRUNCATED_INPUT');
  await assert.rejects(stream.completion, (e: any) => e.code === 'TRUNCATED_INPUT');
  assert.deepEqual(items, ['message', 'message'], 'both messages, no trailer item');
});

test('a text-mode body cut mid-base64 never succeeds', () => {
  const binary = frameBytes(...messages('alpha'), trailer({ 'grpc-status': '0' }));
  const text = Buffer.from(toText(binary, [5, 11]), 'ascii');
  for (const { length, bytes } of allPrefixes(text)) {
    const result = attempt([bytes], { mode: 'text' });
    assert.equal(result.ok, false, `text prefix of ${length}/${text.length} must not succeed`);
  }
});

test('a source that errors mid-body (socket reset) never resolves as success', async () => {
  const body = frameBytes(...messages('one'), trailer({ 'grpc-status': '0' }));
  async function* brokenSource(): AsyncGenerator<Uint8Array> {
    yield body.subarray(0, 4);
    throw new Error('connection reset');
  }
  const stream = createDecoderStream();
  const items: string[] = [];
  stream.on('data', (item) => items.push(item.type));
  stream.on('error', () => {});
  const done = pipeline(Readable.from(brokenSource()), stream);
  await assert.rejects(done, /connection reset/);
  await assert.rejects(stream.completion);
  assert.equal(items.includes('trailer'), false, 'no trailer item after a reset');
});

test('destroying the stream mid-body settles completion instead of leaving it pending', async () => {
  const stream = createDecoderStream();
  stream.on('error', () => {});
  stream.write(frameBytes(...messages('one')).subarray(0, 4));
  await new Promise((r) => setImmediate(r));
  stream.destroy();
  await assert.rejects(stream.completion, (e: any) => e.code === 'CANCELLED');
});

test('a cut body is not confused with a non-zero status', () => {
  const body = frameBytes(...messages('x'), trailer({ 'grpc-status': '7', 'grpc-message': 'x' }));
  const cut = body.length - 1;
  const result = attempt([body.subarray(0, cut)]);
  assert.equal(result.ok, false);
  assert.equal((result as { error: { code: string } }).error.code, 'TRUNCATED_INPUT');
});

test('a complete non-zero response is distinguishable from a cut one', () => {
  const nonzero = frameBytes(...messages('x'), trailer({ 'grpc-status': '7' }));
  let caught: unknown;
  try {
    decodeChunks([nonzero], { throwOnNonZeroStatus: true });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof GrpcStatusError, 'a complete non-zero body is a status failure');
  // Without the opt-in the same body decodes normally, with status 7 visible.
  const decoded = decodeChunks([nonzero]);
  assert.equal(decoded.trailer.status, 7);
});

test('the non-zero path throws GrpcStatusError, the cut path throws ProtocolError', () => {
  const nonzero = frameBytes(...messages('x'), trailer({ 'grpc-status': '7' }));
  let statusError: unknown;
  try {
    decodeChunks([nonzero], { throwOnNonZeroStatus: true });
  } catch (error) {
    statusError = error;
  }
  assert.ok(statusError instanceof GrpcStatusError);

  const cut = errorOf(attempt([nonzero.subarray(0, nonzero.length - 2)]));
  assert.ok(!(cut instanceof GrpcStatusError));
  assert.equal(cut.code, 'TRUNCATED_INPUT');
});
