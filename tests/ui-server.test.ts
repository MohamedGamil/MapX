import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startUiServer } from '../src/ui-server.js';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';

// M0-39: dashboard server endpoints (/api/status, /api/graph, /api/explain, /api/tool-calls)
// and token auth, against a really scanned workspace.
describe('UI server endpoints', () => {
  let root: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    root = workspace({
      'src/a.ts': "import { b } from './b';\nexport const a = () => b();\n",
      'src/b.ts': 'export function b() { return 1; }\n',
    });
    init(root);
    mapx(root, 'scan', root);
    server = startUiServer({ port: 0, host: '127.0.0.1', dir: root, token: 'secret' }) as unknown as Server;
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60000);
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    cleanup(root);
  });
  const get = (path: string, auth = true) => fetch(base + path, { headers: auth ? { Authorization: 'Bearer secret' } : {} });

  it('serves the logo and favicons as PNG, and the page links them (M4-18)', async () => {
    const repoRoot = resolve(__dirname, '..');
    // CI runs the tests before building the package: build the dashboard when its assets are missing.
    if (!existsSync(join(repoRoot, 'dist/ui/assets/mapx-logo-128.png'))) execFileSync('npm', ['run', '-s', 'build:ui'], { cwd: repoRoot, stdio: 'pipe' });
    for (const asset of ['mapx-logo-128.png', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png']) {
      const res = await get(`/assets/${asset}`, false);
      expect(res.status, asset).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
    }
    const page = await (await get('/', false)).text();
    expect(page).toContain('src="assets/mapx-logo-128.png"');
    expect(page).toContain('href="assets/favicon-32.png"');
  }, 60000);

  it('rejects API calls without the token', async () => {
    expect((await get('/api/status', false)).status).toBe(401);
  });

  it('serves status and graph data for the scanned workspace', async () => {
    const status = await get('/api/status');
    expect(status.status).toBe(200);
    const graph = await get('/api/graph');
    expect(graph.status).toBe(200);
    const body = JSON.stringify(await graph.json());
    expect(body).toContain('src/a.ts');
    expect(body).toContain('src/b.ts');
  });

  it('serves /api/metrics fileMetrics as D012 file rows (M0-03-R3)', async () => {
    const res = await get('/api/metrics');
    expect(res.status).toBe(200);
    const { fileMetrics } = (await res.json()) as { fileMetrics: Array<{ path: string }> };
    const b = fileMetrics.find((f) => f.path === 'src/b.ts')!;
    expect(Object.keys(b)).toEqual(['path', 'language', 'inDegree', 'outDegree', 'totalDegree', 'instability', 'pagerank']);
    expect(b).toMatchObject({ inDegree: 1, outDegree: 0, totalDegree: 1, instability: 0 });
  });

  it('serves explain signals and paged tool calls as JSON', async () => {
    const explain = await get('/api/explain?file=src/a.ts');
    expect(explain.status).toBe(200);
    expect(await explain.json()).toHaveProperty('signals');
    const calls = await get('/api/tool-calls?limit=5');
    expect(calls.status).toBe(200);
    expect(await calls.json()).toMatchObject({ total: expect.any(Number) });
  });
});
