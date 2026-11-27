/**
 * Multiple decoders used interleaved: independent instances must not share any
 * state, and a single instance must handle chunks that interleave arbitrarily
 * with other instances' chunks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GrpcWebResponseDecoder } from '../src/decoder.ts';
import { decodeChunks } from '../src/decoder.ts';
import {
  frameBytes,
  messages,
  randomSplits,
  toText,
  trailer,
} from './support/fixtures.ts';

test('two decoders fed alternately keep their own state', () => {
  const bodyA = frameBytes(...messages('a1', 'a2', 'a3'), trailer({ 'grpc-status': '0' }));
  const bodyB = frameBytes(...messages('b1', 'b2'), trailer({ 'grpc-status': '9', 'grpc-message': 'x' }));

  const decoderA = new GrpcWebResponseDecoder();
  const decoderB = new GrpcWebResponseDecoder();
  const gotA: string[] = [];
  const gotB: string[] = [];

  const step = Math.ceil(Math.max(bodyA.length, bodyB.length) / 7);
  let offsetA = 0;
  let offsetB = 0;
  while (offsetA < bodyA.length || offsetB < bodyB.length) {
    if (offsetA < bodyA.length) {
      const end = Math.min(offsetA + step, bodyA.length);
      decoderA.write(bodyA.subarray(offsetA, end));
      offsetA = end;
      for (let m = decoderA.next(); m !== null; m = decoderA.next()) gotA.push(m.data.toString());
    }
    if (offsetB < bodyB.length) {
      const end = Math.min(offsetB + step, bodyB.length);
      decoderB.write(bodyB.subarray(offsetB, end));
      offsetB = end;
      for (let m = decoderB.next(); m !== null; m = decoderB.next()) gotB.push(m.data.toString());
    }
  }

  assert.deepEqual(gotA, ['a1', 'a2', 'a3']);
  assert.equal(decoderA.finish().status, 0);
  assert.deepEqual(gotB, ['b1', 'b2']);
  assert.equal(decoderB.finish().status, 9);
});

test('binary and text decoders interleaved are independent', () => {
  const binaryBody = frameBytes(...messages('bin'), trailer({ 'grpc-status': '0' }));
  const textBody = Buffer.from(toText(binaryBody, [3, 7]), 'ascii');

  const binary = new GrpcWebResponseDecoder({ mode: 'binary' });
  const text = new GrpcWebResponseDecoder({ mode: 'text' });
  const gotBinary: string[] = [];
  const gotText: string[] = [];

  for (let i = 0; i < Math.max(binaryBody.length, textBody.length); i++) {
    if (i < binaryBody.length) {
      binary.write(binaryBody.subarray(i, i + 1));
      for (let m = binary.next(); m !== null; m = binary.next()) gotBinary.push(m.data.toString());
    }
    if (i < textBody.length) {
      text.write(textBody.subarray(i, i + 1));
      for (let m = text.next(); m !== null; m = text.next()) gotText.push(m.data.toString());
    }
  }

  assert.deepEqual(gotBinary, ['bin']);
  assert.deepEqual(gotText, ['bin']);
  assert.equal(binary.finish().status, 0);
  assert.equal(text.finish().status, 0);
});

test('interleaving does not change results for many random schedules', () => {
  const bodyA = frameBytes(...messages('x'.repeat(50)), trailer({ 'grpc-status': '0' }));
  const bodyB = frameBytes(...messages('y'.repeat(40)), trailer({ 'grpc-status': '0' }));
  const expected = decodeChunks([bodyA]).messages.map((m) => m.toString());

  for (const splits of randomSplits(bodyA, 7, 13, 6)) {
    const receiver = new GrpcWebResponseDecoder();
    const other = new GrpcWebResponseDecoder();
    const got: string[] = [];
    const otherGot: string[] = [];
    // A fixed, independent chunk schedule for the interleaved decoder.
    const otherChunks = randomSplits(bodyB, 99, 5, 1)[0]!;
    const steps = Math.max(splits.length, otherChunks.length);
    for (let step = 0; step < steps; step++) {
      // Alternate: one chunk of the body under test, then one of the other.
      const chunk = splits[step];
      if (chunk !== undefined) {
        receiver.write(chunk);
        for (let m = receiver.next(); m !== null; m = receiver.next()) got.push(m.data.toString());
      }
      const otherChunk = otherChunks[step];
      if (otherChunk !== undefined) {
        other.write(otherChunk);
        for (let m = other.next(); m !== null; m = other.next()) otherGot.push(m.data.toString());
      }
    }
    assert.deepEqual(got, expected);
    assert.equal(receiver.finish().status, 0);
    assert.equal(other.finish().status, 0);
    assert.deepEqual(otherGot, ['y'.repeat(40)]);
  }
});
