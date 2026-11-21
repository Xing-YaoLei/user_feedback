/**
 * Public vocabulary for the compensating step-graph orchestrator.
 *
 * The orchestrator never knows how to talk to a downstream service. Every step
 * carries three caller-injected adapters:
 *
 *   execute     performs the forward operation
 *   queryFinal  asks the participant for the stable final state of an operation
 *   compensate  performs the inverse operation
 *
 * Both execute and compensate receive a stable operation id. Retries, process
 * restarts and repeated recovery all reuse that same id, so a participant can
 * implement idempotency by keying on it.
 */

export type OperationKind = 'execute' | 'compensate';

export interface OperationContext {
  readonly changeId: string;
  readonly stepId: string;
  readonly kind: OperationKind;
  /** Stable across retries and process restarts. */
  readonly operationId: string;
  /** 1-based dispatch attempt for this operation id. */
  readonly attempt: number;
}

/**
 * Terminal (or still indeterminate) state reported by queryFinal.
 *
 * For an execute operation:
 *   succeeded | failed | not_found | unknown
 *
 * For a compensation operation:
 *   compensated | not_compensated | not_found | unknown
 *
 * `not_found` means the participant has no record of the operation, so the
 * request may safely be (re)dispatched with the same operation id. Once a
 * participant reports a terminal state it must keep reporting that state.
 */
export type FinalOperationState =
  | 'succeeded'
  | 'failed'
  | 'compensated'
  | 'not_compensated'
  | 'not_found'
  | 'unknown';

export interface FinalOperationResultObject {
  state: FinalOperationState;
  reason?: string;
}

export type FinalOperationResult = FinalOperationState | FinalOperationResultObject;

/** Resolving normally means the forward effect is applied. */
export type ExecuteOutcome =
  | void
  | { state: 'succeeded' }
  | { state: 'failed'; reason?: string };

/** Resolving normally means the inverse effect is applied. */
export type CompensateOutcome =
  | void
  | { state: 'compensated' }
  | { state: 'failed'; reason?: string };

export interface StepParticipant {
  /** Forward operation. A rejection is treated as an indeterminate outcome. */
  execute(context: OperationContext): Promise<ExecuteOutcome>;
  /** Stable final-state lookup keyed by (operationId, kind). */
  queryFinal(context: OperationContext): Promise<FinalOperationResult>;
  /** Inverse operation. A rejection is a retryable compensation failure. */
  compensate(context: OperationContext): Promise<CompensateOutcome>;
}

export type ParticipantMap =
  | ReadonlyMap<string, StepParticipant>
  | Readonly<Record<string, StepParticipant>>;

export interface StepSpec {
  readonly id: string;
  /** Upstream dependencies. A step starts only after all of them succeeded. */
  readonly dependsOn?: readonly string[];
}

export interface ChangeSpec {
  readonly id: string;
  readonly steps: readonly StepSpec[];
}

export type StepPhase =
  | 'idle'
  | 'running'
  | 'unresolved'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type CompensationStatus =
  | 'none'
  | 'pending'
  | 'running'
  | 'verifying'
  | 'retryable_failed'
  | 'compensated';

export type ChangeStatus =
  | 'running'
  | 'compensating'
  | 'completed'
  | 'failed_compensated'
  | 'cancelled_compensated';

export interface CompensationSnapshot {
  status: CompensationStatus;
  operationId: string | null;
  attempts: number;
  lastError: string | null;
}

export interface StepSnapshot {
  id: string;
  dependsOn: string[];
  phase: StepPhase;
  executeOperationId: string | null;
  executeAttempts: number;
  lastExecuteError: string | null;
  compensation: CompensationSnapshot;
}

export interface ChangeSnapshot {
  changeId: string;
  status: ChangeStatus;
  terminal: boolean;
  abort: {
    kind: 'failure' | 'cancel';
    stepId?: string;
    reason?: string;
  } | null;
  cancellationAccepted: boolean;
  steps: StepSnapshot[];
  /** Original definitive failures, by participant. */
  failures: Array<{
    stepId: string;
    operationId: string;
    reason: string;
  }>;
  /** Steps whose forward outcome is still unknown and is being queried. */
  indeterminate: Array<{
    stepId: string;
    operationId: string;
    attempts: number;
    lastError: string | null;
  }>;
  /** Compensation attempts that failed and can be retried with the same id. */
  compensationFailures: Array<{
    stepId: string;
    operationId: string;
    attempts: number;
    lastError: string | null;
  }>;
  /** Successful steps whose effect has not been revoked yet. */
  pendingCompensations: Array<{
    stepId: string;
    operationId: string;
    status: CompensationStatus;
  }>;
}

export type CancelResult =
  | { changeId: string; status: 'accepted' }
  | { changeId: string; status: 'already_accepted' }
  | { changeId: string; status: 'already_completed' }
  | {
      changeId: string;
      status: 'already_terminal';
      changeStatus: ChangeStatus;
    };

/** Thrown by an execute adapter when it knows the operation did not take effect. */
export class DefinitiveFailure extends Error {
  readonly definitive = true;

  constructor(reason: string) {
    super(reason);
    this.name = 'DefinitiveFailure';
  }
}

export function definitiveFailure(reason: string): DefinitiveFailure {
  return new DefinitiveFailure(reason);
}

export function isDefinitiveFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { definitive?: unknown }).definitive === true
  );
}

/** Deterministic id shared by every dispatch, query and retry. */
export function makeOperationId(
  changeId: string,
  stepId: string,
  kind: OperationKind,
): string {
  const safeChange = encodeURIComponent(changeId);
  const safeStep = encodeURIComponent(stepId);
  return `${safeChange}/${safeStep}/${kind}`;
}

export function normalizeFinal(result: FinalOperationResult): {
  state: FinalOperationState;
  reason?: string;
} {
  if (typeof result === 'string') return { state: result };
  return { state: result.state, reason: result.reason };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
