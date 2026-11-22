/**
 * Template parser.
 *
 * Syntax (slash separated units; an optional unit carries a trailing "?"):
 *
 *   literal segment          plain text without "{" "}" (escape with \)
 *   {name:int[min..max]}     integer parameter with inclusive range
 *   {name:charset}           character set parameter, e.g. {tag:[a-z0-9]}
 *   {name:charset{len}}      length constraint, e.g. {id:[0-9]{3..5}}
 *   {*name:charset}          tail capture: zero or more trailing segments
 *
 * Character set items: literal char, "a-z" range, \- \] \\ escapes.
 */
import { TemplateParseError } from './errors.ts';
import type { ParsedTemplate, SegmentLanguage, TemplateElement } from './types.ts';

export function parseTemplate(template: string): ParsedTemplate {
  if (typeof template !== 'string' || template.length === 0) {
    throw new TemplateParseError('template must be a non-empty string', 'EMPTY_TEMPLATE', 'template');
  }
  if (template[0] !== '/') {
    throw new TemplateParseError(
      'template must start with "/"',
      'MISSING_LEADING_SLASH',
      `template "${template}"`,
    );
  }

  const elements: TemplateElement[] = [];
  const paramNames: string[] = [];
  const seenNames = new Set<string>();
  const rawUnits = template === '/' ? [] : template.slice(1).split('/');

  let tailSeen = false;

  for (let idx = 0; idx < rawUnits.length; idx++) {
    const unit = rawUnits[idx];
    const loc = `segment ${idx} of "${template}"`;
    if (unit.length === 0) {
      throw new TemplateParseError('empty template segment', 'EMPTY_SEGMENT', loc);
    }

    let body = unit;
    let optional = false;
    if (body.endsWith('?')) {
      optional = true;
      body = body.slice(0, -1);
      if (body.length === 0) {
        throw new TemplateParseError('dangling optional marker "?"', 'DANGLING_OPTIONAL', loc);
      }
    }

    let element: TemplateElement;
    if (body.startsWith('{*') && hasMatchingOuterBraces(body)) {
      if (optional) {
        throw new TemplateParseError(
          'tail capture is already implicitly optional and cannot be marked "?"',
          'OPTIONAL_TAIL',
          loc,
        );
      }
      const parsed = parseTail(body.slice(2, -1), loc, seenNames, paramNames);
      element = { optional: false, body: parsed };
      tailSeen = true;
    } else if (body.startsWith('{') && hasMatchingOuterBraces(body)) {
      const parsed = parseParam(body.slice(1, -1), loc, seenNames, paramNames);
      element = { optional, body: parsed };
    } else if (body.includes('{') || body.includes('}')) {
      throw new TemplateParseError(
        'unescaped "{" / "}" in literal segment',
        'UNESCAPED_BRACE',
        loc,
      );
    } else {
      element = { optional, body: { kind: 'lit', value: parseLiteral(body, loc) } };
    }

    if (tailSeen && idx !== rawUnits.length - 1) {
      throw new TemplateParseError(
        'tail capture must be the final segment',
        'TAIL_NOT_LAST',
        loc,
      );
    }
    elements.push(element);
  }

  return { template, elements, paramNames };
}

/* ------------------------------------------------------------------ */

type ParamBody = Exclude<TemplateElement['body'], { kind: 'lit' } | { kind: 'tail' }>;
type TailBody = Extract<TemplateElement['body'], { kind: 'tail' }>;

function parseParam(
  inner: string,
  loc: string,
  seenNames: Set<string>,
  paramNames: string[],
): ParamBody {
  const colon = inner.indexOf(':');
  if (colon <= 0) {
    throw new TemplateParseError(
      `parameter "{${inner}}" needs a name and a constraint separated by ":"`,
      'BAD_PARAMETER',
      loc,
    );
  }
  const name = inner.slice(0, colon);
  validateName(name, loc);
  if (seenNames.has(name)) {
    throw new TemplateParseError(`duplicate parameter name "${name}"`, 'DUPLICATE_NAME', loc);
  }
  const constraint = inner.slice(colon + 1);
  const language = parseConstraint(constraint, loc);
  seenNames.add(name);
  paramNames.push(name);

  if (language.kind === 'int') {
    return { kind: 'param', name, language, paramKind: 'int' };
  }
  return { kind: 'param', name, language, paramKind: 'chars' };
}

function parseTail(
  inner: string,
  loc: string,
  seenNames: Set<string>,
  paramNames: string[],
): TailBody {
  const colon = inner.indexOf(':');
  if (colon <= 0) {
    throw new TemplateParseError(
      `tail "{*${inner}}" needs a name and a constraint separated by ":"`,
      'BAD_TAIL',
      loc,
    );
  }
  const name = inner.slice(0, colon);
  validateName(name, loc);
  if (seenNames.has(name)) {
    throw new TemplateParseError(`duplicate parameter name "${name}"`, 'DUPLICATE_NAME', loc);
  }
  const constraint = inner.slice(colon + 1);
  const language = parseConstraint(constraint, loc);
  if (language.kind === 'int') {
    throw new TemplateParseError(
      'tail capture cannot use an integer language (integers match one segment only)',
      'INT_TAIL',
      loc,
    );
  }
  seenNames.add(name);
  paramNames.push(name);
  return { kind: 'tail', name, language };
}

function validateName(name: string, loc: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TemplateParseError(`illegal parameter name "${name}"`, 'BAD_NAME', loc);
  }
}

