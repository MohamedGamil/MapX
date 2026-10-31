import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, mapx, query, workspace } from './helpers/e2e.js';

// M0-10-R1 / M0-10-R2: the F18 workspace surface. Layout: <tmp>/main is the primary repo with an
// initialised submodule (libs/ui), an uninitialised one (libs/legacy), a JSONC .code-workspace
// naming tools/ (git) and ui-link (a symlink to libs/ui), and a plain package folder
// packages/web (no .git of its own); <tmp>/peer is a sibling repo. Every repo gets its own
// commit, so the HEADs differ.
const files = {
  'main/src/app.ts': "import { Button } from '../libs/ui/button';\nexport const app = () => new Button();\n",
  'main/libs/ui/button.ts': 'export class Button {}\n',
  'main/libs/ui/icon.ts': "import { Button } from './button';\nexport const icon = new Button();\n",
  'main/tools/build.ts': 'export function build() { return 1; }\n',
  'main/packages/web/package.json': '{ "name": "web" }\n',
  'main/packages/web/index.ts': 'export const web = 1;\n',
  'main/.gitmodules': [
    '[submodule "ui"]',
    '\tpath = libs/ui',
    '\turl = https://example.com/ui.git',
    '[submodule "legacy"]',
    '\tpath = libs/legacy',
    '\turl = https://example.com/legacy.git',
  ].join('\n') + '\n',
  'main/main.code-workspace': [
    '// VS Code workspace (JSONC)',
    '{',
    '  "folders": [',
    '    { "path": "." },',
    '    /* the build tooling repo */',
    '    { "path": "tools", "name": "tools" },',
    '    { "path": "ui-link" },',
    '  ],',
    '}',
  ].join('\n'),
  'peer/readme.md': '# peer\n',
};

const commit = (dir: string, message: string) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', message], { cwd: dir });
const head = (dir: string) => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

