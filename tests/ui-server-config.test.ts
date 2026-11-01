import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startUiServer } from '../src/ui-server.js';
import { describeConfig } from '../src/core/config-report.js';
import { Config } from '../src/core/config.js';
import { cleanup, init, workspace } from './helpers/e2e.js';

// M4-22: the dashboard's read-only view of the effective configuration.
describe('/api/config', () => {
  let root: string;
  let server: Server;
  let base: string;
  let configText: string;
  beforeAll(async () => {
    root = workspace({ 'src/a.ts': 'export const a = 1;\n' });
    init(root);
    const path = join(root, '.mapx/config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.settings.excludePatterns.push('custom/generated/**');
    config.settings.parseWorkers = 'lots';
    config.settings.php = { facadeMap: { Cart: 'App\\Services\\Cart' } };
    config.settings.http = { hosts: ['api.example.test'] };
    config.settings.colour = 'blue';
    config.repos.push({ name: 'ghost', path: 'missing-dir' });
    config.languages = { toy: { extensions: [], grammarWasm: '', queries: {}, nodeMappings: {} } };
    writeFileSync(path, JSON.stringify(config, null, 2));
    configText = readFileSync(path, 'utf8');
    server = startUiServer({ port: 0, host: '127.0.0.1', dir: root }) as unknown as Server;
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    cleanup(root);
  });

  it('returns every known setting with its value and source, the repos and user languages', async () => {
    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.path).toBe(join(root, '.mapx/config.json'));
    const setting = (key: string) => body.settings.find((s: any) => s.key === key);
    expect(body.settings.map((s: any) => s.key)).toEqual(['maxTokenBudget', 'excludePatterns', 'includePatterns', 'graphExcludePatterns', 'laravelDefaultExcludes', 'parseWorkers', 'php', 'http', 'architecture']);
    expect(setting('maxTokenBudget')).toMatchObject({ value: 16384, source: 'default' });
    expect(setting('excludePatterns').source).toBe('user');
    expect(setting('excludePatterns').entries).toContainEqual({ value: 'custom/generated/**', source: 'user' });
    expect(setting('excludePatterns').entries).toContainEqual({ value: 'node_modules/**', source: 'default' });
    expect(setting('graphExcludePatterns').source).toBe('default');
    expect(setting('laravelDefaultExcludes')).toMatchObject({ value: true, source: 'default' });
    expect(setting('php')).toMatchObject({ value: { facadeMap: { Cart: 'App\\Services\\Cart' } }, source: 'user' });
    expect(setting('http')).toMatchObject({ value: { hosts: ['api.example.test'] }, source: 'user' });
    expect(setting('parseWorkers')).toMatchObject({ value: 'lots', source: 'user' });
    expect(body.repos.map((r: any) => [r.name, r.exists, r.primary])).toEqual([[expect.any(String), true, true], ['ghost', false, false]]);
    expect(body.languages).toEqual([{ name: 'toy', extensions: [], grammarWasm: '', queries: [] }]);
  });

  it('warns about invalid values, unknown settings, missing repo folders and incomplete languages', async () => {
    const body = await (await fetch(`${base}/api/config`)).json() as any;
    expect(body.warnings).toEqual([
      'settings.parseWorkers: expected "auto" or a whole number ≥ 0; "auto" is used (found "lots")',
      'settings.colour: unknown setting; MapX ignores it',
      'repos: "ghost" points to missing-dir, which does not exist',
      'languages.toy: no file extensions',
      'languages.toy: no grammarWasm',
    ]);
  });

  it('has no write method: POST, PUT, PATCH and DELETE answer 405 and leave the file alone', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/config`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : JSON.stringify({ settings: { maxTokenBudget: 1 } }) });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
    expect(readFileSync(join(root, '.mapx/config.json'), 'utf8')).toBe(configText);
  });

  it('reports MAPX_PARSE_WORKERS as the source of parseWorkers when set', async () => {
    const report = describeConfig(root, await Config.load(root), { MAPX_PARSE_WORKERS: '3' });
    expect(report.settings.find((s) => s.key === 'parseWorkers')).toMatchObject({ value: '3', source: 'env' });
    const bad = describeConfig(root, await Config.load(root), { MAPX_PARSE_WORKERS: 'x' });
    expect(bad.warnings).toContain('MAPX_PARSE_WORKERS: expected "auto" or a whole number ≥ 0 (found "x")');
  });
});
