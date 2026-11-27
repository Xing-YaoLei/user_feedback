import type { ResourceError } from './types.ts';

/**
 * 资源限制在深层递归求值中以异常形式抛出，由最外层 validate 捕获并转换为
 * ResourceError 结果；校验失败从不抛异常。
 */
export class ResourceLimitError extends Error {
  readonly code: 'max-depth' | 'evaluation-budget';
  readonly instancePath: string;
  readonly limit: number;

  constructor(
    code: 'max-depth' | 'evaluation-budget',
    instancePath: string,
    limit: number,
    message: string,
  ) {
    super(message);
    this.name = 'ResourceLimitError';
    this.code = code;
    this.instancePath = instancePath;
    this.limit = limit;
  }

  toResult(): ResourceError & { valid: false; errors: [] } {
    return {
      valid: false,
      errors: [],
      kind: 'resource',
      code: this.code,
      message: this.message,
      instancePath: this.instancePath,
      limit: this.limit,
    };
  }
}
