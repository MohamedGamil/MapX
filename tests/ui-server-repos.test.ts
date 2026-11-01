import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { repoScope, startUiServer } from '../src/ui-server.js';
import { initAndScanMultiRepo, multiRepoWorkspace } from '../scripts/ui/workspace.js';
import { Store } from '../src/core/store.js';

// M4-21: the dashboard API across a workspace of three registered repos (primary, web, api).
describe('dashboard API on a three-repo workspace', () => {
  let root: string;
  let primary: string;
  let server: Server;
  let base: string;
  let store: Store;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mapx-ui-repos-'));
    primary = basename(root);
    multiRepoWorkspace(root);
    initAndScanMultiRepo(root);
    store = new Store(join(root, '.mapx/mapx.db'));
    server = startUiServer({ port: 0, host: '127.0.0.1', dir: root }) as unknown as Server;
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);
  afterAll(async () => {
    store?.close();
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  });
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() as any };
  };
  const one = (sql: string, ...params: unknown[]) => Number(Object.values(store.raw.prepare(sql).get(...params) as object)[0]);

  it('/api/repos lists every repo with the store\'s counts, last scan and git state', async () => {
    const { status, body } = await get('/api/repos');
    expect(status).toBe(200);
    expect(body.primary).toBe(primary);
    expect(body.repos.map((r: any) => r.name).sort()).toEqual(['api', primary, 'web'].sort());
    for (const r of body.repos) {
      expect(r.files, r.name).toBe(one('SELECT COUNT(*) FROM files WHERE repo = ?', r.name));
      expect(r.symbols, r.name).toBe(one('SELECT COUNT(*) FROM symbols WHERE repo = ?', r.name));
      expect(r.edges, r.name).toBe(one('SELECT COUNT(*) FROM edges WHERE repo = ?', r.name));
      expect(r.files, r.name).toBeGreaterThan(0);
      expect(r.lastScanned, r.name).toMatch(/^\d{4}-/);
      expect(r.path).toBe(r.name === primary ? '.' : r.name);
    }
    const web = body.repos.find((r: any) => r.name === 'web');
    expect(web.git).toMatchObject({ isGit: true });
    expect(web.crossRepoEdgeCount).toBe(3); // the three paired http calls (M2-06-R3)
    expect(body.crossRepo).toEqual([{ from: 'web', to: 'api', count: 3, types: ['http'] }]);
  });

  it('the graph covers every repo by default, one repo with ?repo=, and marks cross-repo edges', async () => {
    const files = (els: any[]) => els.filter((e) => e.data.type === 'file').map((e) => e.data.id as string);
    const all = (await get('/api/graph')).body;
    expect(files(all)).toHaveLength(one('SELECT COUNT(*) FROM files'));
    const cross = all.filter((e: any) => e.data.crossRepo);
    expect(cross.map((e: any) => [e.data.source, e.data.target, e.data.repo, e.data.targetRepo])).toEqual([
      ['web/src/api/orders.ts', 'api/app/Http/Controllers/OrderController.php', 'web', 'api'],
    ]);
    expect(all.find((e: any) => e.data.id === 'web/src/main.ts').data.repo).toBe('web');
    const web = (await get('/api/graph?repo=web')).body;
    expect(files(web).sort()).toEqual(['web/src/api/orders.ts', 'web/src/components/Orders.vue', 'web/src/main.ts']);
    // Only edges between the repo's own files.
    for (const e of web.filter((x: any) => x.data.source)) expect(files(web)).toEqual(expect.arrayContaining([e.data.source, e.data.target]));
    expect(web.some((e: any) => e.data.crossRepo)).toBe(false);
    expect((await get('/api/graph?repo=all')).body).toHaveLength(all.length);
  });

  it('symbols and routes default to every repo and filter with ?repo=', async () => {
    const all = (await get('/api/symbols?q=*&limit=200')).body;
    expect(all.total).toBe(one('SELECT COUNT(*) FROM symbols'));
    const api = (await get('/api/symbols?q=*&limit=200&repo=api')).body;
    expect(api.total).toBe(one("SELECT COUNT(*) FROM symbols WHERE repo = 'api'"));
    expect(api.results.every((s: any) => s.file_path.startsWith('api/'))).toBe(true);
    const routes = (await get('/api/routes')).body.routes;
    expect(routes.map((r: any) => `${r.method} ${r.path}`).sort()).toEqual(['DELETE /api/orders/{order}', 'GET /api/orders', 'GET /api/orders/{order}', 'POST /api/orders']);
    expect((await get('/api/routes?repo=api')).body.routes).toHaveLength(4);
    expect((await get('/api/routes?repo=web')).body.routes).toHaveLength(0);
  });

  it('clusters, smells, profile, DSM and metrics default to the primary repo and take ?repo=', async () => {
    for (const repo of ['web', 'api']) {
      const clusters = (await get(`/api/clusters?repo=${repo}`)).body;
      expect(clusters.memberships.length, repo).toBeGreaterThan(0);
      expect(clusters.memberships.every((m: any) => m.filePath.startsWith(`${repo}/`)), repo).toBe(true);
      const profile = (await get(`/api/profile?repo=${repo}`)).body;
      expect(profile.repo).toBe(repo);
      expect(profile.profile).toEqual(JSON.parse(store.getMeta('codebase_profile:' + repo)!));
      expect((await get(`/api/dsm?repo=${repo}`)).body.repo).toBe(repo);
      const metrics = (await get(`/api/metrics?repo=${repo}`)).body;
      expect(metrics).toMatchObject({ repo, totalFiles: store.getFileCount(repo), totalSymbols: store.getSymbolCount(repo), totalEdges: store.getEdgeCount(repo) });
      expect(metrics.fileMetrics.every((f: any) => f.path.startsWith(`${repo}/`)), repo).toBe(true);
      expect(metrics.topFiles.every((f: any) => f.path.startsWith(`${repo}/`)), repo).toBe(true);
      const smells = (await get(`/api/smells?repo=${repo}`)).body.smells;
      expect(smells).toEqual(store.getArchSmells(repo));
    }
    expect((await get('/api/profile')).body.repo).toBe(primary);
    expect((await get('/api/metrics')).body.repo).toBe(primary);
    const allClusters = (await get('/api/clusters?repo=all')).body.memberships;
    expect(new Set(allClusters.map((m: any) => m.repo))).toEqual(new Set(['web', 'api', primary]));
  });

  it('answers an unknown repo with 404, and a per-repo view asked for all repos with 400', async () => {
    for (const path of ['/api/graph?repo=nope', '/api/symbols?repo=nope', '/api/routes?repo=nope', '/api/metrics?repo=nope', '/api/clusters?repo=nope']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.error).toBe('Unknown repo: nope');
    }
    for (const path of ['/api/profile?repo=all', '/api/dsm?repo=all', '/api/metrics?repo=all']) expect((await get(path)).status, path).toBe(400);
  });

  it('repoScope: defaults, all, and unknown names', () => {
    const config = { repo: { name: 'main', path: '.' }, repos: [{ name: 'main', path: '.' }, { name: 'web', path: 'web' }] };
    expect(repoScope(null, config, 'all')).toEqual({ all: true });
    expect(repoScope('', config, 'primary')).toEqual({ all: false, name: 'main' });
    expect(repoScope('web', config, 'all')).toEqual({ all: false, name: 'web' });
    expect(repoScope('all', config, 'primary')).toEqual({ all: true });
    expect(repoScope('nope', config, 'all')).toEqual({ error: 'Unknown repo: nope', status: 404 });
  });
});
