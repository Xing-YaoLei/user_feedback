/**
 * Core data model: segment languages, parsed templates and analysis reports.
 */

/** Language of a single (already decoded) path segment. */
export type SegmentLanguage =
  | { kind: 'lit'; value: string }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'chars'; chars: string; minLength: number; maxLength: number }
  | { kind: 'any' }
  | {
      kind: 'minus';
      base: SegmentLanguage;
      exclusions: readonly SegmentLanguage[];
    };

/** A parsed element of a template (one slash-separated unit, optional flag). */
export interface TemplateElement {
  optional: boolean;
  body:
    | { kind: 'lit'; value: string }
    | {
        kind: 'param';
        name: string;
        language: SegmentLanguage;
        paramKind: 'int' | 'chars';
      }
    | {
        kind: 'tail';
        name: string;
        language: SegmentLanguage;
      };
}

export interface ParsedTemplate {
  template: string;
  elements: TemplateElement[];
  /** Names appearing in the template, in declaration order. */
  paramNames: string[];
}

export interface RouteRuleInput {
  id: string;
  template: string;
  /** Higher value = higher priority. */
  priority: number;
}

export type ParamValue = string | number;
export type RouteParams = Record<string, ParamValue | string[]>;

/**
 * One concrete expansion of a template (optionals resolved).
 * `language[i]` corresponds to `binder[i]`; a binder of null means a literal.
 */
export interface RuleVariant {
  language: SegmentLanguage[];
  /** parameter name bound at this position, or null for a literal */
  binder: (string | null)[];
  /** tail parameter name when this expansion carries the tail */
  tailName: string | null;
  /** index of the first tail position (=== language.length when no tail) */
  tailStart: number;
}

export interface CompiledRule {
  id: string;
  template: string;
  priority: number;
  parsed: ParsedTemplate;
  variants: RuleVariant[];
}

export interface BindingPair {
  name: string;
  valueA: string | number | string[];
  valueB: string | number | string[];
}

/** Same-priority overlap witness between two different rules. */
export interface ConflictReport {
  type: 'conflict';
  ruleA: string;
  ruleB: string;
  /** canonical path (leading slash, percent encoded) of a witness path */
  path: string;
  bindingsA: RouteParams;
  bindingsB: RouteParams;
}

/** One template binding the same concrete path in two different ways. */
export interface AmbiguityReport {
  type: 'ambiguity';
  ruleId: string;
  path: string;
  bindingA: RouteParams;
  bindingB: RouteParams;
  differences: BindingPair[];
}

export interface ShadowReport {
  type: 'shadow';
  /** rule that can never win a match */
  shadowedRule: string;
  /** higher-priority rules whose joint coverage hides it */
  coveringRules: string[];
  /** a concrete path of the shadowed rule, plus the rule that takes it */
  witness: { path: string; hitRule: string };
}

export type CompileIssue = ConflictReport | AmbiguityReport | ShadowReport;

export interface CompileSuccess {
  ok: true;
  rules: CompiledRule[];
  /** fully hidden rules; compilation itself still succeeds */
  shadows: ShadowReport[];
}

export interface CompileFailure {
  ok: false;
  /** fatal issues (conflicts / ambiguities), deterministically ordered */
  issues: Exclude<CompileIssue, ShadowReport>[];
}

export type CompileResult = CompileSuccess | CompileFailure;

export interface MatchResult {
  ruleId: string;
  template: string;
  priority: number;
  params: RouteParams;
}

export interface ReverseResult {
  ruleId: string;
  path: string;
  /**
   * When another rule takes the generated path, its identity is reported here
   * together with the bindings it observes.
   */
  interceptedBy: MatchResult | null;
}