async function mcpClient(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

// The only cross-repo edges of the fixture: src/app.ts imports and instantiates Button from the ui submodule.
type CrossEdge = { source_file: string; target_file: string; edge_type: string; repo: string; target_repo: string };
const crossEdges = (root: string) => query<CrossEdge>(
  root,
  'SELECT source_file, target_file, edge_type, repo, target_repo FROM edges WHERE target_repo IS NOT NULL AND target_repo != repo ORDER BY edge_type',
);

describe('workspace surface (F18)', () => {
  let tmp: string;
  let root: string;
  let initOut: string;
  let heads: Record<string, string>;
  beforeAll(() => {
    tmp = workspace(files, ['main', 'main/libs/ui', 'main/tools', 'peer']);
    root = join(tmp, 'main');
    symlinkSync('libs/ui', join(root, 'ui-link'));
    commit(root, 'main: init');
    commit(join(root, 'libs/ui'), 'ui: init');
    commit(join(root, 'tools'), 'tools: init');
    heads = { main: head(root), ui: head(join(root, 'libs/ui')), tools: head(join(root, 'tools')) };
    initOut = mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    mapx(root, 'workspaces', 'sync');
    mapx(root, 'workspaces', 'add', 'packages/web');
    mapx(root, 'scan', '--all');
  }, 120000);
  afterAll(() => cleanup(tmp));

  it('the fixture repos have distinct HEADs', () => {
    expect(new Set(Object.values(heads)).size).toBe(3);
  });

  it('init reports submodules and VS Code workspace repos; --no-workspaces skips the step', () => {
    expect(initOut).toContain('Detected .gitmodules with 2 submodule(s)');
    expect(initOut).toMatch(/legacy\s+\(libs\/legacy\) ✗ not initialised/);
    expect(initOut).toContain('Detected VS Code workspace file: main.code-workspace');
    // ui-link is the ui submodule under another name, so it is not offered again (M0-10-R2).
    expect(initOut).toContain('Additional repos: tools (tools)\n');
    const other = workspace(files, ['main', 'main/libs/ui', 'main/tools']);
    try {
      const out = mapx(join(other, 'main'), 'init', join(other, 'main'), '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover', '--no-workspaces');
      expect(out).not.toContain('.gitmodules');
      expect(out).not.toContain('VS Code workspace');
    } finally {
      cleanup(other);
    }
  });

  it('lists peers only with --include-peers and reads a JSONC .code-workspace', () => {
    const plain = mapx(root, 'workspaces', 'discover');
    expect(plain).not.toMatch(/peer\s+-> \.\.\/peer/);
    expect(plain).toContain('use --include-peers');
    expect(mapx(root, 'workspaces', 'discover', '--include-peers')).toMatch(/peer\s+-> \.\.\/peer/);
  });

  it('a symlink to a registered repo is not registered (or indexed) twice', () => {
    // sync registered the submodule, the JSONC workspace folder tools/ and (via add) packages/web;
    // not the peer, and not ui-link, which resolves to the already registered libs/ui (M0-10-R2).
    const repos = () => JSON.parse(readFileSync(join(root, '.mapx/config.json'), 'utf8')).repos.map((r: { path: string }) => r.path).sort();
    expect(repos()).toEqual(['.', 'libs/ui', 'packages/web', 'tools']);
    mapx(root, 'workspaces', 'add', 'ui-link');
    expect(repos()).toEqual(['.', 'libs/ui', 'packages/web', 'tools']);
    expect(query(root, "SELECT path FROM files WHERE path LIKE 'ui-link/%'")).toEqual([]);
  });

  it('prints the workspaces table with each repo\'s own HEAD; a plain folder has none', () => {
    const out = mapx(root, 'workspaces');
    expect(out).toMatch(/Name\s+Path\s+Type\s+Files\s+Last scanned\s+HEAD/);
    expect(out).toMatch(new RegExp(`\\n  main\\s+\\.\\s+primary\\s+\\d+\\s+\\S.*\\s${heads.main}\\n`));
    expect(out).toMatch(new RegExp(`\\n  ui\\s+libs/ui\\s+submodule\\s+2\\s+\\S.*\\s${heads.ui}\\n`));
    expect(out).toMatch(new RegExp(`\\n  tools\\s+tools\\s+vscode-workspace\\s+1\\s+\\S.*\\s${heads.tools}\\n`));
    // packages/web has no .git: no HEAD (not main's), and typed folder rather than peer (M0-10-R2).
    expect(out).toMatch(/\n  web\s+packages\/web\s+folder\s+1\s+\S.*\s-\n/);
    expect(out).toMatch(/legacy\s+libs\/legacy\s+submodule\s+✗ not initialised/);
    expect(out).toContain('git submodule update --init libs/legacy');
  });

  it('stores exactly the two cross-repo edges of the fixture', () => {
    expect(crossEdges(root)).toEqual([
      { source_file: 'src/app.ts', target_file: 'libs/ui/button.ts', edge_type: 'import', repo: 'main', target_repo: 'ui' },
      { source_file: 'src/app.ts', target_file: 'libs/ui/button.ts', edge_type: 'instantiation', repo: 'main', target_repo: 'ui' },
    ]);
  });

  it('status --all, export --all and deps --cross-repo report cross-repo edges', () => {
    const status = mapx(root, 'status', '--all');
    expect(status).toMatch(/Repo\s+Files\s+Symbols\s+Edges\s+HEAD\s+Last scan\s+Changed/);
    expect(status).toMatch(new RegExp(`\\n  ui\\s+2\\s+\\d+\\s+\\d+\\s+${heads.ui}\\s`));
    expect(status).toMatch(/\n  web\s+1\s+\d+\s+\d+\s+-\s/);
    expect(status).toContain('Cross-repo edges: 2 (main → ui: 2)');

    const exported = mapx(root, 'export', '--all');
    // TypeScript top-level `const icon` and `const web` are constant symbols (M0-17-R3).
    expect(exported).toContain([
      '## Repos (4)',
      '- main (primary) — 1 files, 1 symbols',
      '- ui (submodule) — 2 files, 2 symbols',
      '- tools (vscode-workspace) — 1 files, 1 symbols',
      '- web (folder) — 1 files, 1 symbols',
      '',
      '## Cross-repo dependencies (2 edges)',
      'main → ui: 2 import/instantiation',
    ].join('\n'));
    // Workspace title, then the repo-level sections; each repo's own export nests below its section.
    const headings = exported.split('\n').filter(l => /^#+ /.test(l));
    expect(headings.slice(0, 3)).toEqual(['# Workspace: main', '## Repos (4)', '## Cross-repo dependencies (2 edges)']);
    expect(headings.filter(h => /^#{1,2} /.test(h)).slice(3)).toEqual(['## main', '## ui', '## tools', '## web']);
    expect(headings.slice(3).every(h => /^## (main|ui|tools|web)$/.test(h) || /^###+ /.test(h))).toBe(true);
    const section = (name: string, next: string) => exported.slice(exported.indexOf(`\n## ${name}\n`), next ? exported.indexOf(`\n## ${next}\n`) : undefined);
    expect(section('main', 'ui')).toContain('src/app.ts');
    expect(section('main', 'ui')).not.toContain('libs/ui/icon.ts');
    expect(section('ui', 'tools')).toContain('libs/ui/icon.ts');
    expect(section('tools', 'web')).toContain('tools/build.ts');
    expect(section('web', '')).toContain('packages/web/index.ts');

    expect(mapx(root, 'deps', 'src/app.ts', '--cross-repo')).toContain('→ [ui] libs/ui/button.ts');
    expect(mapx(root, 'deps', 'libs/ui/button.ts', '--cross-repo')).toContain('← [main] src/app.ts');
  });

  it('mapx_workspaces returns root, headSha per repo, types and the exact crossRepoEdgeCount', async () => {
    const client = await mcpClient();
    try {
      const res = (await client.callTool({ name: 'mapx_workspaces', arguments: { dir: root } })) as any;
      const json = JSON.parse(res.content[0].text);
      expect(json.root).toBe(root);
      expect(json.crossRepoEdgeCount).toBe(2);
      expect(json.crossRepoEdges).toEqual([{ from: 'main', to: 'ui', count: 2, types: ['import', 'instantiation'] }]);
      const by = Object.fromEntries(json.repos.map((r: { name: string }) => [r.name, r]));
      expect(Object.fromEntries(Object.entries(by).map(([n, r]: [string, any]) => [n, [r.type, r.headSha]]))).toEqual({
        main: ['primary', heads.main],
        ui: ['submodule', heads.ui],
        tools: ['vscode-workspace', heads.tools],
        web: ['folder', null],
      });
      expect(by.main.crossRepoEdgeCount).toBe(2);
      expect(by.ui.crossRepoEdgeCount).toBe(0);
      expect(json.discovered.some((d: { source: string }) => d.source === 'peer')).toBe(false);
      expect(json.discovered.some((d: { path: string }) => d.path === 'ui-link')).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('mapx_export {all} and mapx_dependencies {crossRepo} match export --all and deps --cross-repo', async () => {
    const client = await mcpClient();
    try {
      const call = async (name: string, args: Record<string, unknown>) =>
        ((await client.callTool({ name, arguments: { dir: root, ...args } })) as any).content[0].text as string;
      const exported = await call('mapx_export', { all: true });
      expect(exported).toContain('# Workspace: main\n\n## Repos (4)\n');
      expect(exported).toContain('## Cross-repo dependencies (2 edges)\nmain → ui: 2 import/instantiation');
      for (const name of ['main', 'ui', 'tools', 'web']) expect(exported).toMatch(new RegExp(`^## ${name}$`, 'm'));
      const out = await call('mapx_dependencies', { file: 'src/app.ts', crossRepo: true });
      expect(out).toContain('Cross-repo dependencies:\n  → [ui] libs/ui/button.ts (import)\n  → [ui] libs/ui/button.ts (instantiation)');
      expect(out).not.toContain('Dependencies:\n');
      expect(await call('mapx_dependencies', { file: 'libs/ui/button.ts', crossRepo: true })).toContain('Cross-repo dependents:\n  ← [main] src/app.ts (import)');
    } finally {
      await client.close();
    }
  });
});

describe('workspace surface: a registered repo that was never scanned (F18)', () => {
  let tmp: string;
  let root: string;
  beforeAll(() => {
    tmp = workspace({ 'app/src/a.ts': 'export const a = 1;\n', 'app/lib/b.ts': 'export const b = 2;\n' }, ['app', 'app/lib']);
    root = join(tmp, 'app');
    commit(root, 'app: init');
    commit(join(root, 'lib'), 'lib: init');
    mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover', '--no-workspaces');
    mapx(root, 'scan');
    // Registered after the scan, as an interactive `init` registration does (no scan follows).
    const configPath = join(root, '.mapx/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.repos.push({ name: 'lib', path: 'lib' });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }, 120000);
  afterAll(() => cleanup(tmp));

  it('status --all and the workspaces table show it as unscanned, not clean', () => {
    const status = mapx(root, 'status', '--all');
    expect(status).toMatch(/\n  lib\s+0\s+0\s+0\s+[0-9a-f]{7,}\s+never\s+unscanned\n/);
    expect(status).toMatch(/\n  app\s+1\s+\d+\s+\d+\s+[0-9a-f]{7,}\s+\S.*\sclean\n/);
    expect(mapx(root, 'workspaces')).toMatch(/\n  lib\s+lib\s+peer\s+0\s+never\s+[0-9a-f]{7,}\n/);
  });
});
