import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';

// M0-03-R2: the metrics / edges surface promised by F03/F05 and the stub's tool list.
type Edge = { sourceFile: string; targetFile: string; type: string; verifiability: string };

describe('metrics and edges surface', () => {
  let root: string;
  let client: Client;
  beforeAll(async () => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Models/BaseModel.php': '<?php\nnamespace App\\Models;\nclass BaseModel {}\n',
      'app/Models/Team.php': '<?php\nnamespace App\\Models;\nclass Team extends BaseModel {}\n',
      'app/Models/Post.php': '<?php\nnamespace App\\Models;\nclass Post extends BaseModel {}\n',
      'app/Models/User.php': [
        '<?php',
        'namespace App\\Models;',
        'class User extends BaseModel {',
        '  public function team() { return $this->belongsTo(Team::class); }',
        '  public function posts() { return $this->hasMany(Post::class); }',
        '}',
      ].join('\n'),
      'app/Http/Controllers/UserController.php': '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\User;\nclass UserController { public function index() { return User::all(); } public function store() {} }\n',
      'routes/api.php': [
        '<?php',
        'use App\\Http\\Controllers\\UserController;',
        "Route::get('/users', [UserController::class, 'index']);",
        "Route::post('/users', 'UserController@store');",
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
  }, 90000);
  afterAll(async () => {
    await client?.close();
    cleanup(root);
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: { dir: root, ...args } })) as any).content[0].text as string;

  it('metrics --format=json --top 5: five entries ranked by total degree, each with pagerank', () => {
    const top = JSON.parse(mapx(root, 'metrics', '--format=json', '--top', '5'));
    expect(top).toHaveLength(5);
    for (const m of top) {
      expect(m.totalDegree).toBe(m.afferent + m.efferent);
      expect(typeof m.pagerank).toBe('number');
    }
    expect(top.map((m: { totalDegree: number }) => m.totalDegree)).toEqual([...top.map((m: { totalDegree: number }) => m.totalDegree)].sort((a, b) => b - a));
    expect(top[0].path).toBe('app/Models/User.php');
    expect(top.some((m: { pagerank: number }) => m.pagerank > 0)).toBe(true);
  });

  it('mapx_metrics accepts format and top', async () => {
    const top = JSON.parse(await call('mapx_metrics', { format: 'json', top: 3 }));
    expect(top).toHaveLength(3);
    expect(top[0]).toMatchObject({ path: 'app/Models/User.php' });
    expect(top[0]).toHaveProperty('pagerank');
  });

  it('edges <file> --direction outgoing --type relation,extends --verified-only --format=json', () => {
    const args = ['--direction', 'outgoing', '--type', 'relation,extends', '--verified-only', '--format=json'];
    const rel: Edge[] = JSON.parse(mapx(root, 'edges', 'app/Models/User.php', ...args));
    expect(rel.map((e) => `${e.type} ${e.targetFile}`).sort()).toEqual([
      'extends app/Models/BaseModel.php',
      'relation app/Models/Post.php',
      'relation app/Models/Team.php',
    ]);
    expect(rel.every((e) => e.sourceFile === 'app/Models/User.php')).toBe(true);
    // absolute paths work the same
    expect(JSON.parse(mapx(root, 'edges', join(root, 'app/Models/User.php'), ...args))).toEqual(rel);
    // incoming only
    const incoming: Edge[] = JSON.parse(mapx(root, 'edges', 'app/Models/User.php', '--direction', 'incoming', '--format=json'));
    expect(incoming.length).toBeGreaterThan(0);
    expect(incoming.every((e) => e.targetFile === 'app/Models/User.php')).toBe(true);
    // --verified-only drops the inferred string-handler route
    const routes = (verified: boolean): Edge[] =>
      JSON.parse(mapx(root, 'edges', 'routes/api.php', '--type', 'route', '--format=json', ...(verified ? ['--verified-only'] : [])));
    expect(routes(false).some((e) => e.verifiability === 'inferred')).toBe(true);
    expect(routes(true).length).toBeGreaterThan(0);
    expect(routes(true).every((e) => e.verifiability === 'verified')).toBe(true);
  });

  it('mapx_edges returns JSON by default', async () => {
    const edges: Edge[] = JSON.parse(await call('mapx_edges', { file: 'app/Models/User.php', direction: 'outgoing', type: 'relation' }));
    expect(edges.map((e) => e.targetFile).sort()).toEqual(['app/Models/Post.php', 'app/Models/Team.php']);
  });

  it('status help points to mapx metrics; the agents stub lists every MCP tool', async () => {
    expect(mapx(root, 'status', '--help')).toContain('mapx metrics');
    const stub = readFileSync(join(__dirname, '../src/agents.stub.md'), 'utf8');
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.length).toBeGreaterThanOrEqual(32);
    for (const t of tools) expect(stub, t).toContain(`\`${t}\``);
  });
});
