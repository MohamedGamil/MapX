import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { pickEncoding, startUiServer } from '../src/ui-server.js';
import { generate } from '../scripts/ui/workspace.js';
import { init, mapx } from './helpers/e2e.js';

// M4-20, criterion 3: /api/graph for the generated 2,000-file fixture goes out compressed and at
// least 30% smaller on the wire than the M4-16 baseline, which sent it as 998 KB of plain JSON
// (docs/research/dashboard-ux-audit.md).
const BASELINE_WIRE_BYTES = 998 * 1024;

/** The raw response: status, headers and bytes as sent, without decompressing. */
function raw(base: string, path: string, acceptEncoding?: string) {
  return new Promise<{ status: number; headers: Record<string, any>; body: Buffer }>((resolve, reject) => {
    const req = request(base + path, { headers: { ...(acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('dashboard responses are compressed (M4-20)', () => {
  let root: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mapx-compress-'));
    generate(root, 2000);
    init(root);
    mapx(root, 'scan', root);
    server = startUiServer({ port: 0, host: '127.0.0.1', dir: root }) as unknown as Server;
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 300_000);
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  it('sends the 2,000-file graph compressed, at least 30% smaller than the baseline, with the same JSON', async () => {
    const plain = await raw(base, '/api/graph');
    expect(plain.headers['content-encoding']).toBeUndefined();
    const graph = JSON.parse(plain.body.toString());
    expect(graph.filter((e: any) => e.data.type === 'file')).toHaveLength(2000);
    for (const [accept, decode] of [['gzip', gunzipSync], ['gzip, deflate, br', brotliDecompressSync]] as const) {
      const res = await raw(base, '/api/graph', accept);
      expect(res.headers['content-encoding']).toBe(accept === 'gzip' ? 'gzip' : 'br');
      expect(res.headers.vary).toBe('Accept-Encoding');
      expect(Number(res.headers['content-length'])).toBe(res.body.length);
      expect(res.body.length, `${accept} wire bytes`).toBeLessThanOrEqual(BASELINE_WIRE_BYTES * 0.7);
      expect(decode(res.body).equals(plain.body)).toBe(true);
    }
  });

  it('compresses scripts and styles, and leaves small bodies alone', async () => {
    const page = await raw(base, '/', 'br');
    if (page.status === 200) expect(page.headers['content-encoding']).toBe('br');
    const status = await raw(base, '/api/graph/meta', 'gzip');
    expect(status.headers['content-encoding']).toBeUndefined(); // under 1 KB
  });

  it('honours the client\'s Accept-Encoding', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
  });
});
