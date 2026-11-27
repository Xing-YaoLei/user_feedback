/**
 * Public entry point for the discovery-view synthesis module.
 *
 * @example
 * import { DiscoverySynthesizer } from "./src/index.ts";
 *
 * const synth = new DiscoverySynthesizer({
 *   sources: [
 *     { sourceId: "primary", priority: 0 },
 *     { sourceId: "fallback", priority: 10 },
 *   ],
 * });
 *
 * synth.apply([
 *   {
 *     receivedAt: 1_000,
 *     update: {
 *       kind: "snapshot",
 *       sourceId: "primary",
 *       generation: 1,
 *       sequence: 0,
 *       ttlMs: 5_000,
 *       records: new Map([
 *         ["checkout", new Map([["i-1", { kind: "value", value: { host: "10.0.0.1" } }]])],
 *       ]),
 *     },
 *   },
 * ]);
 *
 * const view = synth.query(2_000, { serviceId: "checkout" });
 */

export { DiscoverySynthesizer } from "./synthesizer.ts";
export { DiscoveryViewError } from "./errors.ts";
export type { DiscoveryViewErrorCode } from "./errors.ts";
export type {
  SourceConfig,
  ConfigureOptions,
  QueryOptions,
} from "./types.ts";
export type {
  SourceId,
  ServiceId,
  Generation,
  SequenceNumber,
  AvailableRecord,
  TombstoneRecord,
  InstanceRecord,
  SnapshotUpdate,
  DeltaUpdate,
  SourceUpdate,
  Receipt,
  SourceRef,
  ShadowReason,
  ShadowedFact,
  AvailableResolution,
  DeletedResolution,
  AbsentResolution,
  InstanceResolution,
  SourceIssueReason,
  SourceIssue,
  SourceStatus,
  DiscoveryView,
  UpdateDisposition,
  IgnoredReason,
  RejectedReason,
  BatchUpdateResult,
  BatchOutcome,
  BatchResult,
} from "./types.ts";
