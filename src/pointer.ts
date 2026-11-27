/** JSON Pointer（RFC 6901）与实例/Schema 路径工具。 */

/** 按 RFC 6901 转义单个 reference token。 */
export function encodeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 还原单个 reference token。 */
export function decodeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** 拼接实例路径：joinPath('/a', 'b') -> '/a/b'；根路径为 ''。 */
export function joinInstancePath(base: string, token: string | number): string {
  return `${base}/${encodeToken(String(token))}`;
}

/**
 * 拼接 Schema 路径。Schema 路径以 '#' 开头，根为 '#'。
 * joinSchemaPath('#', 'anyOf', 0) -> '#/anyOf/0'
 */
export function joinSchemaPath(base: string, ...tokens: (string | number)[]): string {
  let out = base;
  for (const token of tokens) {
    out = `${out}/${encodeToken(String(token))}`;
  }
  return out;
}

/**
 * 解析本地 $ref（形如 '#/$defs/node' 或 '#'）为节点 pointer（不含前导 '#'）。
 * 非本地引用或格式非法时返回 null。
 */
export function parseLocalRef(ref: string): string | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref[0] !== '#') {
    return null;
  }
  const fragment = ref.slice(1);
  if (fragment === '' || fragment === '/') {
    return '';
  }
  if (fragment[0] !== '/') {
    return null;
  }
  // 逐 token 解码后再按规范重新编码，保证与节点 pointer 表精确匹配。
  const parts = fragment.slice(1).split('/');
  let pointer = '';
  for (const raw of parts) {
    if (raw.includes('#')) {
      return null;
    }
    pointer += `/${encodeToken(decodeToken(raw))}`;
  }
  return pointer;
}
