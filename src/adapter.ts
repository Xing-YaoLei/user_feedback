import type {
  AdapterCommand,
  AdapterPort,
  AdapterSnapshot,
  CommandReceipt,
  ConfigValue,
  InstallCommand,
  InstallOwner,
  InstallReceipt,
  RestoreCommand,
  RestoreReceipt,
} from './types.ts';
import type { Clock } from './types.ts';
import { cloneConfig } from './clock.ts';

export type AdapterOptions = {
  instanceId: string;
  generation?: number;
  initialConfig: ConfigValue;
  clock: Clock;
};

export type DeliveryMode = 'auto' | 'manual';

type Envelope = {
  receipt: CommandReceipt;
};

/**
 * In-memory instance adapter modelled after a per-host config agent.
 *
 * Two independent fences make late traffic harmless:
 *
 *  - command side: every command carries a monotonic `intent`. Once intent N
 *    has been observed, any command with intent <= N is rejected without
 *    touching local state — even if command N itself was rejected by its own
 *    condition. Commands can be held in transit (`holdCommands`) to model a
 *    delayed link; a stale command that arrives after a newer one is refused.
 *
 *  - process side: commands target a process generation. A command aimed at a
 *    previous generation is refused with `wrong-generation`.
 *
 * Restores are conditional: they only apply when the currently installed
 * configuration is still owned by the release that requests the rollback.
 * Anything else (an external edit, another release, an earlier restore) is
 * preserved and reported as `condition-mismatch`.
 *
 * Receipts may be delivered automatically, held in bulk (`manual` mode plus
 * `beginHold`/`releaseHeld`), or replayed later with `deliver` to model a
 * receipt that arrives after the release has already moved on.
 */
export class InMemoryInstanceAdapter implements AdapterPort {
  readonly instanceId: string;
  #generation: number;
  #config: ConfigValue;
  #owner: InstallOwner = { kind: 'initial' };
  #lastIntent = 0;
  #revision = 0;
  #clock: Clock;
  #sink: ((receipt: CommandReceipt) => void) | null = null;
  #outbox: Envelope[] = [];
  #delivery: DeliveryMode = 'auto';
  #crashed = false;
  #droppedCommands = 0;
  /** Receipts produced while this is > 0 are held regardless of mode. */
  #holdDepth = 0;
  #held: Envelope[] = [];
  /** Commands held in transit while this is true. */
  #holdCommands = false;
  #inbound: AdapterCommand[] = [];

  constructor(options: AdapterOptions) {
    this.instanceId = options.instanceId;
    this.#generation = options.generation ?? 1;
    this.#config = cloneConfig(options.initialConfig);
    this.#clock = options.clock;
  }

  get generation(): number {
    return this.#generation;
  }

  get deliveryMode(): DeliveryMode {
    return this.#delivery;
  }

  get pendingReceiptCount(): number {
    return this.#outbox.length + this.#held.length;
  }

  get pendingCommandCount(): number {
    return this.#inbound.length;
  }

  get droppedCommands(): number {
    return this.#droppedCommands;
  }

  setDeliveryMode(mode: DeliveryMode): void {
    this.#delivery = mode;
  }

  setReceiptSink(sink: ((receipt: CommandReceipt) => void) | null): void {
    this.#sink = sink;
  }

  /**
   * Applies a command immediately unless commands are held in transit or the
   * process is down. Returns false only when the command was dropped entirely
   * (process down); a held command still counts as delivered.
   */
  enqueue(command: AdapterCommand): boolean {
    if (this.#crashed) {
      this.#droppedCommands += 1;
      return false;
    }
    if (this.#holdCommands) {
      this.#inbound.push(command);
      return true;
    }
    this.#apply(command);
    return true;
  }

  /** Starts buffering commands as if the link to the instance were cut. */
  holdCommands(): void {
    this.#holdCommands = true;
  }

  /**
   * Removes and returns the buffered commands without applying them, so a
   * caller can replay them in any order via `deliverCommand`. Stops holding.
   */
  drainHeldCommands(): AdapterCommand[] {
    this.#holdCommands = false;
    const pending = this.#inbound;
    this.#inbound = [];
    return pending;
  }

  /**
   * Applies a command directly, standing in for a link that delivers it now.
   * The intent / generation fences still decide whether it takes effect.
   */
  deliverCommand(command: AdapterCommand): boolean {
    if (this.#crashed) {
      this.#droppedCommands += 1;
      return false;
    }
    this.#apply(command);
    return true;
  }

  /**
   * Applies buffered commands in the given order. FIFO is a slow-but-ordered
   * link; LIFO models commands overtaking each other, which is exactly what
   * the intent fence must survive.
   */
  releaseCommands(order: 'fifo' | 'lifo' = 'fifo'): number {
    this.#holdCommands = false;
    const pending = order === 'fifo' ? this.#inbound : [...this.#inbound].reverse();
    this.#inbound = [];
    for (const command of pending) {
      this.#apply(command);
    }
    return pending.length;
  }

  /** Starts holding every produced receipt until the matching release. */
  beginHold(): void {
    this.#holdDepth += 1;
  }

