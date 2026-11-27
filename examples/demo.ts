import { Readable } from 'node:stream';
import { MultipartParser } from '../src/index.ts';

const boundary = 'demo-boundary';
const body =
  `--${boundary}\r\n` +
  'Content-Disposition: form-data; name="title"\r\n\r\n' +
  '你好，multipart 🌍\r\n' +
  `--${boundary}\r\n` +
  'Content-Disposition: form-data; name="tag"\r\n\r\n' +
  'one\r\n' +
  `--${boundary}\r\n` +
  'Content-Disposition: form-data; name="tag"\r\n\r\n' +
  'two\r\n' +
  `--${boundary}\r\n` +
  'Content-Disposition: form-data; name="upload"; filename="报告 \\"v1\\".txt"\r\n' +
  'Content-Type: text/plain\r\n\r\n' +
  '文件内容，包含类似 boundary 的前缀 --demo-bound 原样保留。\r\n' +
  `--${boundary}--\r\n`;

// 模拟网络输入：把正文切成不规则小块的异步字节流
const data = new TextEncoder().encode(body);
const chunks: Uint8Array[] = [];
for (let i = 0; i < data.length; i += 7) chunks.push(data.slice(i, i + 7));

const parser = new MultipartParser(boundary, Readable.from(chunks));

for await (const part of parser) {
  if (part.type === 'file') {
    let size = 0;
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of part.stream) {
      size += (chunk as Uint8Array).length;
      text += decoder.decode(chunk as Uint8Array, { stream: true });
    }
    text += decoder.decode();
    console.log(`file  name=${part.name} filename=${part.filename} type=${part.contentType} bytes=${size}`);
    console.log(`      content=${text}`);
  } else {
    console.log(`field name=${part.name} value=${part.value}`);
  }
}
console.log(`total bytes read: ${parser.bytesRead}`);
