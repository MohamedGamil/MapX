import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, init, mapx, mapxResult, workspace } from './helpers/e2e.js';

// M0-03-R2 / M0-03-R3: the metrics / edges surface (F02, F04) in the output contract of D012:
// spec structures with camelCase keys. Real CLI and a real MCP client on scanned workspaces.

type Row = { path: string; language: string; inDegree: number; outDegree: number; totalDegree: number; instability: number; pagerank: number };
type Report = { dir: string; generatedAt: string; summary: { files: number; edges: number; density: number }; files: Row[] };
type In = { sourceFile: string; type: string; sourceSymbol: string | null; targetSymbol: string | null; verifiability: string; weight: number; line: number | null };
type Out = Omit<In, 'sourceFile'> & { targetFile: string; targetRepo: string | null };
type Neighbourhood = { file: string; direction: string; incoming: In[]; outgoing: Out[] };

async function mcpClient(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('metrics and edges surface (Laravel fixture)', () => {
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
    client = await mcpClient();
  }, 90000);
  afterAll(async () => {
    await client?.close();
    cleanup(root);
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: { dir: root, ...args } })) as any).content[0].text as string;

  it('metrics --format=json --top 5: five rows ranked by total degree, each with pagerank', () => {
    const top: Report = JSON.parse(mapx(root, 'metrics', '--format=json', '--top', '5'));
    expect(top.files).toHaveLength(5);
    for (const m of top.files) {
      expect(m.totalDegree).toBe(m.inDegree + m.outDegree);
      expect(typeof m.pagerank).toBe('number');
    }
    const degrees = top.files.map((m) => m.totalDegree);
    expect(degrees).toEqual([...degrees].sort((a, b) => b - a));
    expect(top.files[0].path).toBe('app/Models/User.php');
    expect(top.files.some((m) => m.pagerank > 0)).toBe(true);
  });

  it('mapx_metrics accepts format and top', async () => {
    const top: Report = JSON.parse(await call('mapx_metrics', { format: 'json', top: 3 }));
    expect(top.files).toHaveLength(3);
    expect(top.files[0]).toMatchObject({ path: 'app/Models/User.php' });
    expect(top.files[0]).toHaveProperty('pagerank');
  });

  it('edges <file> --direction outgoing --type relation,extends --verified-only --format=json', () => {
    const args = ['--direction', 'outgoing', '--type', 'relation,extends', '--verified-only', '--format=json'];
    const rel: Neighbourhood = JSON.parse(mapx(root, 'edges', 'app/Models/User.php', ...args));
    expect(rel).toMatchObject({ file: 'app/Models/User.php', direction: 'outgoing', incoming: [] });
    expect(rel.outgoing.map((e) => `${e.type} ${e.targetFile}`).sort()).toEqual([
      'extends app/Models/BaseModel.php',
      'relation app/Models/Post.php',
      'relation app/Models/Team.php',
    ]);
    // absolute paths work the same
    expect(JSON.parse(mapx(root, 'edges', join(root, 'app/Models/User.php'), ...args))).toEqual(rel);
    // incoming only
    const incoming: Neighbourhood = JSON.parse(mapx(root, 'edges', 'app/Models/User.php', '--direction', 'incoming', '--format=json'));
    expect(incoming.incoming.map((e) => e.sourceFile)).toContain('app/Http/Controllers/UserController.php');
    expect(incoming.outgoing).toEqual([]);
    // --verified-only drops the inferred string-handler route
    const routes = (verified: boolean): Out[] =>
      JSON.parse(mapx(root, 'edges', 'routes/api.php', '--type', 'route', '--format=json', ...(verified ? ['--verified-only'] : []))).outgoing;
    expect(routes(false).some((e) => e.verifiability === 'inferred')).toBe(true);
    expect(routes(true).length).toBeGreaterThan(0);
    expect(routes(true).every((e) => e.verifiability === 'verified')).toBe(true);
  });

  it('mapx_edges returns JSON by default', async () => {
    const edges: Neighbourhood = JSON.parse(await call('mapx_edges', { file: 'app/Models/User.php', direction: 'outgoing', type: 'relation' }));
    expect(edges.outgoing.map((e) => e.targetFile).sort()).toEqual(['app/Models/Post.php', 'app/Models/Team.php']);
  });

  it('status help points to mapx metrics; the agents stub lists every MCP tool', async () => {
    expect(mapx(root, 'status', '--help')).toContain('mapx metrics');
    const stub = readFileSync(join(__dirname, '../src/agents.stub.md'), 'utf8');
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.length).toBeGreaterThanOrEqual(32);
    for (const t of tools) expect(stub, t).toContain(`\`${t}\``);
  });
});

