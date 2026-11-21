/** Structured error types shared by validation, analysis and encoding. */

export type SchemaErrorCode =
  | 'unknown-ref'
  | 'invalid-ref'
  | 'duplicate-name'
  | 'duplicate-field-id'
  | 'invalid-field-id'
  | 'invalid-default'
  | 'uninhabited-type'
  | 'empty-union'
  | 'duplicate-tag'
  | 'invalid-schema'
  | 'registration-failed';

export class SchemaValidationError extends Error {
  readonly code: SchemaErrorCode;
  readonly path: ReadonlyArray<string | number>;

  constructor(code: SchemaErrorCode, message: string, path: ReadonlyArray<string | number> = []) {
    super(message);
    this.name = 'SchemaValidationError';
    this.code = code;
    this.path = path;
  }
}

export class RegistrationError extends Error {
  readonly code = 'registration-failed' as const;
  readonly version: number;
  readonly results: ReadonlyArray<import('./types.ts').CompatibilityResult>;

  constructor(version: number, results: ReadonlyArray<import('./types.ts').CompatibilityResult>) {
    super(
      `Schema version ${version} is incompatible with an existing version: ` +
        results
          .filter((r) => !r.compatible)
          .map((r) => `${r.direction} ${r.incompatibility?.reason ?? 'incompatible'}`)
          .join('; '),
    );
    this.name = 'RegistrationError';
    this.version = version;
    this.results = results;
  }
}

export class ResolutionError extends Error {
  readonly path: ReadonlyArray<string | number>;

  constructor(message: string, path: ReadonlyArray<string | number> = []) {
    super(message);
    this.name = 'ResolutionError';
    this.path = path;
  }
}

export class ValidationError extends Error {
  readonly path: ReadonlyArray<string | number>;

  constructor(message: string, path: ReadonlyArray<string | number> = []) {
    super(message);
    this.name = 'ValidationError';
    this.path = path;
  }
}
