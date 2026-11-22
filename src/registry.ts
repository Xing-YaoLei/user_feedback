import type {
  Direction,
  Schema,
  TypePath,
  WireValue,
} from './types.ts';
import { CompatibilityError, ParseError, renderPath } from './errors.ts';
import { validateSchema } from './validate.ts';
import type { ValidatedSchema } from './validate.ts';
import { CompatChecker, buildCounterexample } from './compat.ts';
import type { CheckOutcome } from './compat.ts';
import { buildPlan } from './plan.ts';
import type { Plan } from './plan.ts';

export interface RegistrationResult {
  version: string;
  /** Plans proven compatible under the requested direction policy. */
  checkedPlans: { writerVersion: string; readerVersion: string; plan: Plan }[];
}

/**
 * Central schema registry. New and old producers/consumers run side by side;
 * every registration is checked against all previously registered versions
 * under the selected direction policy, and a failed registration leaves the
 * existing version set untouched.
 */
export class SchemaRegistry {
  private readonly versions = new Map<string, ValidatedSchema>();
  private readonly order: string[] = [];
  private readonly planCache = new Map<string, Plan>();

  listVersions(): string[] {
    return [...this.order];
  }

  has(version: string): boolean {
    return this.versions.has(version);
  }

  getSchema(version: string): Schema {
    const vs = this.requireVersion(version);
    return vs.schema;
  }

  /**
   * Validate and register a new schema version.
   *
   * @param direction
   *   backward    - old writers' messages stay readable by the new schema
   *   forward     - the new writer's messages stay readable by old readers
   *   bidirectional - both
   * @throws SchemaValidationError for malformed schemas
   * @throws CompatibilityError (with type path and encodable counterexample)
   *   when the policy is violated; the registered version set is unchanged.
   */
  register(schema: Schema, direction: Direction): RegistrationResult {
    const candidate = validateSchema(schema);
    if (this.versions.has(candidate.schema.version)) {
      throw new CompatibilityError(
        `schema version '${candidate.schema.version}' is already registered`,
        'duplicate-version',
        [{ kind: 'root' }],
        candidate.schema.version,
        candidate.schema.version,
        candidate.rootSample,
      );
    }

    const checkedPlans: RegistrationResult['checkedPlans'] = [];
    for (const oldVersion of this.order) {
      const old = this.versions.get(oldVersion) as ValidatedSchema;

      if (direction === 'backward' || direction === 'bidirectional') {
        // old write -> new read
        const plan = this.analyzePair(old, candidate);
        checkedPlans.push({
          writerVersion: oldVersion,
          readerVersion: candidate.schema.version,
          plan,
        });
      }
      if (direction === 'forward' || direction === 'bidirectional') {
        // new write -> old read
        const plan = this.analyzePair(candidate, old);
        checkedPlans.push({
          writerVersion: candidate.schema.version,
          readerVersion: oldVersion,
          plan,
        });
      }
    }

    // Atomic commit: only reached when every check passed.
    this.versions.set(candidate.schema.version, candidate);
    this.order.push(candidate.schema.version);
    return { version: candidate.schema.version, checkedPlans };
  }

  /**
   * Analyze one ordered version pair. Returns a reusable plan when
   * compatible; throws a CompatibilityError carrying the type path and a
   * finite wire counterexample otherwise.
   */
  analyze(writerVersion: string, readerVersion: string): Plan {
    const w = this.requireVersion(writerVersion);
    const r = this.requireVersion(readerVersion);
    const outcome = new CompatChecker(w, r).checkRoot();
    if (outcome.ok) {
      return this.getPlan(writerVersion, readerVersion);
    }
    throw this.toError(w, r, outcome);
  }

  /**
   * Return the reusable resolution plan for an ordered pair, building it on
   * first use. Incompatible pairs get a best-effort plan whose trap nodes
   * reproduce the static failure reason and path at runtime.
   */
  getPlan(writerVersion: string, readerVersion: string): Plan {
    const key = `${writerVersion}=>${readerVersion}`;
    const cached = this.planCache.get(key);
    if (cached) return cached;
    const w = this.requireVersion(writerVersion);
    const r = this.requireVersion(readerVersion);
    const plan = buildPlan(w, r);
    this.planCache.set(key, plan);
    return plan;
  }

  /** Parse a wire message with its own schema version. */
  parse(version: string, message: WireValue): WireValue {
    const plan = this.getPlan(version, version);
    return plan.convert(message);
  }

  /**
   * Parse a message written by `writerVersion` using `readerVersion`.
   *
   * For compatible pairs this is the reusable cross-version plan. For
   * incompatible pairs the best-effort plan is executed, and a static
   * counterexample fails here with the same reason and type path reported by
   * {@link analyze}.
   */
  parseAcross(
    writerVersion: string,
    readerVersion: string,
    message: WireValue,
  ): WireValue {
    return this.getPlan(writerVersion, readerVersion).convert(message);
  }

  private analyzePair(writer: ValidatedSchema, reader: ValidatedSchema): Plan {
    const outcome: CheckOutcome = new CompatChecker(writer, reader).checkRoot();
    if (!outcome.ok) {
      throw this.toError(writer, reader, outcome);
    }
    const key = `${writer.schema.version}=>${reader.schema.version}`;
    let plan = this.planCache.get(key);
    if (!plan) {
      plan = buildPlan(writer, reader);
      this.planCache.set(key, plan);
    }
    return plan;
  }

  private toError(
    writer: ValidatedSchema,
    reader: ValidatedSchema,
    outcome: CheckOutcome,
  ): CompatibilityError {
    if (outcome.ok) {
      throw new Error('toError called on a successful outcome');
    }
    const failure = outcome.failure;
    const fullCounterexample = buildCounterexample(
      writer,
      writer.schema.root,
      failure.path,
      failure.counterexample,
    );
    const path: TypePath = failure.path;
    return new CompatibilityError(
      `incompatible schemas (writer '${writer.schema.version}' -> reader '${reader.schema.version}'): ` +
        `${failure.reason} at ${renderPath(path)}`,
      failure.reason,
      path,
      writer.schema.version,
      reader.schema.version,
      fullCounterexample,
    );
  }

  private requireVersion(version: string): ValidatedSchema {
    const vs = this.versions.get(version);
    if (!vs) {
      throw new ParseError(
        `unknown schema version '${version}'`,
        'unknown-version',
        [{ kind: 'root' }],
      );
    }
    return vs;
  }
}
