/**
 * Routing-key parsing and topic matching.
 *
 * Routing keys and topic patterns are dot-separated segments. In a topic
 * pattern:
 *   - `*` matches exactly one segment,
 *   - `#` matches zero or more segments,
 *   - every wildcard occupies a whole segment (no `or*ers` style globs).
 *
 * Consecutive `#` segments are allowed because they are expressible, but they
 * are matched with dynamic programming rather than recursive backtracking, so
 * repeated wildcards and criss-crossing keys stay polynomial.
 */

import { RouterError } from './types.ts';
import type { ParsedKey, ParsedPattern } from './types.ts';

/** Split a dotted routing key. The empty string is zero segments. */
export function parseRoutingKey(key: string): ParsedKey {
  if (typeof key !== 'string') {
    throw new RouterError('INVALID_ROUTING_KEY', 'routingKey must be a string');
  }
  if (key === '') {
    return { raw: key, segments: Object.freeze([]) };
  }
  const segments = key.split('.');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].length === 0) {
      throw new RouterError(
        'INVALID_ROUTING_KEY',
        `routingKey "${key}" contains an empty segment at index ${i}`,
      );
    }
  }
  return { raw: key, segments: Object.freeze(segments) };
}

/** Validate a literal (non-pattern) binding key such as a direct key. */
export function validateLiteralKey(key: string, context: string): string {
  if (typeof key !== 'string') {
    throw new RouterError('INVALID_TOPOLOGY', `${context}: routingKey must be a string`);
  }
  if (key === '') return key;
  const segments = key.split('.');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].length === 0) {
      throw new RouterError(
        'INVALID_TOPOLOGY',
        `${context}: binding key "${key}" contains an empty segment at index ${i}`,
      );
    }
  }
  return key;
}

/**
 * Validate and split a topic pattern. The empty pattern is zero segments and
 * therefore matches only the zero-segment routing key.
 */
export function parseTopicPattern(pattern: string, context = 'topic binding'): ParsedPattern {
  if (typeof pattern !== 'string') {
    throw new RouterError('INVALID_PATTERN', `${context}: pattern must be a string`);
  }
  if (pattern === '') {
    return { raw: pattern, segments: Object.freeze([]), wildcardCount: 0 };
  }
  const segments = pattern.split('.');
  let wildcardCount = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '#') {
      wildcardCount++;
      continue;
    }
    if (segment === '*') {
      wildcardCount++;
      continue;
    }
    if (segment.length === 0) {
      throw new RouterError(
        'INVALID_PATTERN',
        `${context}: pattern "${pattern}" contains an empty segment at index ${i}`,
      );
    }
    if (segment.includes('*') || segment.includes('#')) {
      throw new RouterError(
        'INVALID_PATTERN',
        `${context}: pattern "${pattern}" mixes a wildcard into segment "${segment}"`,
      );
    }
  }
  return { raw: pattern, segments: Object.freeze(segments), wildcardCount };
}

/**
 * Match a routing key against a topic pattern.
 *
 * `reachable[i][j]` means "the first i pattern segments can consume the first
 * j key segments". Each (i, j) state is computed at most once, giving
 * O(pattern.length * key.length) time and space — no exponential blow-up from
 * consecutive `#` segments or overlapping prefix/suffix structure.
 */
export function topicMatches(pattern: ParsedPattern, key: ParsedKey): boolean {
  const patternSegments = pattern.segments;
  const keySegments = key.segments;
  const rows = patternSegments.length + 1;
  const cols = keySegments.length + 1;
  const reachable: boolean[][] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    reachable[i] = new Array<boolean>(cols).fill(false);
  }
  reachable[0][0] = true;
  for (let i = 0; i < rows; i++) {
    const segment = i < patternSegments.length ? patternSegments[i] : undefined;
    for (let j = 0; j < cols; j++) {
      if (!reachable[i][j]) continue;
      if (segment === undefined) continue;
      if (segment === '#') {
        // Consume zero key segments and move past the wildcard.
        reachable[i + 1][j] = true;
        // Or stay on this wildcard and consume one more key segment.
        if (j < keySegments.length) reachable[i][j + 1] = true;
      } else if (segment === '*') {
        if (j < keySegments.length) reachable[i + 1][j + 1] = true;
      } else if (j < keySegments.length && segment === keySegments[j]) {
        reachable[i + 1][j + 1] = true;
      }
    }
  }
  return reachable[patternSegments.length][keySegments.length];
}
