/**
 * Subscription list validation.
 *
 * Expressions are compiled immediately into an internal graph; the caller's
 * expression objects are never retained. Mutation of the caller's objects
 * after registration therefore cannot change routing behaviour, and we avoid
 * deep-cloning (which would expand shared subexpressions into trees).
 */

import type { Subscription } from "./types.ts";

export const normalizeSubscriptions = (subscriptions: readonly Subscription[]): Subscription[] => {
  if (!Array.isArray(subscriptions)) throw new TypeError("subscriptions must be an array");
  const seen = new Set<string>();
  const normalized: Subscription[] = [];
  for (const subscription of subscriptions) {
    if (subscription === null || typeof subscription !== "object") {
      throw new TypeError("each subscription must be an object");
    }
    const { id, expr } = subscription;
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("subscription id must be a non-empty string");
    }
    if (seen.has(id)) throw new TypeError(`duplicate subscription id ${JSON.stringify(id)}`);
    seen.add(id);
    if (expr === null || typeof expr !== "object") {
      throw new TypeError(`subscription ${JSON.stringify(id)} is missing an expression`);
    }
    normalized.push({ id, expr });
  }
  return normalized;
};