// M0-03-R3, synthetic fixture: api → service → store with one inferred call, an isolated file and
// 22 leaf files so the default --top 20 truncates. 26 files, 6 edges.
describe('D012 output contract (synthetic TS fixture)', () => {
  let root: string;
  let client: Client;
  const leaves = Object.fromEntries(
    Array.from({ length: 22 }, (_, i) => [`src/leaves/leaf${String(i + 1).padStart(2, '0')}.ts`, `export const leaf${i + 1} = ${i + 1};\n`]),
  );
  beforeAll(async () => {
    root = workspace({
      'src/store.ts': 'export class Store {\n  save() { return 1; }\n}\n',
      'src/service.ts': "import { Store } from './store';\nexport class Service {\n  s = new Store();\n  run(repo: any) { return repo.save(); }\n}\n",
      'src/api.ts': "import { Service } from './service';\nimport { Store } from './store';\nexport function handler() { return new Service(); }\n",
      'src/lonely.ts': 'export const lonely = 1;\n',
      ...leaves,
    });
    init(root);
    mapx(root, 'scan', root);
    client = await mcpClient();
  }, 90000);
  afterAll(async () => {
    await client?.close();
    cleanup(root);
  });
  const callRaw = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { dir: root, ...args } })) as { isError?: boolean; content: Array<{ text: string }> };
  const call = async (name: string, args: Record<string, unknown>) => (await callRaw(name, args)).content[0].text;
  const tableRows = (text: string) => text.split('\n').filter((l) => /^\s+\d+\s{2}\S/.test(l));

  it('metrics --format json is the D012 envelope; mapx_metrics returns the same', async () => {
    const report: Report = JSON.parse(mapx(root, 'metrics', '--format', 'json'));
    expect(Object.keys(report)).toEqual(['dir', 'generatedAt', 'summary', 'files']);
    expect(report.dir).toBe(root);
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
    expect(report.summary).toEqual({ files: 26, edges: 6, density: Number((6 / (26 * 25)).toPrecision(3)) });
    expect(report.files).toHaveLength(20); // F02 default --top 20
    expect(Object.keys(report.files[0])).toEqual(['path', 'language', 'inDegree', 'outDegree', 'totalDegree', 'instability', 'pagerank']);
    const byPath = new Map(report.files.map((f) => [f.path, f]));
    expect(byPath.get('src/store.ts')).toMatchObject({ language: 'typescript', inDegree: 2, outDegree: 0, totalDegree: 2, instability: 0 });
    expect(byPath.get('src/service.ts')).toMatchObject({ inDegree: 1, outDegree: 1, totalDegree: 2, instability: 0.5 });
    expect(byPath.get('src/api.ts')).toMatchObject({ inDegree: 0, outDegree: 2, totalDegree: 2, instability: 1 });
    expect(report.files.slice(0, 3).map((f) => f.path).sort()).toEqual(['src/api.ts', 'src/service.ts', 'src/store.ts']);

    const all: Report = JSON.parse(mapx(root, 'metrics', '--format', 'json', '--top', '0'));
    expect(all.files).toHaveLength(26);
    expect(all.files.map((f) => f.path)).toContain('src/lonely.ts');
    // --verified-only drops the inferred service → store call from the counted edges
    expect(JSON.parse(mapx(root, 'metrics', '--format', 'json', '--verified-only')).summary.edges).toBe(5);

    const viaMcp: Report = JSON.parse(await call('mapx_metrics', { format: 'json' }));
    expect({ ...viaMcp, generatedAt: '' }).toEqual({ ...report, generatedAt: '' });
  });

  it('metrics text: F02 table, 20 rows by default, --top 0 lists every file, --exclude drops files', async () => {
    const text = mapx(root, 'metrics');
    expect(text).toContain(`Metrics for: ${root}   (last scan: `);
    expect(text).toContain(`Files: 26 | Edges: 6 | Graph density: ${Number((6 / 650).toPrecision(3))}`);
    expect(text).toContain('Top coupled files (by total degree):');
    expect(text).toMatch(/^ {2}RANK {2}FILE +IN {2}OUT {2}TOTAL {2}INSTABILITY$/m);
    expect(text).toMatch(/^ {5}1 {2}src\/store\.ts +2 +0 +2 +0\.00$/m);
    expect(text).toMatch(/^ +\d {2}src\/api\.ts +0 +2 +2 +1\.00$/m);
    expect(tableRows(text)).toHaveLength(20);
    expect(text).toContain('... 6 more (--top 0 lists every file)');
    expect(text).toContain('Instability = out / (in + out).  Range: 0 (stable) → 1 (unstable).');
    expect(text).toContain('High out-degree → many outgoing deps (potential God Class / low cohesion).');

    expect(tableRows(mapx(root, 'metrics', '--top', '0'))).toHaveLength(26);

    const noApi = mapx(root, 'metrics', '--exclude', 'src/api.ts');
    expect(noApi).toContain('Files: 25 | Edges: 3 |');
    expect(noApi).not.toContain('src/api.ts');
    expect(noApi).toMatch(/^ {5}1 {2}src\/(store|service)\.ts +1 /m);
    const core = tableRows(mapx(root, 'metrics', '--exclude', 'leaves,src/lonely.ts'));
    expect(core.map((l) => l.trim().split(/\s+/)[1]).sort()).toEqual(['src/api.ts', 'src/service.ts', 'src/store.ts']);

    const viaMcp = await call('mapx_metrics', { top: 0, exclude: 'leaves' });
    expect(viaMcp).toMatch(/^ {2}RANK {2}FILE +IN {2}OUT {2}TOTAL {2}INSTABILITY$/m);
    expect(tableRows(viaMcp)).toHaveLength(4);
  });

  const serviceIncoming: In[] = [
    { sourceFile: 'src/api.ts', type: 'import', sourceSymbol: null, targetSymbol: './service', verifiability: 'verified', weight: 1, line: 1 },
    { sourceFile: 'src/api.ts', type: 'instantiation', sourceSymbol: 'handler', targetSymbol: 'Service', verifiability: 'verified', weight: 1, line: 3 },
  ];
  const serviceOutgoing: Out[] = [
    { targetFile: 'src/store.ts', targetRepo: null, type: 'call', sourceSymbol: 'Service::run', targetSymbol: 'save', verifiability: 'inferred', weight: 1, line: 4 },
    { targetFile: 'src/store.ts', targetRepo: null, type: 'import', sourceSymbol: null, targetSymbol: './store', verifiability: 'verified', weight: 1, line: 1 },
    { targetFile: 'src/store.ts', targetRepo: null, type: 'instantiation', sourceSymbol: 'Service::s', targetSymbol: 'Store', verifiability: 'verified', weight: 1, line: 3 },
  ];

  it('edges <file> --format json is F04\'s neighbourhood; direction empties the other side; no file keeps the flat list', async () => {
    const both: Neighbourhood = JSON.parse(mapx(root, 'edges', 'src/service.ts', '--format', 'json'));
    expect(both).toEqual({ file: 'src/service.ts', direction: 'both', incoming: serviceIncoming, outgoing: serviceOutgoing });
    expect(Object.keys(both.outgoing[0])).toEqual(['targetFile', 'targetRepo', 'type', 'sourceSymbol', 'targetSymbol', 'verifiability', 'weight', 'line']);

    expect(JSON.parse(mapx(root, 'edges', 'src/service.ts', '--format', 'json', '--direction', 'incoming')))
      .toEqual({ file: 'src/service.ts', direction: 'incoming', incoming: serviceIncoming, outgoing: [] });
    expect(JSON.parse(mapx(root, 'edges', 'src/service.ts', '--format', 'json', '--direction', 'outgoing')))
      .toEqual({ file: 'src/service.ts', direction: 'outgoing', incoming: [], outgoing: serviceOutgoing });

    expect(JSON.parse(await call('mapx_edges', { file: 'src/service.ts' }))).toEqual(both);

    const flat = JSON.parse(mapx(root, 'edges', '--from', 'src/api.ts', '--format', 'json'));
    expect(Array.isArray(flat)).toBe(true);
    expect(flat.map((e: { sourceFile: string; targetFile: string; type: string }) => `${e.sourceFile} ${e.type} ${e.targetFile}`)).toEqual([
      'src/api.ts import src/service.ts',
      'src/api.ts instantiation src/service.ts',
      'src/api.ts import src/store.ts',
    ]);
  });

  it('edges <file> text: Incoming / Outgoing sections with arrows, a message when there are none', async () => {
    const text = mapx(root, 'edges', 'src/service.ts');
    expect(text).toContain([
      'Edges for: src/service.ts',
      '',
      '  Incoming (2):',
      '    ← src/api.ts  [import]  ./service',
      '    ← src/api.ts  [instantiation]  Service',
      '',
      '  Outgoing (3):',
      '    → src/store.ts  [call]  save  (inferred)',
      '    → src/store.ts  [import]  ./store',
      '    → src/store.ts  [instantiation]  Store',
    ].join('\n'));
    expect(mapx(root, 'edges', 'src/service.ts', '--direction', 'incoming')).not.toContain('Outgoing');

    const lonely = mapxResult(root, 'edges', 'src/lonely.ts');
    expect(lonely.status).toBe(0);
    expect(lonely.stdout).toContain('No edges for src/lonely.ts.');
    expect(JSON.parse(mapx(root, 'edges', 'src/lonely.ts', '--format', 'json'))).toEqual({ file: 'src/lonely.ts', direction: 'both', incoming: [], outgoing: [] });
    expect(await call('mapx_edges', { file: 'src/lonely.ts', format: 'text' })).toContain('No edges for src/lonely.ts.');
  });

  it('invalid --top / --format values and --direction without a file exit non-zero with a message', async () => {
    const rejects: Array<[string[], RegExp]> = [
      [['metrics', '--top', 'abc'], /Invalid top value "abc"/],
      [['metrics', '--top', '-1'], /Invalid top value "-1"/],
      [['metrics', '--top', '1.5'], /Invalid top value "1\.5"/],
      [['metrics', '--format', 'yaml'], /Unknown format "yaml"/],
      [['edges', 'src/service.ts', '--format', 'yaml'], /Unknown format "yaml"/],
      [['edges', 'src/service.ts', '--direction', 'sideways'], /Unknown direction "sideways"/],
      [['edges', '--direction', 'incoming'], /direction applies to one file's edges/],
      [['edges', 'src/leaves', '--direction', 'incoming'], /direction applies to one file's edges/],
    ];
    for (const [args, message] of rejects) {
      const r = mapxResult(root, ...args);
      expect(r.status, args.join(' ')).not.toBe(0);
      expect(r.stderr, args.join(' ')).toMatch(message);
    }
    for (const [name, args, message] of [
      ['mapx_metrics', { top: -1 }, /Invalid top value "-1"/],
      ['mapx_metrics', { format: 'yaml' }, /Unknown format "yaml"/],
      ['mapx_edges', { direction: 'incoming' }, /direction applies to one file's edges/],
    ] as const) {
      const r = await callRaw(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.content[0].text).toMatch(message);
    }
  });

  it('mapx_edges: type accepts an array; verifiedOnly leaves out inferred edges', async () => {
    const out = async (args: Record<string, unknown>) =>
      (JSON.parse(await call('mapx_edges', { file: 'src/service.ts', direction: 'outgoing', ...args })) as Neighbourhood).outgoing.map((e) => e.type);
    expect(await out({ type: ['call', 'instantiation'] })).toEqual(['call', 'instantiation']);
    expect(await out({ type: 'call,import' })).toEqual(['call', 'import']);
    expect(await out({})).toEqual(['call', 'import', 'instantiation']);
    expect(await out({ verifiedOnly: true })).toEqual(['import', 'instantiation']);
  });
});
