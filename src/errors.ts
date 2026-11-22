/**
 * Error hierarchy for the route compiler.
 *
 * Every error carries a machine readable `code` and, where the input is
 * positional, a `location` string that lets the caller point at the exact
 * segment / byte offset that caused the failure.
 */
export class RouteError extends Error {
  readonly code: string;
  readonly location: string | undefined;

  constructor(message: string, code: string, location?: string) {
    super(location === undefined ? message : `${message} (at ${location})`);
    this.name = 'RouteError';
    this.code = code;
    this.location = location;
  }
}

/** Malformed template syntax / invalid parameter constraint. */
export class TemplateParseError extends RouteError {}

/** Malformed percent encoding or invalid UTF-8 in an input path. */
export class EncodingError extends RouteError {}

/** Caller supplied invalid parameters to reverse generation. */
export class RouteValidationError extends RouteError {}

/** Internal safety limit (e.g. enumeration cap) was exceeded. */
export class DecidabilityLimitError extends RouteError {}
