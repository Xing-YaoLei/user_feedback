export {
  Registry,
  WatchHandle,
  type CompactionResult,
  type RegistryStats,
  type RegistryEvents,
} from './registry.ts';
export { DiscoveryClient, type ClientOptions, type TraceEntry, type PageTrace } from './client.ts';
export { ManualClock, SystemClock } from './clock.ts';
export {
  CursorExpiredError,
  GenerationConflictError,
  InvalidTokenError,
  RegistryClosedError,
  RegistryError,
  SessionExpiredError,
  type Clock,
  type EventRecord,
  type ExpiryReason,
  type Instance,
  type ListOptions,
  type MutateResult,
  type Mutation,
  type PageResult,
  type RebuildBasis,
  type RegistryOptions,
  type RevisionRecord,
  type WatchEvent,
  type WatchMessage,
  type WatchProgress,
} from './types.ts';
