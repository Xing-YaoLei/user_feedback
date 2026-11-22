/**
 * Reverse generation: given a rule id and parameters, validate types, ranges
 * and optional/tail usage, emit a canonical encoded path, then re-match it to
 * prove the round trip and to detect interception by a higher-priority rule.
 */
import { encodePath } from './encoding.ts';
import { RouteValidationError } from './errors.ts';
import { member } from './segments.ts';
import { matchPath } from './matcher.ts';
import type { CompiledRouter } from './matcher.ts';
import type {
  CompiledRule,
  ReverseResult,
  RouteParams,
  RuleVariant,
  SegmentLanguage,
} from './types.ts';

export function reverse(
  router: CompiledRouter,
  ruleId: string,
  params: RouteParams = {},
): ReverseResult {
  const rule = router.rules.find((r) => r.id === ruleId);
  if (rule === undefined) {
    throw new RouteValidationError(
      `unknown route id "${ruleId}"`,
      'UNKNOWN_ROUTE',
      `route ${ruleId}`,
    );
  }

  validateKnownNames(rule, params);
  const variant = selectVariant(rule, params);
  const segments = buildSegments(rule, variant, params);
  const path = encodePath(segments);

  const hit = matchPath(router.rules, path);
  if (hit === null) {
    throw new Error(
      `internal error: reverse-generated path "${path}" did not match any rule`,
    );
  }

  if (hit.ruleId === rule.id) {
    return { ruleId, path, interceptedBy: null };
  }
  return { ruleId, path, interceptedBy: hit };
}

/* ------------------------------------------------------------------ */

function selectVariant(rule: CompiledRule, params: RouteParams): RuleVariant {
  const candidates = rule.variants.filter((v) => {
    for (const el of rule.parsed.elements) {
      if (!el.optional || el.body.kind === 'lit' || el.body.kind === 'tail') {
        continue;
      }
      const name = el.body.name;
      const presentInVariant = v.binder.includes(name);
      const supplied = params[name] !== undefined;
      if (presentInVariant !== supplied) return false;
    }
    return true;
  });
  if (candidates.length === 0) {
    throw new RouteValidationError(
      `parameters do not satisfy any expansion of "${rule.id}" (check optional parameters)`,
      'NO_VARIANT',
      `route ${rule.id}`,
    );
  }
  return candidates[0];
}

function buildSegments(
  rule: CompiledRule,
  variant: RuleVariant,
  params: RouteParams,
): string[] {
  const segments: string[] = [];

  for (const el of rule.parsed.elements) {
    if (el.body.kind === 'tail') {
      const value = params[el.body.name];
      if (value === undefined) continue; // zero tail segments
      if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
        throw new RouteValidationError(
          `tail parameter "${el.body.name}" must be an array of strings`,
          'BAD_TAIL_TYPE',
          `route ${rule.id}, param ${el.body.name}`,
        );
      }
      for (const seg of value) {
        if (seg.length === 0) {
          throw new RouteValidationError(
            `tail parameter "${el.body.name}" contains an empty segment`,
            'EMPTY_TAIL_SEGMENT',
            `route ${rule.id}, param ${el.body.name}`,
          );
        }
        if (!member(el.body.language, seg)) {
          throw new RouteValidationError(
            `tail segment "${seg}" is not in the tail language of "${el.body.name}"`,
            'TAIL_OUT_OF_LANGUAGE',
            `route ${rule.id}, param ${el.body.name}`,
          );
        }
        segments.push(seg);
      }
      continue;
    }

    if (el.body.kind === 'lit') {
      segments.push(el.body.value);
      continue;
    }

    const name = el.body.name;
    const included = variant.binder.includes(name);
    if (!included) {
      if (params[name] !== undefined) {
        throw new RouteValidationError(
          `optional parameter "${name}" supplied but its segment is not part of the chosen expansion`,
          'UNEXPECTED_OPTIONAL',
          `route ${rule.id}, param ${name}`,
        );
      }
      continue;
    }
    const given = params[name];
    if (given === undefined) {
      throw new RouteValidationError(
        `missing required parameter "${name}"`,
        'MISSING_PARAMETER',
        `route ${rule.id}, param ${name}`,
      );
    }
    segments.push(coerceAndCheck(rule.id, name, el.body.language, given));
  }

  return segments;
}

function validateKnownNames(rule: CompiledRule, params: RouteParams): void {
  const known = new Set(rule.parsed.paramNames);
  for (const key of Object.keys(params)) {
    if (!known.has(key)) {
      throw new RouteValidationError(
        `unknown parameter "${key}" for route "${rule.id}"`,
        'UNKNOWN_PARAMETER',
        `route ${rule.id}, param ${key}`,
      );
    }
  }
}

function coerceAndCheck(
  ruleId: string,
  name: string,
  language: SegmentLanguage,
  value: string | number | string[],
): string {
  const loc = `route ${ruleId}, param ${name}`;
  if (language.kind === 'int') {
    let n: number;
    if (typeof value === 'number') {
      n = value;
    } else if (typeof value === 'string' && /^-?\d+$/.test(value)) {
      n = Number(value);
    } else {
      throw new RouteValidationError(
        `parameter "${name}" must be an integer, got ${describe(value)}`,
        'BAD_INT_TYPE',
        loc,
      );
    }
    if (!Number.isSafeInteger(n)) {
      throw new RouteValidationError(
        `parameter "${name}" is not a safe integer`,
        'UNSAFE_INTEGER',
        loc,
      );
    }
    if (n < language.min || n > language.max) {
      throw new RouteValidationError(
        `parameter "${name}"=${n} outside range [${language.min}, ${language.max}]`,
        'INT_OUT_OF_RANGE',
        loc,
      );
    }
    return String(n);
  }

  if (typeof value !== 'string') {
    throw new RouteValidationError(
      `parameter "${name}" must be a string, got ${describe(value)}`,
      'BAD_STRING_TYPE',
      loc,
    );
  }
  if (!member(language, value)) {
    throw new RouteValidationError(
      `parameter "${name}"="${value}" does not satisfy its character/length constraint`,
      'STRING_OUT_OF_LANGUAGE',
      loc,
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
