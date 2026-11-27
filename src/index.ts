export { MultipartParser, MultipartError, DEFAULT_LIMITS, parseContentDisposition } from './multipart.ts';
export type {
  ByteSource,
  FieldPart,
  FilePart,
  MultipartLimits,
  Part,
  PartHeaders,
} from './multipart.ts';

import { MultipartParser } from './multipart.ts';
import type { ByteSource, MultipartLimits } from './multipart.ts';

/** 便捷入口：创建一个 multipart 解析器（本身即 AsyncIterable<Part>）。 */
export function parseMultipart(
  boundary: string,
  source: ByteSource,
  limits?: Partial<MultipartLimits>,
): MultipartParser {
  return new MultipartParser(boundary, source, limits);
}
