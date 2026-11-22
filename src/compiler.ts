/**
 * Compilation: variant expansion, in-template ambiguity detection,
 * same-priority language intersection (conflict witnesses) and exact
 * joint-shadow analysis against higher-priority rule sets.
 */
import { encodePath } from './encoding.ts';
import { parseTemplate } from './parser.ts';
import {
  ANY,
  canonicalWitness,
  enumerate,
  intersectWitness,
  isEmpty,
  member,
  subtract,
} from './segments.ts';
import type {
  AmbiguityReport,
  CompiledRule,
  CompileFailure,
  CompileResult,
  CompileSuccess,
  ConflictReport,
  RouteParams,
  RouteRuleInput,
  RuleVariant,
  SegmentLanguage,
  ShadowReport,
  TemplateElement,
} from './types.ts';

/* ------------------------------------------------------------------ */
/* Variant expansion                                                   */
/* ------------------------------------------------------------------ */

export function buildVariants(elements: readonly TemplateElement[]): RuleVariant[] {
  const variants: RuleVariant[] = [];

  const rec = (
    idx: number,
    language: SegmentLanguage[],
    binder: (string | null)[],
    tailName: string | null,
    tailStart: number,
  ): void => {
    if (idx === elements.length) {
      variants.push({ language, binder, tailName, tailStart });
      return;
    }
    const el = elements[idx];

    if (el.optional) {
      // skip this optional segment
      rec(idx + 1, language, binder, tailName, tailStart);
    }
    if (el.body.kind === 'lit') {
      rec(
        idx + 1,
        [...language, { kind: 'lit', value: el.body.value }],
        [...binder, null],
        tailName,
        tailStart,
      );
    } else if (el.body.kind === 'param') {
      rec(
        idx + 1,
        [...language, el.body.language],
        [...binder, el.body.name],
        tailName,
        tailStart,
      );
    } else {
      // tail starts here; it is the final element
      const pos = language.length;
      rec(
        idx + 1,
        [...language, ANY],
        [...binder, el.body.name],
        el.body.name,
        pos,
      );
    }
  };

  rec(0, [], [], null, 0);
  return variants;
}

/* ------------------------------------------------------------------ */
/* Binding construction for concrete witness segments                  */
/* ------------------------------------------------------------------ */

function buildBindings(
  variant: RuleVariant,
  segments: readonly string[],
  namesOrder: readonly string[],
): RouteParams {
  const params: RouteParams = {};
  for (let i = 0; i < variant.language.length; i++) {
    const name = variant.binder[i];
    if (name === null) continue;
    if (variant.tailName !== null && i === variant.tailStart) {
      params[name] = segments.slice(variant.tailStart);
      break;
    }
    const lang = variant.language[i];
    params[name] = lang.kind === 'int' ? Number(segments[i]) : segments[i];
  }
  // Ensure deterministic key order in output.
  const sorted: RouteParams = {};
  for (const name of namesOrder) if (name in params) sorted[name] = params[name];
  return sorted;
}

/* ------------------------------------------------------------------ */
/* Ambiguity: one template binding the same concrete path two ways     */
/* ------------------------------------------------------------------ */

function detectAmbiguity(rule: CompiledRule): AmbiguityReport | null {
  const { variants, parsed } = rule;
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const witness = variantIntersectionWitness(variants[i], variants[j]);
      if (witness === null) continue;
      const bindingA = buildBindings(variants[i], witness, parsed.paramNames);
      const bindingB = buildBindings(variants[j], witness, parsed.paramNames);
      if (stableStringify(bindingA) === stableStringify(bindingB)) continue;
      return {
        type: 'ambiguity',
        ruleId: rule.id,
        path: encodePath(witness),
        bindingA,
        bindingB,
        differences: bindingDifferences(bindingA, bindingB, parsed.paramNames),
      };
    }
  }
  return null;
}

function bindingDifferences(
  a: RouteParams,
  b: RouteParams,
  order: readonly string[],
): AmbiguityReport['differences'] {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: AmbiguityReport['differences'] = [];
  for (const name of order) {
    if (!names.has(name)) continue;
    if (stableStringify(a[name]) !== stableStringify(b[name])) {
      diffs.push({
        name,
        valueA: a[name] as string | number | string[],
        valueB: b[name] as string | number | string[],
      });
    }
  }
  return diffs;
}

/**
 * Concrete segment list belonging to both variant languages, or null.
 * Tail variants absorb extra positions; the shared witness is built from
 * the longest required prefix.
 */
function variantIntersectionWitness(
  a: RuleVariant,
  b: RuleVariant,
): string[] | null {
  const minLen = Math.max(a.language.length, b.language.length);
  const prefix: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const langA = variantLangAt(a, i);
    const langB = variantLangAt(b, i);
    if (langA === null || langB === null) return null;
    const w = intersectWitness(langA, langB);
    if (w === null) return null;
    prefix.push(w);
  }
  return prefix;
}

function variantLangAt(v: RuleVariant, i: number): SegmentLanguage | null {
  if (i < v.language.length) return v.language[i];
  return v.tailName !== null ? ANY : null;
}