/** Parse the part after ":" into an int or chars language. */
function parseConstraint(input: string, loc: string): SegmentLanguage {
  const trimmed = input.trim();
  if (trimmed.startsWith('int')) {
    const rest = trimmed.slice(3).trim();
    const range = matchBracket(rest, loc);
    if (range === null) {
      throw new TemplateParseError(
        `integer constraint expects "[min..max]", got "${input}"`,
        'BAD_INT_CONSTRAINT',
        loc,
      );
    }
    const dd = range.indexOf('..');
    if (dd < 0) {
      throw new TemplateParseError('integer range needs "min..max"', 'BAD_INT_RANGE', loc);
    }
    const min = parseSafeInteger(range.slice(0, dd).trim(), loc);
    const max = parseSafeInteger(range.slice(dd + 2).trim(), loc);
    if (min > max) {
      throw new TemplateParseError(
        `integer range empty: ${min}..${max}`,
        'EMPTY_INT_RANGE',
        loc,
      );
    }
    return { kind: 'int', min, max };
  }

  // Character set "[...]" (bracket matched with escape awareness),
  // optionally followed by a length constraint {len} / {min..max}.
  let setPart = trimmed;
  let minLength = 1;
  let maxLength = 1;
  const closeAt = findClosingBracket(trimmed, loc);
  if (closeAt >= 0 && closeAt + 1 < trimmed.length) {
    const suffix = trimmed.slice(closeAt + 1).trim();
    const brace = /^\{([^{}]*)\}$/.exec(suffix);
    if (!brace) {
      throw new TemplateParseError(
        `unexpected text "${suffix}" after character set`,
        'BAD_CONSTRAINT_SUFFIX',
        loc,
      );
    }
    setPart = trimmed.slice(0, closeAt + 1);
    const spec = brace[1].trim();
    const dd = spec.indexOf('..');
    if (dd >= 0) {
      minLength = parsePositiveInt(spec.slice(0, dd).trim(), loc);
      maxLength = parsePositiveInt(spec.slice(dd + 2).trim(), loc);
    } else {
      const n = parsePositiveInt(spec, loc);
      minLength = n;
      maxLength = n;
    }
    if (minLength < 1 || minLength > maxLength) {
      throw new TemplateParseError(
        `invalid length constraint {${spec}}`,
        'BAD_LENGTH',
        loc,
      );
    }
  }

  const set = matchBracket(setPart, loc);
  if (set === null) {
    throw new TemplateParseError(
      `constraint "${input}" must be a character set "[...]" or "int[min..max]"`,
      'BAD_CONSTRAINT',
      loc,
    );
  }
  const chars = parseCharset(set, loc);
  return { kind: 'chars', chars, minLength, maxLength };
}

/**
 * True when the unit is brace-wrapped and all braces are balanced. Nested
 * braces (e.g. the {len} constraint of a charset parameter) are legal.
 */
function hasMatchingOuterBraces(body: string): boolean {
  if (!body.startsWith('{') || !body.endsWith('}')) return false;
  let depth = 0;
  for (const ch of body) {
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** If `s` starts with "[" return the index of its matching "]", else -1. */
function findClosingBracket(s: string, loc: string): number {
  if (!s.startsWith('[')) return -1;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s[i] === ']') return i;
  }
  throw new TemplateParseError(`unbalanced bracket in "${s}"`, 'UNBALANCED_BRACKET', loc);
}

/** If `s` is "[...]" return the inner content, else null. */
function matchBracket(s: string, loc: string): string | null {
  const t = s.trim();
  if (!t.startsWith('[')) return null;
  const close = findClosingBracket(t, loc);
  if (close !== t.length - 1) {
    throw new TemplateParseError(`unbalanced bracket in "${s}"`, 'UNBALANCED_BRACKET', loc);
  }
  return t.slice(1, close);
}

function parseCharset(inner: string, loc: string): string {
  const out = new Set<string>();
  let i = 0;
  const next = (): string => {
    const ch = inner[i];
    if (ch === undefined) {
      throw new TemplateParseError('unterminated character set', 'BAD_CHARSET', loc);
    }
    i += 1;
    return ch;
  };
  while (i < inner.length) {
    let ch = next();
    if (ch === '\\') {
      ch = next();
      out.add(ch);
      continue;
    }
    // range: an unescaped '-' with a following endpoint
    if (ch !== '-' && i + 1 < inner.length && inner[i] === '-' && inner[i + 1] !== ']') {
      i += 1; // consume '-'
      let end = next();
      if (end === '\\') end = next();
      const startCode = ch.codePointAt(0)!;
      const endCode = end.codePointAt(0)!;
      if (startCode > endCode) {
        throw new TemplateParseError(
          `empty character range "${ch}-${end}"`,
          'EMPTY_RANGE',
          loc,
        );
      }
      for (let c = startCode; c <= endCode; c++) out.add(String.fromCodePoint(c));
    } else {
      out.add(ch);
    }
  }
  if (out.size === 0) {
    throw new TemplateParseError('empty character set', 'EMPTY_CHARSET', loc);
  }
  return [...out].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!).join('');
}

function parseLiteral(body: string, loc: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      if (i + 1 >= body.length) {
        throw new TemplateParseError('dangling escape in literal', 'DANGLING_ESCAPE', loc);
      }
      out += body[i + 1];
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseSafeInteger(s: string, loc: string): number {
  if (!/^-?\d+$/.test(s)) {
    throw new TemplateParseError(`"${s}" is not an integer`, 'BAD_INTEGER', loc);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) {
    throw new TemplateParseError(`integer "${s}" exceeds safe integer range`, 'UNSAFE_INTEGER', loc);
  }
  return n;
}

function parsePositiveInt(s: string, loc: string): number {
  const n = parseSafeInteger(s, loc);
  if (n < 0) {
    throw new TemplateParseError(`length "${s}" must be non-negative`, 'NEGATIVE_LENGTH', loc);
  }
  return n;
}
