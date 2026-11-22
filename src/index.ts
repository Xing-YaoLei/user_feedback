/**
 * Route template compiler — public entry point.
 *
 * Typical flow:
 *
 *   const result = compileRules([
 *     { id: 'article', template: '/a/{id:int[1..99999]}', priority: 10 },
 *   ]);
 *   if (!result.ok) {
 *     // result.issues: conflicts / ambiguities with concrete witness paths
 *     throw new Error(JSON.stringify(result.issues, null, 2));
 *   }
 *   const router = createRouter(result.rules);
 *   router.match('/a/42');
 *   reverse(router, 'article', { id: 42 });
 */
export { compileRules, buildVariants, stableStringify } from './compiler.ts';
export { analyzeShadow } from './compiler.ts';
export { parseTemplate } from './parser.ts';
export { createRouter, matchPath } from './matcher.ts';
export type { CompiledRouter } from './matcher.ts';
export { reverse } from './reverse.ts';
export {
  decodePath,
  decodeSegment,
  encodePath,
  encodeSegment,
} from './encoding.ts';
export {
  intersectWitness,
  canonicalWitness,
  subtract,
  member,
  contains,
  ENUM_CAP,
} from './segments.ts';
export {
  RouteError,
  TemplateParseError,
  EncodingError,
  RouteValidationError,
  DecidabilityLimitError,
} from './errors.ts';
export type {
  AmbiguityReport,
  BindingPair,
  CompileIssue,
  CompiledRule,
  CompileFailure,
  CompileResult,
  CompileSuccess,
  ConflictReport,
  MatchResult,
  ParamValue,
  ParsedTemplate,
  ReverseResult,
  RouteParams,
  RouteRuleInput,
  RuleVariant,
  SegmentLanguage,
  ShadowReport,
  TemplateElement,
} from './types.ts';
