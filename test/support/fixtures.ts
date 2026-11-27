/**
 * Test support: synthetic gRPC-Web response bodies and chunking strategies.
 * Everything is generated locally — no network or external service is used.
 */

import { GrpcWebResponseDecoder, decodeChunks } from '../../src/decoder.ts';
import type { DecodedItem, DecodeOptions, TrailerItem } from '../../src/decoder.ts';
import { encodeFrame, FLAG_DATA, FLAG_TRAILER } from '../../src/frame.ts';

export interface SyntheticFrame {
  /** `message` -> flag 0x00, `trailer` -> flag 0x80. */
  readonly kind: 'message' | 'trailer';
  readonly payload: Buffer;
}

export function messages(...payloads: Array<string | Uint8Array>): SyntheticFrame[] {
  return payloads.map((payload) => ({
    kind: 'message' as const,
    payload: typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload),
  }));
}

/** Build a trailer frame from `name: value` pairs. */
export function trailer(
  fields: Record<string, string> | Array<[string, string]> = { 'grpc-status': '0' },
): SyntheticFrame {
  return rawTrailer(trailerText(fields));
}

export function trailerText(
  fields: Record<string, string> | Array<[string, string]> = { 'grpc-status': '0' },
): string {
  const pairs = Array.isArray(fields) ? fields : Object.entries(fields);
  return pairs.map(([name, value]) => `${name}: ${value}`).join('\r\n');
}

/** Build a trailer frame from a verbatim payload string (latin1). */
export function rawTrailer(text: string): SyntheticFrame {
  return { kind: 'trailer', payload: Buffer.from(text, 'latin1') };
}

/** Serialize synthetic frames into the binary gRPC-Web frame stream. */
export function frameBytes(...frames: SyntheticFrame[]): Buffer {
  return Buffer.concat(
    frames.map((f) => encodeFrame(f.kind === 'trailer' ? FLAG_TRAILER : FLAG_DATA, f.payload)),
  );
}

/** Build a frame with an arbitrary flag byte (for negative tests). */
export function rawFrame(flag: number, payload: Uint8Array | string = ''): Buffer {
  return encodeFrame(flag, typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload);
}

/** Encode binary bytes as grpc-web-text, one padded block per cut offset. */
export function toText(binary: Buffer, cuts: number[] = []): string {
  const points = [0, ...cuts.filter((n) => n > 0 && n < binary.length), binary.length];
  let text = '';
  for (let i = 1; i < points.length; i++) {
    text += binary.subarray(points[i - 1]!, points[i]!).toString('base64');
  }
  return text;
}

export type Splitter = (bytes: Buffer) => Buffer[];

export const oneByteAtATime: Splitter = (bytes) => {
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i++) out.push(Buffer.from(bytes.subarray(i, i + 1)));
  return out;
};

export function fixedSize(size: number): Splitter {
  return (bytes) => {
    const out: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += size) {
      out.push(Buffer.from(bytes.subarray(i, Math.min(i + size, bytes.length))));
    }
    return out;
  };
}

/** Every possible two-chunk split of a buffer. */
export function everyTwoWaySplit(bytes: Buffer): Buffer[][] {
  const out: Buffer[][] = [];
  for (let cut = 1; cut < bytes.length; cut++) {
    out.push([Buffer.from(bytes.subarray(0, cut)), Buffer.from(bytes.subarray(cut))]);
  }
  return out;
}

/** Deterministic pseudo-random splits of `bytes`, driven by a seeded LCG. */
export function randomSplits(bytes: Buffer, seed: number, maxChunk: number, runs = 8): Buffer[][] {
  let state = seed >>> 0;
  const rand = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const plans: Buffer[][] = [];
  for (let run = 0; run < runs; run++) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; ) {
      const size = 1 + Math.floor(rand() * maxChunk);
      const end = Math.min(offset + size, bytes.length);
      chunks.push(Buffer.from(bytes.subarray(offset, end)));
      offset = end;
    }
    plans.push(chunks);
  }
  return plans;
}

export interface Collected {
  readonly messages: Buffer[];
  readonly trailer: TrailerItem;
}

/** Decode chunks fully; throws whatever the decoder throws. */
export function collect(chunks: Iterable<Uint8Array>, options: DecodeOptions = {}): Collected {
  return decodeChunks(chunks, options);
}

export type Attempt =
  | { ok: true; value: Collected }
  | { ok: false; error: unknown };

/** Decode, returning the error instead of throwing. */
export function attempt(chunks: Iterable<Uint8Array>, options: DecodeOptions = {}): Attempt {
  try {
    return { ok: true, value: collect(chunks, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function errorOf(result: Attempt): any {
  if (result.ok) throw new Error('expected decoding to fail, but it succeeded');
  return result.error;
}

/** Items a decoder produces, pulled as each chunk arrives. */
export function itemsPerChunk(
  chunks: readonly Uint8Array[],
  options: DecodeOptions = {},
): { items: DecodedItem[]; perChunk: number[] } {
  const decoder = new GrpcWebResponseDecoder(options);
  const items: DecodedItem[] = [];
  const perChunk: number[] = [];
  const drain = (): number => {
    let count = 0;
    for (let item = decoder.next(); item !== null; item = decoder.next()) {
      items.push(item);
      count++;
    }
    return count;
  };
  for (const chunk of chunks) {
    decoder.write(chunk);
    perChunk.push(drain());
  }
  items.push(decoder.finish());
  return { items, perChunk };
}
