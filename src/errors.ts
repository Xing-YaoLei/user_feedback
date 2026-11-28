/**
 * Structured error hierarchy for the offset lineage store.
 * Every error carries a stable machine-readable `code`.
 */
export class LineageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LineageError";
    this.code = code;
  }
}

/** Thrown when the live (incomplete) record count reaches the configured capacity. */
export class BackpressureError extends LineageError {
  constructor(message: string) {
    super("BACKPRESSURE", message);
    this.name = "BackpressureError";
  }
}

export class DuplicateRecordError extends LineageError {
  constructor(message: string) {
    super("DUPLICATE_RECORD", message);
    this.name = "DuplicateRecordError";
  }
}

export class UnknownRecordError extends LineageError {
  constructor(message: string) {
    super("UNKNOWN_RECORD", message);
    this.name = "UnknownRecordError";
  }
}

export class UnknownGenerationError extends LineageError {
  constructor(message: string) {
    super("UNKNOWN_GENERATION", message);
    this.name = "UnknownGenerationError";
  }
}

export class UnknownOffsetError extends LineageError {
  constructor(message: string) {
    super("UNKNOWN_OFFSET", message);
    this.name = "UnknownOffsetError";
  }
}

export class InvalidLineageError extends LineageError {
  constructor(message: string) {
    super("INVALID_LINEAGE", message);
    this.name = "InvalidLineageError";
  }
}

export class InvalidTopologyError extends LineageError {
  constructor(message: string) {
    super("INVALID_TOPOLOGY", message);
    this.name = "InvalidTopologyError";
  }
}

export class CorruptStateError extends LineageError {
  constructor(message: string) {
    super("CORRUPT_STATE", message);
    this.name = "CorruptStateError";
  }
}
