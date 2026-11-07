import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUiServer } from '../src/ui-server.js';
import { cli, initAndScanMultiRepo, multiRepoWorkspace } from '../scripts/ui/workspace.js';

// M4-23: /api/http on a workspace whose web repo (axios) calls the api repo (Laravel): the calls
// per repo pair and the unmatched calls equal `mapx routes --clients --json` and `--unmatched`.
describe('/api/http', () => {
  let root: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mapx-ui-http-'));
    multiRepoWorkspace(root);
    initAndScanMultiRepo(root);
    server = startUiServer({ port: 0, host: '127.0.0.1', dir: root }) as unknown as Server;
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  const strip = ({ callerRepo, handlerRepo, callerCode, handlerLine, ...record }: any) => record;
  const key = (c: any) => `${c.file}:${c.line}:${c.method}`;
  const sorted = (xs: any[]) => [...xs].sort((a, b) => key(a).localeCompare(key(b)));

  it('groups the calls per repo pair, and they equal mapx routes --clients --json', async () => {
    const body = await (await fetch(`${base}/api/http`)).json() as any;
    expect(body).toMatchObject({ total: 4, matched: 3 });
    expect(body.pairs.map((p: any) => [p.from, p.to, p.count])).toEqual([['web', 'api', 3]]);
    const cliCalls = JSON.parse(cli(root, 'routes', root, '--clients', '--json'));
    const matched = cliCalls.filter((c: any) => c.route);
    expect(sorted(body.pairs.flatMap((p: any) => p.calls).map(strip))).toEqual(sorted(matched));
    for (const c of body.pairs[0].calls) {
      expect(c).toMatchObject({ callerRepo: 'web', handlerRepo: 'api' });
      expect(c.route.handlerFile).toBe('api/app/Http/Controllers/OrderController.php');
      expect(c.callerCode).toContain('axios.');
      expect(c.handlerLine).toBeGreaterThan(0);
    }
  });

  it('lists the unmatched calls per repo, equal to --clients --unmatched --json', async () => {
    const body = await (await fetch(`${base}/api/http`)).json() as any;
    expect(body.unmatched.map((u: any) => [u.repo, u.count])).toEqual([['web', 1]]);
    const cliUnmatched = JSON.parse(cli(root, 'routes', root, '--clients', '--unmatched', '--json'));
    expect(sorted(body.unmatched.flatMap((u: any) => u.calls).map(strip))).toEqual(sorted(cliUnmatched));
    expect(body.unmatched[0].calls[0]).toMatchObject({ url: '/api/nowhere', handlerRepo: null, handlerLine: null });
  });

  it('scopes to a repo with ?repo=, as caller or handler', async () => {
    expect((await (await fetch(`${base}/api/http?repo=api`)).json() as any).matched).toBe(3);
    const primary = (await (await fetch(`${base}/api/repos`)).json() as any).primary;
    expect((await (await fetch(`${base}/api/http?repo=${primary}`)).json() as any).total).toBe(0);
    expect((await fetch(`${base}/api/http?repo=nope`)).status).toBe(404);
  });
});