/* ------------------------------------------------------------------ */
/* Conflicts: same-priority rules with intersecting languages          */
/* ------------------------------------------------------------------ */

function detectConflict(a: CompiledRule, b: CompiledRule): ConflictReport | null {
  for (const va of a.variants) {
    for (const vb of b.variants) {
      const witness = variantIntersectionWitness(va, vb);
      if (witness === null) continue;
      return {
        type: 'conflict',
        ruleA: a.id,
        ruleB: b.id,
        path: encodePath(witness),
        bindingsA: buildBindings(va, witness, a.parsed.paramNames),
        bindingsB: buildBindings(vb, witness, b.parsed.paramNames),
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Shadow analysis: exact joint coverage by higher-priority rules      */
/* ------------------------------------------------------------------ */

interface Cylinder {
  ruleId: string;
  variant: RuleVariant;
}

/**
 * Is every path of `target` matched by at least one `higher` cylinder?
 * Returns witness info either way.
 *
 * The check is exact over the whole parameter language: at each position the
 * target segment language is partitioned by every higher-priority cylinder
 * language using exact set difference. A surviving residual means an
 * uncovered path exists; otherwise recursion continues on each partition
 * boundary (tails absorb the remaining positions).
 */
export function analyzeShadow(
  target: CompiledRule,
  higher: readonly CompiledRule[],
): { shadowed: boolean; coveringRules: string[]; witnessPath: string; hitRule: string | null } {
  const cylinders: Cylinder[] = higher.flatMap((r) =>
    r.variants.map((variant) => ({ ruleId: r.id, variant })),
  );

  // Concrete lengths the target can require.
  const targetLengths = new Set<number>();
  let targetHasTail = false;
  let maxTarget = 0;
  for (const v of target.variants) {
    targetLengths.add(v.language.length);
    maxTarget = Math.max(maxTarget, v.language.length);
    if (v.tailName !== null) targetHasTail = true;
  }
  const candidateLengths = new Set<number>(targetLengths);
  if (targetHasTail) {
    candidateLengths.add(maxTarget + 1);
    candidateLengths.add(maxTarget + 2);
  }

  for (const L of [...candidateLengths].sort((x, y) => x - y)) {
    const targetEntries = target.variants.filter(
      (v) => v.language.length <= L && (v.tailName !== null || v.language.length === L),
    );
    for (const variant of targetEntries) {
      const targetLangs: SegmentLanguage[] = [];
      for (let i = 0; i < L; i++) {
        targetLangs.push(i < variant.language.length ? variant.language[i] : ANY);
      }
      const result = coverAt(targetLangs, 0, cylinders, []);
      if (!result.covered) {
        return {
          shadowed: false,
          coveringRules: [],
          witnessPath: encodePath(result.uncoveredSegments),
          hitRule: null,
        };
      }
    }
  }

  // Fully shadowed: pick the shortest target path and report who takes it.
  const shortestL = [...candidateLengths].sort((x, y) => x - y)[0];
  const variant = target.variants
    .filter((v) => v.language.length <= shortestL)
    .sort((x, y) => x.language.length - y.language.length)[0];
  const segments: string[] = [];
  const covering = new Set<string>();
  let hitRule: string | null = null;
  let active: Cylinder[] = cylinders;
  for (let i = 0; i < shortestL; i++) {
    const lang = i < variant.language.length ? variant.language[i] : ANY;
    const segment = canonicalWitness(lang);
    segments.push(segment);
    // Every cylinder whose prefix still matches contributes to coverage.
    active = active.filter(
      (c) =>
        i < c.variant.language.length && member(c.variant.language[i], segment),
    );
    for (const c of active) covering.add(c.ruleId);
    const absorbing = active.find(
      (c) => c.variant.tailName !== null && i + 1 === c.variant.language.length,
    );
    if (absorbing) {
      hitRule = absorbing.ruleId;
      break;
    }
  }
  if (hitRule === null && active.length > 0) hitRule = active[0].ruleId;
  if (hitRule === null && cylinders.length > 0) hitRule = cylinders[0].ruleId;

  return {
    shadowed: true,
    coveringRules: [...covering].sort(),
    witnessPath: encodePath(segments),
    hitRule,
  };
}

interface CoverResult {
  covered: boolean;
  uncoveredSegments: string[];
}

function coverAt(
  targetLangs: SegmentLanguage[],
  pos: number,
  cylinders: readonly Cylinder[],
  prefix: string[],
): CoverResult {
  if (pos === targetLangs.length) {
    return { covered: true, uncoveredSegments: prefix };
  }

  const active = cylinders.filter(
    (c) =>
      pos < c.variant.language.length &&
      intersectWitness(c.variant.language[pos], targetLangs[pos]) !== null,
  );
  if (active.length === 0) {
    return {
      covered: false,
      uncoveredSegments: [...prefix, canonicalWitness(targetLangs[pos])],
    };
  }

  // A tail cylinder whose tail begins here absorbs every remaining segment.
  const absorbing = active.find(
    (c) => c.variant.tailName !== null && pos + 1 === c.variant.language.length,
  );
  if (absorbing) return { covered: true, uncoveredSegments: prefix };

  // Exact partition: any surviving residual is an immediately uncovered path.
  let pieces: SegmentLanguage[] = [targetLangs[pos]];
  for (const c of active) {
    const next: SegmentLanguage[] = [];
    for (const piece of pieces) next.push(...subtract(piece, c.variant.language[pos]));
    pieces = next.filter((p) => !isEmpty(p));
  }
  if (pieces.length > 0) {
    return {
      covered: false,
      uncoveredSegments: [...prefix, canonicalWitness(pieces[0])],
    };
  }

  // This position is fully covered by the active cylinders. Continue every
  // concrete element so continuation coverage is checked per prefix.
  return coverContinuations(targetLangs, pos, active, prefix);
}

/**
 * Enumerate concrete elements of the current target segment language and
 * recurse on each prefix, so continuation coverage is checked exactly.
 */
function coverContinuations(
  targetLangs: SegmentLanguage[],
  pos: number,
  active: readonly Cylinder[],
  prefix: string[],
): CoverResult {
  for (const segment of concreteElements(targetLangs[pos])) {
    const matching = active.filter((c) => member(c.variant.language[pos], segment));
    const absorbing = matching.find(
      (c) => c.variant.tailName !== null && pos + 1 === c.variant.language.length,
    );
    if (absorbing) continue;
    if (pos + 1 === targetLangs.length) {
      // Last position: any matching cylinder covers this concrete path.
      continue;
    }
    const continued = matching.filter((c) => pos + 1 < c.variant.language.length);
    const rec = coverAt(targetLangs, pos + 1, continued, [...prefix, segment]);
    if (!rec.covered) return rec;
  }
  return { covered: true, uncoveredSegments: prefix };
}

function concreteElements(lang: SegmentLanguage): string[] {
  switch (lang.kind) {
    case 'lit':
      return [lang.value];
    case 'any':
      return ['a'];
    case 'minus': {
      const out: string[] = [];
      for (const s of concreteElements(lang.base)) {
        if (!lang.exclusions.some((e) => member(e, s))) out.push(s);
      }
      return out;
    }
    default:
      return [...enumerate(lang)];
  }
}
/* ------------------------------------------------------------------ */
/* Compile entry point                                                 */
/* ------------------------------------------------------------------ */

export function compileRules(input: readonly RouteRuleInput[]): CompileResult {
  const ids = new Set<string>();
  const rules: CompiledRule[] = input.map((r) => {
    if (ids.has(r.id)) {
      throw new Error(`duplicate route id "${r.id}"`);
    }
    ids.add(r.id);
    if (!Number.isSafeInteger(r.priority)) {
      throw new Error(`priority of rule "${r.id}" must be a safe integer`);
    }
    const parsed = parseTemplate(r.template);
    return {
      id: r.id,
      template: r.template,
      priority: r.priority,
      parsed,
      variants: buildVariants(parsed.elements),
    };
  });

  const fatal: Array<ConflictReport | AmbiguityReport> = [];

  // 1. In-template ambiguities (order independent: iterate sorted ids).
  const byId = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  for (const rule of byId) {
    const ambiguity = detectAmbiguity(rule);
    if (ambiguity) fatal.push(ambiguity);
  }

  // 2. Same-priority conflicts.
  const priorityGroups = new Map<number, CompiledRule[]>();
  for (const rule of byId) {
    const group = priorityGroups.get(rule.priority) ?? [];
    group.push(rule);
    priorityGroups.set(rule.priority, group);
  }
  for (const group of priorityGroups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const conflict = detectConflict(group[i], group[j]);
        if (conflict) fatal.push(conflict);
      }
    }
  }

  if (fatal.length > 0) {
    const failure: CompileFailure = {
      ok: false,
      issues: fatal.sort(compareIssues),
    };
    return failure;
  }

  // 3. Shadow analysis against strictly higher priorities.
  const sorted = [...rules].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  const shadows: ShadowReport[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const higher = sorted.slice(0, i);
    if (higher.length === 0) continue;
    const result = analyzeShadow(sorted[i], higher);
    if (result.shadowed && result.hitRule !== null) {
      shadows.push({
        type: 'shadow',
        shadowedRule: sorted[i].id,
        coveringRules: result.coveringRules,
        witness: { path: result.witnessPath, hitRule: result.hitRule },
      });
    }
  }

  const success: CompileSuccess = {
    ok: true,
    rules: sorted,
    shadows: shadows.sort((a, b) => a.shadowedRule.localeCompare(b.shadowedRule)),
  };
  return success;
}

function compareIssues(
  a: ConflictReport | AmbiguityReport,
  b: ConflictReport | AmbiguityReport,
): number {
  const ka = a.type === 'conflict' ? `${a.ruleA}|${a.ruleB}` : a.ruleId;
  const kb = b.type === 'conflict' ? `${b.ruleA}|${b.ruleB}` : b.ruleId;
  if (ka !== kb) return ka.localeCompare(kb);
  return a.path.localeCompare(b.path);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
