/**
 * Public module entry point.
 *
 * Embedding: `new IdempotencyGateway({ stateDirectory, adapter })`.
 * Process:   `runServerCli(process.argv.slice(2))` or `node src/main.ts ...`.
 */
export { IdempotencyGateway, type GatewayOptions } from './manager.ts';
export {
  createGatewayServer,
  runServerCli,
  loadAdapterFactory,
  type AdapterFactory,
  type AdapterFactoryContext,
  type GatewayServer,
  type ServerOptions,
} from './server.ts';
export { GatewayClient, RemoteGatewayError, type ClientOptions, type Endpoint } from './client.ts';
export { TicketStore, type StoreOptions } from './store.ts';
export {
  BusinessError,
  GatewayError,
  IndeterminateError,
  InvalidInputError,
  KeyConflictError,
  ProofMismatchError,
  ProofReplayedError,
  ResultExpiredError,
  StoreCorruptError,
  StoreLockedError,
  TicketNotFoundError,
  TicketNotIndeterminateError,
  TicketNotTerminalError,
  WaiterCancelledError,
  asGatewayError,
  isBusinessError,
  toErrorShape,
  type GatewayErrorCode,
} from './errors.ts';
export {
  assertIdentity,
  canonicalJson,
  keyHashFor,
  normalizeBody,
  sha256Hex,
} from './util.ts';
export type {
  AdapterExecutionInput,
  DerivedStatus,
  EntryRecord,
  ExecutionAdapter,
  ExecutionIntentRecord,
  IdempotencyIdentity,
  InvokeInput,
  InvokeResult,
  KeyView,
  ProofRecord,
  ReclaimExpiredResult,
  ReclaimResult,
  ReconcileInput,
  ReconciliationCompletedProof,
  ReconciliationNotExecutedProof,
  ReconciliationProof,
  ReconciliationRecord,
  RecoveryReport,
  TerminalBusinessError,
  TerminalOutcome,
  TerminalSuccess,
  TicketRecord,
  TicketStatus,
  TicketView,
} from './types.ts';
