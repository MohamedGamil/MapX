import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startUiServer } from '../src/ui-server.js';
import { describeConfig } from '../src/core/config-report.js';
import { Config } from '../src/core/config.js';
import { cleanup, init, workspace } from './helpers/e2e.js';
import { existsSync } from 'node:fs';

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
    expect(bad.warnings).toContain('MAPX_PARSE_WORKERS: expected "auto" or a whole number ≥ 0 (found "x"); ignored');
    // The pool ignores an invalid value and uses the configured one: so does the report.
    expect(bad.settings.find((s) => s.key === 'parseWorkers')).toMatchObject({ value: 'lots', source: 'user' });
  });

  // D043 (M2-29): an earlier `mapx init` wrote Laravel's former defaults into excludePatterns; they
  // are patterns MapX wrote, not the user's.
  it("reports Laravel's former default excludes, written by an earlier init, as defaults", async () => {
    const other = workspace({ 'app/a.php': '<?php\n' });
    try {
      init(other);
      const path = join(other, '.mapx/config.json');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.settings.excludePatterns.push('database/migrations/**', 'resources/views/**', '**/*.blade.php');
      writeFileSync(path, JSON.stringify(config, null, 2));
      const report = describeConfig(other, await Config.load(other));
      const entries = report.settings.find((s) => s.key === 'excludePatterns')!.entries;
      expect(entries).toContainEqual({ value: 'database/migrations/**', source: 'default' });
      expect(entries).toContainEqual({ value: '**/*.blade.php', source: 'default' });
    } finally {
      cleanup(other);
    }
  });
});

// Review 2026-11-02 of M4-22.
describe('/api/config review fixes', () => {
  let root: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    // A JavaScript project: init adds its extra excludes (JS_INIT_EXCLUDES) to the defaults.
    root = workspace({ 'package.json': '{"name":"fixture"}', 'src/a.ts': 'export const a = 1;\n', 'web/x.ts': 'export const x = 1;\n' });
    init(root);
    server = startUiServer({ port: 0, host: '127.0.0.1', dir: root }) as unknown as Server;
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    cleanup(root);
  });
  const path = () => join(root, '.mapx/config.json');
  const get = async () => (await fetch(`${base}/api/config`)).json() as Promise<any>;

  it('reports a fresh init\'s settings as defaults', async () => {
    const body = await get();
    for (const s of body.settings) expect(s.source, s.key).toBe('default');
    expect(body.settings.find((s: any) => s.key === 'excludePatterns').entries).toContainEqual({ value: '**/__tests__/**', source: 'default' });
    expect(body.warnings).toEqual([]);
  });

  it('never writes: a duplicate repo entry is reported, not saved away', async () => {
    const config = JSON.parse(readFileSync(path(), 'utf8'));
    config.repos.push({ name: 'web', path: 'web' }, { name: 'web-dup', path: './web' });
    writeFileSync(path(), JSON.stringify(config, null, 2));
    const before = readFileSync(path(), 'utf8');
    for (let i = 0; i < 2; i++) {
      const body = await get();
      expect(body.warnings).toContain('repos: "web-dup" names the same folder as "web" and is ignored');
    }
    expect(readFileSync(path(), 'utf8')).toBe(before);
  });

  it('answers a config without settings with a warning, and invalid JSON with 422; never creates one', async () => {
    writeFileSync(path(), JSON.stringify({ version: '1.0.0', repos: [{ name: 'main', path: '.' }], languages: {} }));
    const body = await get();
    expect(body.warnings).toContain('settings: missing from config.json; MapX uses its defaults');
    writeFileSync(path(), '{ not json');
    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(422);
    expect((await res.json() as any).error).toMatch(/not valid JSON/);
    const { rmSync } = await import('node:fs');
    rmSync(path());
    expect((await fetch(`${base}/api/config`)).status).toBe(404);
    expect(existsSync(path())).toBe(false);
  });
});
