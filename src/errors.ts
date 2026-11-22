import type { TypePath } from './types.ts';

export function renderPath(path: TypePath): string {
  return path
    .map((step) => {
      switch (step.kind) {
        case 'root':
          return '$';
        case 'field':
          return `.field#${step.id}(${step.name})`;
        case 'array-item':
          return `[${step.index}]`;
        case 'union-branch':
          return `<tag:${step.tag}>`;
      }
    })
    .join('');
}

/** Raised when a schema fails structural validation at registration time. */
export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

/**
 * Raised when two schema versions are incompatible. Carries the type path
 * where the mismatch was found and a finite wire counterexample that can be
 * encoded and fed to the parsing entry to trigger the same failure.
 */
export class CompatibilityError extends Error {
  readonly reason: string;
  readonly path: TypePath;
  readonly writerVersion: string;
  readonly readerVersion: string;
  readonly counterexample: unknown;

  constructor(
    message: string,
    reason: string,
    path: TypePath,
    writerVersion: string,
    readerVersion: string,
    counterexample: unknown,
  ) {
    super(message);
    this.name = 'CompatibilityError';
    this.reason = reason;
    this.path = path;
    this.counterexample = counterexample;
    this.writerVersion = writerVersion;
    this.readerVersion = readerVersion;
  }
}

/** Raised when an actual wire message cannot be parsed. */
export class ParseError extends Error {
  readonly reason: string;
  readonly path: TypePath;

  constructor(message: string, reason: string, path: TypePath) {
    super(message);
    this.name = 'ParseError';
    this.reason = reason;
    this.path = path;
  }
}
