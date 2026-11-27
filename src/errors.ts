/**
 * Error model for the byte-preserving Protobuf field rewriter.
 *
 * Every failure is reported through a single error type with a stable `code`
 * and, for on-wire problems, the byte offset at which the problem was found.
 * No call ever returns a partially rewritten buffer.
 */

export type RewriteErrorCode =
  | 'INVALID_OPTIONS'
  | 'INVALID_INPUT'
  | 'INVALID_SCHEMA'
  | 'INVALID_REPLACEMENT'
  | 'INVALID_FIELD_NUMBER'
  | 'VARINT_OVERFLOW'
  | 'WRONG_WIRE_TYPE'
  | 'TRUNCATED'
  | 'SIZE_LIMIT'
  | 'UNSUPPORTED_GROUP'
  | 'INVALID_UTF8'
  | 'INTERNAL';

export interface ProtobufRewriteErrorInit {
  /** Byte position associated with the failure, or null for caller/config errors. */
  offset?: number | null;
  /** Field number associated with the failure, when known. */
  fieldNumber?: number | null;
  /** Wire type associated with the failure, when known. */
  wireType?: number | null;
  /** Configured byte ceiling associated with a SIZE_LIMIT failure. */
  limit?: number | null;
  /** Start offset of the field currently being processed, when known. */
  fieldStart?: number | null;
  /**
   * For SIZE_LIMIT failures while building output: the output byte position at
   * which the ceiling would be crossed.
   */
  outputOffset?: number | null;
}

export class ProtobufRewriteError extends Error {
  readonly code: RewriteErrorCode;
  readonly offset: number | null;
  readonly fieldNumber: number | null;
  readonly wireType: number | null;
  readonly limit: number | null;
  readonly fieldStart: number | null;
  readonly outputOffset: number | null;

  constructor(
    code: RewriteErrorCode,
    message: string,
    init: ProtobufRewriteErrorInit = {},
  ) {
    super(message);
    this.name = 'ProtobufRewriteError';
    this.code = code;
    this.offset = init.offset ?? null;
    this.fieldNumber = init.fieldNumber ?? null;
    this.wireType = init.wireType ?? null;
    this.limit = init.limit ?? null;
    this.fieldStart = init.fieldStart ?? null;
    this.outputOffset = init.outputOffset ?? null;
  }
}
