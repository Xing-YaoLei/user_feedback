/**
 * Gateway-style integration helper.
 *
 * Ties the pure rewriter to a caller-supplied storage adapter so that a failed
 * rewrite can never publish partial bytes. The order is deliberate:
 *
 *   1. rewrite (pure; throws with a byte position on any problem)
 *   2. hand the complete buffer to the store adapter
 *
 * The adapter is injectable, so tests and demos can use an in-memory or
 * file-backed implementation without any external service.
 */

import { ProtobufRewriteError } from './errors.ts';
import { resolveOptions, rewriteMessage, type EffectiveOptions } from './index.ts';
import type {
  FieldSchemaInput,
  OptionsInput,
  ReplacementTableInput,
} from './types.ts';

/** Caller-provided sink for the finished message bytes. */
export interface MessageStore {
  /**
   * Persist the complete message. Must be all-or-nothing from the caller's
   * point of view; the gateway never calls this with a partial buffer.
   */
  write(bytes: Uint8Array): void;
}

export interface GatewayRewriteRequest {
  readonly input: Uint8Array;
  readonly schema: FieldSchemaInput;
  readonly replacements: ReplacementTableInput;
  readonly options?: OptionsInput;
  readonly store: MessageStore;
}

export interface GatewayRewriteResult {
  readonly bytes: Buffer;
  readonly byteLength: number;
  /** Options as resolved by the rewriter. */
  readonly options: EffectiveOptions;
  readonly written: true;
}

/**
 * Rewrite then store. If the rewrite rejects, the store is never called and
 * the error propagates unchanged, so no partial result can be observed.
 */
export function rewriteAndStore(
  request: GatewayRewriteRequest,
): GatewayRewriteResult {
  assertStore(request.store);

  const budget = resolveOptions(request.options);
  const bytes = rewriteMessage(
    request.input,
    request.schema,
    request.replacements,
    budget,
  );

  request.store.write(bytes);

  return Object.freeze({
    bytes,
    byteLength: bytes.length,
    options: budget,
    written: true,
  });
}

export function assertStore(store: unknown): asserts store is MessageStore {
  if (
    store === null ||
    typeof store !== 'object' ||
    typeof (store as MessageStore).write !== 'function'
  ) {
    throw new ProtobufRewriteError(
      'INVALID_OPTIONS',
      'store must be an object exposing write(bytes)',
    );
  }
}
