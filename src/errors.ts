/**
 * Structured errors raised by the discovery-view module.
 *
 * Errors are reserved for programmer / configuration mistakes (malformed input
 * that cannot be attributed to a source). Recoverable source problems — a
 * sequence gap, expiry, a conflicting duplicate — are reported as
 * `SourceIssue` values on the synthesised view instead of thrown, so a single
 * bad source can never take the whole view down.
 */
export type DiscoveryViewErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONFIG"
  | "UNKNOWN_SOURCE"
  | "DUPLICATE_SOURCE";

export class DiscoveryViewError extends Error {
  readonly code: DiscoveryViewErrorCode;

  constructor(code: DiscoveryViewErrorCode, message: string) {
    super(message);
    this.name = "DiscoveryViewError";
    this.code = code;
  }
}
