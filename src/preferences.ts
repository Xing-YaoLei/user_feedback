/**
 * Parsing and normalisation of `Accept-Encoding` preferences.
 *
 * The negotiator accepts the preference list in the shape a gateway usually
 * has after parsing the request header (pairs of coding name and q value) and
 * also ships a small parser for the raw header for convenience.
 *
 * Rules implemented here follow RFC 9110 §12.5.3:
 *
 *   - an explicit entry for a coding overrides the `*` wildcard;
 *   - `identity` has q=1 by default when it is not mentioned explicitly;
 *   - a `*;q=0` wildcard removes the implicit `identity` entry;
 *   - q values are clamped to the inclusive range 0..1.
 */

export interface EncodingPreference {
  /** Coding name exactly as parsed, e.g. `gzip`, `br`, `*`. */
  coding: string;
  /** Quality value in the range 0..1. */
  q: number;
}

export type PreferenceEntry =
  | EncodingPreference
  | readonly [string, number?]
  | string;

export type AcceptEncodingInput =
  | readonly PreferenceEntry[]
  | ReadonlyMap<string, number | string | undefined>
  | Record<string, number | string | undefined>
  | string
  | null
  | undefined;

export interface ParsedPreferences {
  /** Lower-case coding name → q value. Later duplicates overwrite earlier ones. */
  readonly explicit: ReadonlyMap<string, number>;
  /** q value of the `*` entry, when one was supplied. */
  readonly wildcard: number | undefined;
  /** Coding names in the order they were first mentioned (for diagnostics). */
  readonly order: readonly string[];
}

export const WILDCARD = '*';

/**
 * Parse a raw `Accept-Encoding` field value into preference entries.
 *
 * Malformed q parameters make that entry unacceptable (q=0) rather than
 * failing the whole header, which matches how real gateways behave.
 */
export function parseAcceptEncoding(value: string | null | undefined): EncodingPreference[] {
  if (value === null || value === undefined) return [];
  const entries: EncodingPreference[] = [];
  for (const part of value.split(',')) {
    const piece = part.trim();
    if (piece.length === 0) continue;
    const [rawCoding = '', ...params] = piece.split(';');
    const coding = rawCoding.trim();
    if (coding.length === 0) continue;
    let q = 1;
    for (const param of params) {
      const eq = param.indexOf('=');
      if (eq < 0) continue;
      const key = param.slice(0, eq).trim().toLowerCase();
      if (key !== 'q') continue;
      const parsed = Number(param.slice(eq + 1).trim());
      q = Number.isFinite(parsed) ? clampQ(parsed) : 0;
    }
    entries.push({ coding, q });
  }
  return entries;
}

/** Normalise any supported preference input into explicit entries + wildcard. */
export function normalizePreferences(input: AcceptEncodingInput): ParsedPreferences {
  const explicit = new Map<string, number>();
  const order: string[] = [];
  let wildcard: number | undefined;

  const add = (rawCoding: unknown, rawQ: unknown): void => {
    if (typeof rawCoding !== 'string') return;
    const coding = rawCoding.trim().toLowerCase();
    if (coding.length === 0) return;
    const q = coerceQ(rawQ, coding);
    if (!order.includes(coding)) order.push(coding);
    if (coding === WILDCARD) wildcard = q;
    else explicit.set(coding, q);
  };

  if (input === null || input === undefined) {
    return { explicit, wildcard, order };
  }

  if (typeof input === 'string') {
    for (const entry of parseAcceptEncoding(input)) add(entry.coding, entry.q);
    return { explicit, wildcard, order };
  }

  if (input instanceof Map) {
    for (const [coding, q] of input) add(coding, q);
    return { explicit, wildcard, order };
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (typeof entry === 'string') {
        const parsed = parseAcceptEncoding(entry);
        if (parsed.length === 1) {
          const only = parsed[0]!;
          add(only.coding, only.q);
        } else {
          add(entry, 1);
        }
        continue;
      }
      if (Array.isArray(entry)) {
        add(entry[0], entry.length > 1 ? entry[1] : 1);
        continue;
      }
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const coding = record.coding ?? record.name ?? record.token ?? record.encoding;
        const q = record.q ?? record.quality ?? 1;
        add(coding, q);
      }
    }
    return { explicit, wildcard, order };
  }

  if (typeof input === 'object') {
    for (const [coding, q] of Object.entries(input)) add(coding, q);
  }
  return { explicit, wildcard, order };
}

/**
 * Effective q value of a coding.
 *
 * `identity` is acceptable by default (q=1) unless it is excluded explicitly
 * or through a `*;q=0` wildcard. Other codings are only acceptable when they
 * are named explicitly or matched by a wildcard with q>0.
 */
export function qualityFor(prefs: ParsedPreferences, coding: string): number {
  const name = coding.trim().toLowerCase();
  const explicit = prefs.explicit.get(name);
  if (explicit !== undefined) return explicit;
  if (name === 'identity') {
    return prefs.wildcard === 0 ? 0 : 1;
  }
  return prefs.wildcard ?? 0;
}

/** Candidate codings in configuration order, with `identity` appended if absent. */
export function candidateCodings(available: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const coding of available) {
    const name = coding.trim().toLowerCase();
    if (name.length > 0 && !candidates.includes(name)) candidates.push(name);
  }
  if (!candidates.includes('identity')) candidates.push('identity');
  return candidates;
}

export interface CodingChoice {
  coding: string;
  q: number;
  /** Position in the candidate list; lower wins a tie. */
  rank: number;
}

/**
 * Pick the acceptable coding with the highest q value. Ties are resolved by
 * configuration order. Returns `undefined` when every candidate has q=0.
 */
export function selectCoding(
  prefs: ParsedPreferences,
  available: readonly string[],
): CodingChoice | undefined {
  let best: CodingChoice | undefined;
  const candidates = candidateCodings(available);
  for (let rank = 0; rank < candidates.length; rank++) {
    const coding = candidates[rank]!;
    const q = qualityFor(prefs, coding);
    if (q <= 0) continue;
    if (best === undefined || q > best.q) {
      best = { coding, q, rank };
    }
  }
  return best;
}

function coerceQ(value: unknown, coding: string): number {
  if (value === undefined || value === null || value === '') return 1;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`invalid q value for encoding "${coding}": ${String(value)}`);
  }
  return clampQ(parsed);
}

function clampQ(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
