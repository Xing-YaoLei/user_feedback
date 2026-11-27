/**
 * MurmurHash3 (32 位, x86 风格) 与基于双重哈希 (Kirsch-Mitzenmacher) 的
 * Bloom 哈希位置计算。
 *
 * 哈希参数（容量 size、哈希个数 hashes、种子 seed）全部由调用方指定，
 * 同一 (subscriber, topic) 身份在同一代次内始终映射到相同的一组位置。
 */

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

function multiply32(a: number, b: number): number {
  // Math.imul 给出带符号的 32 位乘积结果，符合 Murmur3 的位运算语义
  return Math.imul(a, b);
}

function rotl32(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

/**
 * MurmurHash3 32 位。字符串按 UTF-16 代码单元编码为字节序列，
 * 结果为无符号 32 位整数。
 */
export function murmur3_32(key: string, seed: number = 0): number {
  let h = seed | 0;

  // 按 UTF-16 代码单元拆成低字节/高字节
  const bytes: number[] = [];
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    bytes.push(code & 0xff, code >>> 8);
  }

  const nblocks = bytes.length - (bytes.length % 4);

  for (let i = 0; i < nblocks; i += 4) {
    let k =
      bytes[i] |
      (bytes[i + 1] << 8) |
      (bytes[i + 2] << 16) |
      (bytes[i + 3] << 24);

    k = multiply32(k, C1);
    k = rotl32(k, 15);
    k = multiply32(k, C2);

    h ^= k;
    h = rotl32(h, 13);
    h = (multiply32(h, 5) + 0xe6546b64) | 0;
  }

  let k1 = 0;
  const tail = bytes.length - nblocks;
  switch (tail) {
    case 3:
      k1 ^= bytes[nblocks + 2] << 16;
    // fall through
    case 2:
      k1 ^= bytes[nblocks + 1] << 8;
    // fall through
    case 1:
      k1 ^= bytes[nblocks];
      k1 = multiply32(k1, C1);
      k1 = rotl32(k1, 15);
      k1 = multiply32(k1, C2);
      h ^= k1;
    // fall through
    default:
      break;
  }

  h ^= bytes.length;
  h ^= h >>> 16;
  h = multiply32(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = multiply32(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return h >>> 0;
}

/**
 * 计算一个身份键在给定容量与哈希个数下命中的全部向量位置。
 *
 * 采用 Kirsch-Mitzenmacher 双重哈希：g_i(x) = (h1(x) + i*h2(x)) mod m，
 * 只需两次 Murmur3 调用即可派生 hashes 个位置。
 *
 * 去重：同一身份若在多个 i 上映射到同一位置，只返回一次
 * （对应“同一主题重复命中同一哈希位置只贡献一次计数”）。
 */
export function bloomPositions(
  key: string,
  size: number,
  hashes: number,
  seed: number,
): number[] {
  const h1 = murmur3_32(key, seed);
  // 第二个哈希使用不同种子派生，保证与 h1 独立
  const h2 = murmur3_32(key, seed ^ 0x9e3779b9);

  const seen = new Set<number>();
  const positions: number[] = [];
  for (let i = 0; i < hashes; i++) {
    const pos = (h1 + Math.imul(i, h2)) % size;
    const idx = pos < 0 ? pos + size : pos;
    if (!seen.has(idx)) {
      seen.add(idx);
      positions.push(idx);
    }
  }
  return positions;
}

/** 身份键：订阅者与主题的稳定组合。 */
export function identityKey(subscriber: string, topic: string): string {
  // 长度前缀避免不同 (subscriber, topic) 组合的拼接歧义
  return `${subscriber.length}:${subscriber}\u0000${topic}`;
}
