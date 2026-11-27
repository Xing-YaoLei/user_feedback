/**
 * Case-insensitive HTTP header collection with support for repeated header
 * lines and list-valued fields.
 *
 * The module accepts the shapes a gateway usually has at hand:
 *   - a plain record (`IncomingHttpHeaders`-like),
 *   - an iterable of `[name, value]` pairs (including `Headers` and `Map`),
 *   - a `forEach(value, key)` object such as the web `Headers` class,
 *   - another `ResponseHeaders`.
 *
 * Output keeps the spelling of the first occurrence of a header so the caller
 * can hand it straight back to Node's HTTP server.
 */

export type HeaderValue = string | number | readonly string[] | undefined | null;

export type HeaderRecord = Record<string, HeaderValue>;

export interface HeaderLike {
  forEach(callback: (value: string, key: string) => void): void;
}

export type HeaderInput = HeaderRecord | Iterable<readonly [string, string]> | HeaderLike;

interface StoredHeader {
  /** Original spelling of the first occurrence, e.g. `ETag`. */
  name: string;
  /** One entry per header line. */
  values: string[];
}

export class ResponseHeaders {
  #entries = new Map<string, StoredHeader>();

  static from(input?: HeaderInput | ResponseHeaders | null): ResponseHeaders {
    const result = new ResponseHeaders();
    if (input === undefined || input === null) return result;
    if (input instanceof ResponseHeaders) return input.clone();

    if (Array.isArray(input)) {
      appendPairs(result, input as readonly (readonly [string, string])[]);
      return result;
    }

    if (typeof (input as Iterable<readonly [string, string]>)[Symbol.iterator] === 'function') {
      appendPairs(result, input as Iterable<readonly [string, string]>);
      return result;
    }

    if (typeof (input as HeaderLike).forEach === 'function') {
      (input as HeaderLike).forEach((value, key) => {
        if (value !== undefined && value !== null) result.append(key, String(value));
      });
      return result;
    }

    for (const [name, value] of Object.entries(input as HeaderRecord)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) result.append(name, String(item));
      } else {
        result.append(name, String(value));
      }
    }
    return result;
  }

  clone(): ResponseHeaders {
    const copy = new ResponseHeaders();
    for (const [key, stored] of this.#entries) {
      copy.#entries.set(key, { name: stored.name, values: [...stored.values] });
    }
    return copy;
  }

  has(name: string): boolean {
    return this.#entries.has(normalizeName(name));
  }

  /** All header lines for `name`, in insertion order. */
  values(name: string): string[] {
    return [...(this.#entries.get(normalizeName(name))?.values ?? [])];
  }

  /** Comma-joined value, or `undefined` when the header is absent. */
  get(name: string): string | undefined {
    const stored = this.#entries.get(normalizeName(name));
    if (!stored || stored.values.length === 0) return undefined;
    return stored.values.join(', ');
  }

  /**
   * Comma-separated token list across all header lines. Empty tokens are
   * dropped. Used for list-valued fields such as `Vary` and
   * `Content-Encoding`.
   */
  getList(name: string): string[] {
    const tokens: string[] = [];
    for (const value of this.values(name)) {
      for (const token of value.split(',')) {
        const trimmed = token.trim();
        if (trimmed.length > 0) tokens.push(trimmed);
      }
    }
    return tokens;
  }

  append(name: string, value: string): void {
    const key = normalizeName(name);
    if (key.length === 0) return;
    const stored = this.#entries.get(key);
    if (stored) {
      stored.values.push(value);
    } else {
      this.#entries.set(key, { name: name.trim(), values: [value] });
    }
  }

  set(name: string, value: string): void {
    const key = normalizeName(name);
    if (key.length === 0) return;
    const existing = this.#entries.get(key);
    if (existing) {
      existing.values = [value];
    } else {
      this.#entries.set(key, { name: name.trim(), values: [value] });
    }
  }

  /** Rewrites every header line for `name` with `mapper`. */
  transformValues(name: string, mapper: (value: string) => string): void {
    const stored = this.#entries.get(normalizeName(name));
    if (!stored) return;
    stored.values = stored.values.map(mapper);
  }

  delete(name: string): void {
    this.#entries.delete(normalizeName(name));
  }

  /**
   * Ensure `Vary` contains `Accept-Encoding`.
   *
   * - `Vary: *` stays exactly `*` (adding a field name would be redundant).
   * - Existing tokens keep their order and spelling.
   * - The header is appended when it was absent.
   */
  mergeVary(fieldName = 'Accept-Encoding'): void {
    const tokens = this.getList('vary');
    if (tokens.some((token) => token === '*')) {
      this.set('Vary', '*');
      return;
    }
    const seen = new Set(tokens.map((token) => token.toLowerCase()));
    if (!seen.has(fieldName.toLowerCase())) {
      tokens.push(fieldName);
    }
    this.set('Vary', tokens.join(', '));
  }

  /** Plain lower-case record, suitable for Node's HTTP layer. */
  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, stored] of this.#entries) {
      out[key] = stored.values.join(', ');
    }
    return out;
  }

  /** Header lines as `[name, value]` tuples using the original spelling. */
  entries(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const stored of this.#entries.values()) {
      for (const value of stored.values) out.push([stored.name, value]);
    }
    return out;
  }
}

function appendPairs(
  target: ResponseHeaders,
  pairs: Iterable<readonly [string, string]>,
): void {
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const value = pair[1];
    if (value !== undefined && value !== null) {
      target.append(String(pair[0]), String(value));
    }
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * A response whose body bytes changed needs a validator that changes too.
 * A strong ETag becomes weak; an already-weak ETag (or `*`) stays as-is.
 */
export function weakenEtag(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  if (trimmed === '*') return trimmed;
  if (/^w\//i.test(trimmed)) return trimmed;
  return `W/${trimmed}`;
}
