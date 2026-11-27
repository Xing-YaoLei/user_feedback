/**
 * Demo: a minimal gateway response path using the encoder.
 *
 *   node src/cli.ts
 *
 * Starts a local server with a few upstream fixtures and prints a handful of
 * `curl` commands to exercise gzip, br, identity, 406 and 206 behaviour.
 * All traffic stays on 127.0.0.1.
 */

import http from 'node:http';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';

import { encodeResponse, NotAcceptableError, createResponseEncoder } from './index.ts';

const encoder = createResponseEncoder({ highWaterMark: 16 * 1024 });

function payload(): Buffer {
  return Buffer.concat([
    Buffer.from('<!doctype html>\n<html><body>\n'),
    Buffer.from('<p>hello from the coding demo</p>\n'.repeat(200)),
    Buffer.from('</body></html>\n'),
  ]);
}

function* chunksOf(buffer: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size);
  }
}

interface Fixture {
  status: number;
  headers: Record<string, string>;
  makeBody: () => AsyncIterable<Buffer>;
}

const fixtures: Record<string, Fixture> = {
  '/text': {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(payload().length),
      etag: '"text-v1"',
      vary: 'Accept-Language',
    },
    makeBody: async function* () {
      for (const chunk of chunksOf(payload(), 1024)) {
        yield chunk;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  },
  '/range': {
    status: 206,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-range': 'bytes 0-1023/65536',
      'content-length': '1024',
      etag: '"text-v1"',
    },
    makeBody: async function* () {
      yield payload().subarray(0, 1024);
    },
  },
  '/already-encoded': {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': String(gzipPayload().length),
      etag: '"gzip-v1"',
    },
    makeBody: async function* () {
      yield gzipPayload();
    },
  },
};

function gzipPayload(): Buffer {
  return zlib.gzipSync(payload());
}

export function createDemoServer(): http.Server {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const fixtureName = url.pathname === '/range' || url.pathname === '/already-encoded' ? url.pathname : '/text';
    const fixture = fixtures[fixtureName];
    if (fixture === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    const acceptEncoding = request.headers['accept-encoding'] ?? '';

    try {
      const encoded = encoder({
        preferences: acceptEncoding,
        response: { status: fixture.status, headers: fixture.headers },
        body: fixture.makeBody(),
      });
      response.writeHead(encoded.status, encoded.headers.toObject());
      for await (const chunk of encoded.body) {
        if (!response.write(chunk)) {
          await new Promise<void>((resolve) => response.once('drain', () => resolve()));
        }
      }
      response.end();
      await encoded.completion;
    } catch (error) {
      if (error instanceof NotAcceptableError) {
        response.writeHead(error.status, error.headers.toObject()).end();
        return;
      }
      // A failure after the first byte can only abort this response: the
      // declared coding and the bytes already sent cannot be taken back.
      response.destroy(error as Error);
    }
  });
}

async function main(): Promise<void> {
  const server = createDemoServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  process.stdout.write(
    [
      `response-coding demo listening on http://127.0.0.1:${port}`,
      '',
      'Try:',
      `  curl -s -D- -o /dev/null -H 'Accept-Encoding: gzip'          http://127.0.0.1:${port}/text`,
      `  curl -s -D- -o /dev/null -H 'Accept-Encoding: br'            http://127.0.0.1:${port}/text`,
      `  curl -s -D- -o /dev/null -H 'Accept-Encoding: identity'      http://127.0.0.1:${port}/text`,
      `  curl -s -D- -o /dev/null -H 'Accept-Encoding: gzip;q=0, br;q=0, identity;q=0' http://127.0.0.1:${port}/text`,
      `  curl -s -D- -o /dev/null -H 'Accept-Encoding: gzip, br'       http://127.0.0.1:${port}/range`,
      `  curl -s -D- -o /dev/null -H 'Accept-Encoding: br;q=0'         http://127.0.0.1:${port}/already-encoded`,
      '',
      'Round-trip check:',
      `  curl -s -H 'Accept-Encoding: gzip' http://127.0.0.1:${port}/text | gunzip | wc -c`,
      '',
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}
