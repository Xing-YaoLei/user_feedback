/**
 * The gRPC-Web trailer payload is a header block without a start line and
 * without the terminating blank line: `lower-case-name: value` fields
 * separated by CRLF.  Parsing is strict so malformed trailers are reported
 * instead of silently ignored.
 */

import { GRPC_STATUS_MAX, grpcStatusName, ProtocolError } from './errors.ts';

export interface TrailerField {
  readonly name: string;
  readonly value: string;
}

export interface Trailer {
  /** Fields in arrival order, duplicates included. */
  readonly entries: readonly TrailerField[];
  /** Convenience lookup map; last occurrence wins. */
  readonly fields: ReadonlyMap<string, string>;
  /** The payload rendered as latin1 (one code unit per byte). */
  readonly raw: string;
}

export interface ValidatedTrailer {
  readonly trailer: Trailer;
  readonly status: number;
  readonly statusText: string;
  readonly grpcMessage: string | undefined;
  readonly rawGrpcMessage: string | undefined;
}

function malformed(message: string): ProtocolError {
  return new ProtocolError(message, 'MALFORMED_TRAILER');
}

function isLowerHeaderNameByte(c: number): boolean {
  return (
    (c >= 0x61 && c <= 0x7a) || // a-z
    (c >= 0x30 && c <= 0x39) || // 0-9
    c === 0x2d || // '-'
    c === 0x5f || // '_'
    c === 0x2e // '.'
  );
}

function validateName(name: string, lineNumber: number): void {
  if (name.length === 0) {
    throw malformed(`trailer line ${lineNumber}: empty header name`);
  }
  for (let i = 0; i < name.length; i++) {
    if (!isLowerHeaderNameByte(name.charCodeAt(i))) {
      throw malformed(
        `trailer line ${lineNumber}: header name ${JSON.stringify(name)} must be a lower-case token`,
      );
    }
  }
}

function validateValue(value: string, name: string, lineNumber: number): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // HTAB, SP and visible ASCII are allowed; reject other control bytes.
    if (c === 0x09 || (c >= 0x20 && c <= 0x7e)) continue;
    throw malformed(
      `trailer line ${lineNumber}: field ${JSON.stringify(name)} contains a control or non-ASCII byte`,
    );
  }
}

/** Parse a complete trailer payload without validating grpc-status. */
export function parseTrailer(payload: Uint8Array): Trailer {
  const { buffer, byteOffset, byteLength } = payload;
  const raw = Buffer.from(buffer, byteOffset, byteLength).toString('latin1');
  if (raw.length === 0) {
    throw malformed('trailer payload is empty');
  }

  const lines = raw.split('\r\n');
  // The payload is exactly the CRLF-separated field lines: no start line, no
  // terminating blank line.  A trailing CRLF therefore yields an empty final
  // line, which is rejected below like any other empty line.
  const entries: TrailerField[] = [];
  const fields = new Map<string, string>();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const lineNumber = index + 1;

    if (line.length === 0) {
      throw malformed(`trailer line ${lineNumber} is empty`);
    }
    // split('\r\n') leaves stray CR/LF inside a line when the separator was
    // malformed (e.g. LF-only or CR-only line breaks).
    if (line.indexOf('\r') !== -1 || line.indexOf('\n') !== -1) {
      throw malformed(
        `trailer line ${lineNumber} contains a bare CR or LF; fields must be separated by CRLF`,
      );
    }

    const colon = line.indexOf(':');
    if (colon === -1) {
      throw malformed(`trailer line ${lineNumber} is missing ':'`);
    }
    const name = line.slice(0, colon);
    validateName(name, lineNumber);

    // One optional run of SP/HTAB around the value is not part of it.
    const value = line.slice(colon + 1).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    validateValue(value, name, lineNumber);

    // A trailer field block may in principle repeat a field; the later value
    // wins in `fields`, and `grpc-status` duplicates are rejected by
    // validateTrailer (which needs the count).
    entries.push({ name, value });
    fields.set(name, value);
  }

  return { entries, fields, raw };
}

function countField(trailer: Trailer, name: string): number {
  let count = 0;
  for (const entry of trailer.entries) {
    if (entry.name === name) count++;
  }
  return count;
}

/**
 * Validate the gRPC-Web trailer contract: `grpc-status` must appear exactly
 * once and hold a defined status code (0..16).
 */
export function validateTrailer(trailer: Trailer): ValidatedTrailer {
  const statusCount = countField(trailer, 'grpc-status');
  if (statusCount === 0) {
    throw new ProtocolError(
      'trailer is missing the required grpc-status field',
      'MISSING_GRPC_STATUS',
    );
  }
  if (statusCount > 1) {
    throw new ProtocolError(
      `trailer contains grpc-status ${statusCount} times; it must appear exactly once`,
      'DUPLICATE_GRPC_STATUS',
    );
  }

  const rawStatus = trailer.fields.get('grpc-status')!;
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawStatus)) {
    throw new ProtocolError(
      `grpc-status must be a non-negative integer, got ${JSON.stringify(rawStatus)}`,
      'INVALID_GRPC_STATUS',
    );
  }
  const status = Number(rawStatus);
  if (!Number.isSafeInteger(status) || status > GRPC_STATUS_MAX) {
    throw new ProtocolError(
      `grpc-status ${rawStatus} is outside the defined gRPC code range 0..${GRPC_STATUS_MAX}`,
      'INVALID_GRPC_STATUS',
    );
  }

  const rawGrpcMessage = trailer.fields.get('grpc-message');
  return {
    trailer,
    status,
    statusText: grpcStatusName(status),
    grpcMessage: rawGrpcMessage === undefined ? undefined : decodeGrpcMessage(rawGrpcMessage),
    rawGrpcMessage,
  };
}

/**
 * Percent-decode a `grpc-message` header value.  gRPC defines the value as
 * UTF-8 bytes with characters outside the printable ASCII range (and `%`)
 * percent-encoded.  Invalid escapes are preserved literally, matching gRPC's
 * tolerant decoding.
 */
export function decodeGrpcMessage(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    // '%' followed by two hex digits; the two characters after it must exist,
    // so `i + 2 < value.length` is the correct bound (the last escape can end
    // exactly at the end of the value).
    if (ch === '%' && i + 2 < value.length) {
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const code = value.charCodeAt(i);
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      // Cannot occur for a validated latin1 trailer, but stay total.
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