  /**
   * Stops holding and returns the retained receipts without delivering them.
   * The caller decides when (and whether) to hand them to the controller.
   */
  releaseHeld(): CommandReceipt[] {
    if (this.#holdDepth === 0) return [];
    this.#holdDepth -= 1;
    if (this.#holdDepth > 0) return [];
    const receipts = this.#held.map((envelope) => envelope.receipt);
    this.#held = [];
    return receipts;
  }

  /** Delivers a retained receipt verbatim, exactly as a late link would. */
  deliver(receipt: CommandReceipt): void {
    this.#sink?.(receipt);
  }

  /** Releases every queued receipt to the sink, preserving order. */
  flush(): number {
    return this.#flushInternal();
  }

  #apply(command: AdapterCommand): void {
    const receipt = this.#execute(command);
    if (!receipt) return;
    const envelope: Envelope = { receipt };
    if (this.#holdDepth > 0) {
      this.#held.push(envelope);
      return;
    }
    this.#outbox.push(envelope);
    if (this.#delivery === 'auto') {
      this.#flushInternal();
    }
  }

  #flushInternal(): number {
    if (this.#outbox.length === 0) return 0;
    if (!this.#sink) return 0;
    const pending = this.#outbox;
    this.#outbox = [];
    for (const envelope of pending) {
      this.#sink(envelope.receipt);
    }
    return pending.length;
  }

  snapshot(): AdapterSnapshot {
    return {
      instanceId: this.instanceId,
      generation: this.#generation,
      config: cloneConfig(this.#config),
      owner: structuredClone(this.#owner),
      lastIntent: this.#lastIntent,
      revision: this.#revision,
    };
  }

  /** Simulates an operator changing config directly (bypasses the fence). */
  applyExternalConfig(config: ConfigValue, note?: string): AdapterSnapshot {
    this.#config = cloneConfig(config);
    this.#owner = { kind: 'external', note };
    this.#revision += 1;
    return this.snapshot();
  }

  /** Simulates the host process going away; commands are dropped silently. */
  crash(): void {
    this.#crashed = true;
  }

  /** Brings the process back, optionally with a new process generation. */
  restart(options: { bumpGeneration?: boolean } = {}): AdapterSnapshot {
    this.#crashed = false;
    if (options.bumpGeneration ?? true) {
      this.#generation += 1;
      // The intent fence is durable across restarts: intents only grow, so a
      // command queued before the restart can never win afterwards.
    }
    return this.snapshot();
  }

  get crashed(): boolean {
    return this.#crashed;
  }

  #execute(command: AdapterCommand): CommandReceipt | null {
    if (command.instanceId !== this.instanceId) {
      return this.#reject(command, 'wrong-instance');
    }

    if (command.kind === 'install' && command.generation !== this.#generation) {
      return this.#reject(command, 'wrong-generation');
    }

    // Intent fence: an older intent may never mutate local state, even if the
    // newer intent was itself rejected for another reason.
    if (command.intent <= this.#lastIntent) {
      return this.#reject(command, 'stale-intent');
    }
    this.#lastIntent = command.intent;

    if (command.kind === 'install') {
      return this.#applyInstall(command);
    }
    return this.#applyRestore(command);
  }

  #applyInstall(command: InstallCommand): InstallReceipt {
    const replacedConfig = cloneConfig(this.#config);
    this.#config = cloneConfig(command.config);
    this.#owner = {
      kind: 'release',
      releaseId: command.releaseId,
      installId: command.installId,
    };
    this.#revision += 1;

    return {
      kind: 'install',
      ok: true,
      intent: command.intent,
      instanceId: this.instanceId,
      releaseId: command.releaseId,
      installId: command.installId,
      generation: command.generation,
      replacedConfig,
      appliedAt: this.#clock.now(),
      revision: this.#revision,
    };
  }

  #applyRestore(command: RestoreCommand): RestoreReceipt {
    const owner = this.#owner;
    const stillOwnedByRelease =
      owner.kind === 'release' && owner.releaseId === command.expectedReleaseId;

    if (!stillOwnedByRelease) {
      return {
        kind: 'restore',
        ok: false,
        intent: command.intent,
        instanceId: this.instanceId,
        releaseId: command.releaseId,
        restoreId: command.restoreId,
        reason: 'condition-mismatch',
        lastIntent: this.#lastIntent,
        currentOwner: structuredClone(owner),
        rejectedAt: this.#clock.now(),
      };
    }

    const previousOwner = structuredClone(owner);
    this.#config = cloneConfig(command.targetConfig);
    this.#owner = {
      kind: 'restored',
      releaseId: command.releaseId,
      restoreId: command.restoreId,
    };
    this.#revision += 1;

    return {
      kind: 'restore',
      ok: true,
      intent: command.intent,
      instanceId: this.instanceId,
      releaseId: command.releaseId,
      restoreId: command.restoreId,
      restoredConfig: cloneConfig(this.#config),
      previousOwner,
      appliedAt: this.#clock.now(),
      revision: this.#revision,
    };
  }

  #reject(
    command: AdapterCommand,
    reason: 'stale-intent' | 'condition-mismatch' | 'wrong-instance' | 'wrong-generation',
  ): CommandReceipt {
    if (command.kind === 'install') {
      return {
        kind: 'install',
        ok: false,
        intent: command.intent,
        instanceId: this.instanceId,
        releaseId: command.releaseId,
        installId: command.installId,
        generation: command.generation,
        reason,
        lastIntent: this.#lastIntent,
        currentOwner: structuredClone(this.#owner),
        rejectedAt: this.#clock.now(),
        actualGeneration: this.#generation,
      };
    }
    return {
      kind: 'restore',
      ok: false,
      intent: command.intent,
      instanceId: this.instanceId,
      releaseId: command.releaseId,
      restoreId: command.restoreId,
      reason,
      lastIntent: this.#lastIntent,
      currentOwner: structuredClone(this.#owner),
      rejectedAt: this.#clock.now(),
    };
  }
}
