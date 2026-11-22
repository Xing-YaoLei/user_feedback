/**
 * Runtime matching: decode the input path once and find the highest-priority
 * rule whose parameter language accepts every decoded segment.
 */
import { decodePath } from './encoding.ts';
import { member } from './segments.ts';
import type {
  CompiledRule,
  MatchResult,
  RouteParams,
  RuleVariant,
} from './types.ts';

export interface CompiledRouter {
  rules: CompiledRule[];
  match(rawPath: string): MatchResult | null;
}

export function createRouter(rules: readonly CompiledRule[]): CompiledRouter {
  // Defensive copy, already sorted by compiler (priority desc, id asc).
  const sorted = [...rules].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  return {
    rules: sorted,
    match(rawPath: string): MatchResult | null {
      return matchPath(sorted, rawPath);
    },
  };
}

export function matchPath(
  rules: readonly CompiledRule[],
  rawPath: string,
): MatchResult | null {
  const segments = decodePath(rawPath);
  for (const rule of rules) {
    for (const variant of rule.variants) {
      const params = tryVariant(variant, segments);
      if (params !== null) {
        return {
          ruleId: rule.id,
          template: rule.template,
          priority: rule.priority,
          params,
        };
      }
    }
  }
  return null;
}

function tryVariant(
  variant: RuleVariant,
  segments: readonly string[],
): RouteParams | null {
  const { language, binder, tailName, tailStart } = variant;

  if (tailName === null) {
    if (segments.length !== language.length) return null;
  } else if (segments.length < tailStart) {
    return null;
  }

  const params: RouteParams = {};
  for (let i = 0; i < language.length; i++) {
    if (tailName !== null && i === tailStart) {
      const tail = segments.slice(tailStart);
      // Tail positions all use the same (any) language; non-empty ensured
      // by decodePath. Keep segment boundaries intact.
      params[tailName] = tail;
      break;
    }
    const segment = segments[i];
    if (segment === undefined || !member(language[i], segment)) return null;
    const name = binder[i];
    if (name !== null) {
      params[name] = language[i].kind === 'int' ? Number(segment) : segment;
    }
  }
  return params;
}
