/**
 * Public entry point for the shard routing client.
 *
 * ```ts
 * import { Router, RoutingClient } from './src/index.ts';
 *
 * const router = new Router({ initialAddress: 'seed:7000' });
 * const client = new RoutingClient({ router, transport });
 * const result = await client.call(42, { op: 'ping' });
 * ```
 */

export {
  KEY_SPACE,
  Router,
  isShardKey,
  isRangeEndpoint,
  validatePermanentHint,
  validateTemporaryHint,
  type ApplyResult,
  type ApplyStatus,
  type ConflictInfo,
  type OwnerHint,
  type PermanentHint,
  type RouteSegment,
  type RouterOptions,
  type TemporaryHint,
} from './router.ts';

export {
  RoutingClient,
  type AttemptOutcome,
  type AttemptRecord,
  type AttemptSource,
  type CallFailure,
  type CallFailureReason,
  type CallOptions,
  type CallResult,
  type CallSuccess,
  type ExecutedResponse,
  type HintRecord,
  type HintStatus,
  type RedirectResponse,
  type RoutingClientOptions,
  type TransportAdapter,
  type TransportRequest,
  type TransportResponse,
} from './client.ts';
