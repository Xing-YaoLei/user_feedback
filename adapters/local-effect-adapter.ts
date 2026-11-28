/**
 * Local, deliberately non-idempotent execution adapter.
 *
 * Every `execute()` call appends one record to an effect log BEFORE the
 * manager can persist the result. That makes the crash window real: if the
 * manager dies now, the effect exists but no terminal result does. Calling
 * this adapter twice therefore produces two effects — which is exactly the
 * property the gateway must never trigger.
 *
 * Config (passed via --adapter-config JSON or ctx.config):
 *   effectFile        string   required. JSONL where effects are appended.
 *   result            unknown  value returned on success. Default "applied".
 *   holdAfterEffectMs number   after durably appending the effect, sleep this
 *                              long before resolving. Used by crash tests to
 *                              kill the manager inside the window.
 *   failMode          string   'before_effect' | 'after_effect' | 'none'
 *   rejectKeys        string[] idempotency keys answered with a deterministic
 *                              BusinessError (no effect is written).
 *   rejectCode        string   code used for BusinessError. Default 'REJECTED'.
 */
import { closeSync, fsyncSync, openSync, writeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BusinessError, InvalidInputError } from '../src/errors.ts';
import type { AdapterExecutionInput, ExecutionAdapter } from '../src/types.ts';

export interface LocalEffectAdapterConfig {
  effectFile: string;
  result?: unknown;
  holdAfterEffectMs?: number;
  failMode?: 'none' | 'before_effect' | 'after_effect';
  rejectKeys?: string[];
  rejectCode?: string;
}

export class LocalEffectAdapter implements ExecutionAdapter {
  private readonly config: LocalEffectAdapterConfig;

  constructor(config: LocalEffectAdapterConfig) {
    if (!config || typeof config.effectFile !== 'string' || config.effectFile === '') {
      throw new InvalidInputError('LocalEffectAdapter requires config.effectFile');
    }
    this.config = config;
    mkdirSync(dirname(config.effectFile), { recursive: true });
  }

  async execute(input: AdapterExecutionInput): Promise<unknown> {
    const failMode = this.config.failMode ?? 'none';
    const rejectKeys = this.config.rejectKeys ?? [];

    if (rejectKeys.includes(input.idempotencyKey)) {
      // Deterministic, completed business rejection: no side effect.
      throw new BusinessError(this.config.rejectCode ?? 'REJECTED', `rejected by policy: ${input.idempotencyKey}`, {
        idempotencyKey: input.idempotencyKey,
        tenant: input.tenant,
      });
    }

    if (failMode === 'before_effect') {
      throw new Error('simulated crash-equivalent failure before effect');
    }

    const effect = {
      at: new Date().toISOString(),
      pid: process.pid,
      tenant: input.tenant,
      method: input.method,
      idempotencyKey: input.idempotencyKey,
      ticketId: input.ticketId,
      sequence: input.sequence,
      requestDigest: input.requestDigest,
    };
    // Durable append: this is the irreversible part, and it happens before
    // the adapter returns (and therefore before the manager saves a result).
    const fd = openSync(this.config.effectFile, 'a');
    try {
      writeSync(fd, `${JSON.stringify(effect)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (failMode === 'after_effect') {
      throw new Error('simulated failure after effect (unknown outcome)');
    }

    const holdMs = this.config.holdAfterEffectMs ?? 0;
    if (holdMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, holdMs));
    }

    return { applied: true, effect: this.config.result ?? 'applied', ticketId: input.ticketId };
  }
}

/** Adapter module factory used by the CLI (`--adapter <this file>`). */
export function createAdapter(ctx: {
  config: Record<string, unknown>;
}): ExecutionAdapter {
  return new LocalEffectAdapter(ctx.config as unknown as LocalEffectAdapterConfig);
}
