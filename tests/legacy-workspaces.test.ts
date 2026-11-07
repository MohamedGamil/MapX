import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { startUiServer } from '../src/ui-server.js';
import { cleanup, mapx, mapxWithStderr, query, workspace } from './helpers/e2e.js';

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
    // The uninitialised submodule's empty checkout folder, as `git clone` leaves it (M0-10-R3).
    mkdirSync(join(root, 'libs/legacy'));
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
      const by = Object.fromEntries(json.repos.filter((r: { isRegistered: boolean }) => r.isRegistered).map((r: { name: string }) => [r.name, r]));
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

  // M0-10-R3: F18's RepoSummary fields: absolute path, relativePath, isRegistered, isInitialised.
  it('mapx_workspaces entries carry F18 path, relativePath, isRegistered and isInitialised', async () => {
    const client = await mcpClient();
    try {
      const json = JSON.parse(((await client.callTool({ name: 'mapx_workspaces', arguments: { dir: root } })) as any).content[0].text);
      const f18 = json.repos.map((r: any) => ({ name: r.name, type: r.type, path: r.path, relativePath: r.relativePath, isRegistered: r.isRegistered, isInitialised: r.isInitialised }));
      expect(f18).toEqual([
        { name: 'main', type: 'primary', path: root, relativePath: '.', isRegistered: true, isInitialised: true },
        { name: 'ui', type: 'submodule', path: join(root, 'libs/ui'), relativePath: 'libs/ui', isRegistered: true, isInitialised: true },
        { name: 'tools', type: 'vscode-workspace', path: join(root, 'tools'), relativePath: 'tools', isRegistered: true, isInitialised: true },
        { name: 'web', type: 'folder', path: join(root, 'packages/web'), relativePath: 'packages/web', isRegistered: true, isInitialised: true },
        // The uninitialised submodule is listed, as in the CLI table, but not registered.
        { name: 'legacy', type: 'submodule', path: join(root, 'libs/legacy'), relativePath: 'libs/legacy', isRegistered: false, isInitialised: false },
      ]);
      expect(json.repos.find((r: any) => r.name === 'legacy')).toMatchObject({ fileCount: 0, lastScanned: null, headSha: null });
      expect(json.repos.find((r: any) => r.name === 'ui')).toMatchObject({ fileCount: 2, headSha: heads.ui });
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

// M0-10-R3: a config that already holds the same folder twice (written before M0-10-R2's de-dup,
// or by hand) is collapsed on load, and on `workspaces sync`, with a message.
describe('workspace surface: duplicate repo entries already in the config (F18)', () => {
  let tmp: string;
  let root: string;
  const configPath = () => join(root, '.mapx/config.json');
  const setRepos = (repos: Array<{ name: string; path: string }>) => {
    const config = JSON.parse(readFileSync(configPath(), 'utf8'));
    config.repos = repos;
    writeFileSync(configPath(), JSON.stringify(config, null, 2));
  };
  const repos = () => JSON.parse(readFileSync(configPath(), 'utf8')).repos as Array<{ name: string; path: string }>;
  beforeAll(() => {
    tmp = workspace({ 'app/src/a.ts': 'export const a = 1;\n', 'app/lib/b.ts': 'export const b = 2;\n' }, ['app', 'app/lib']);
    root = join(tmp, 'app');
    symlinkSync('lib', join(root, 'lib-link'));
    commit(root, 'app: init');
    commit(join(root, 'lib'), 'lib: init');
    mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover', '--no-workspaces');
    // The symlink registered alone and scanned: its files are stored under lib-link/.
    setRepos([{ name: 'app', path: '.' }, { name: 'lib-link', path: 'lib-link' }]);
    mapx(root, 'scan', '--all');
  }, 120000);
  afterAll(() => cleanup(tmp));

  it('collapses the same folder (a symlink, another spelling) to its first entry on load, and drops the duplicate\'s data', () => {
    expect(query(root, "SELECT path, repo FROM files WHERE path LIKE 'lib-link/%'")).toEqual([{ path: 'lib-link/b.ts', repo: 'lib-link' }]);
    setRepos([{ name: 'app', path: '.' }, { name: 'lib', path: 'lib' }, { name: 'lib-link', path: 'lib-link' }, { name: 'lib2', path: './lib/' }]);
    const { stderr } = mapxWithStderr(root, 'workspaces');
    expect(stderr).toContain('Removed duplicate repo entry lib-link (lib-link): same folder as lib (lib).');
    expect(stderr).toContain('Removed duplicate repo entry lib2 (./lib/): same folder as lib (lib).');
    expect(repos()).toEqual([{ name: 'app', path: '.' }, { name: 'lib', path: 'lib' }]);
    expect(query(root, "SELECT path FROM files WHERE path LIKE 'lib-link/%'")).toEqual([]);
    // Saved: the next load has nothing to report.
    expect(mapxWithStderr(root, 'workspaces').stderr).not.toContain('duplicate');
  });

  it('workspaces sync collapses duplicates too', () => {
    setRepos([{ name: 'app', path: '.' }, { name: 'lib', path: 'lib' }, { name: 'lib-link', path: 'lib-link' }]);
    const { stderr } = mapxWithStderr(root, 'workspaces', 'sync');
    expect(stderr).toContain('Removed duplicate repo entry lib-link (lib-link): same folder as lib (lib).');
    expect(repos().map(r => r.path)).toEqual(['.', 'lib']);
  });
});

// M0-10-R3 (found by M0-03-R4): `workspaces add` scans the new repo before the primary repo is
// indexed, so its references into the primary repo are unresolved; a later plain `scan --all`
// must resolve them although the new repo's files did not change. `update --all` (incremental)
// must do the same.
describe('workspace surface: scan --all after workspaces add (F18)', () => {
  type Edge = { source_file: string; target_file: string; edge_type: string; repo: string; target_repo: string | null };
  const edges = (root: string) => query<Edge>(root, 'SELECT source_file, target_file, edge_type, repo, target_repo FROM edges ORDER BY source_file, target_file, edge_type');
  const roots: string[] = [];
  const fresh = () => {
    const root = workspace({
      'src/theme.ts': "export const theme = { color: 'red' };\n",
      'src/app.ts': "import { Button } from '../libs/ui/button';\nexport const app = () => new Button();\n",
      'libs/ui/button.ts': "import { theme } from '../../src/theme';\nexport class Button { color = theme.color; }\n",
      'libs/ui/icon.ts': "import { Button } from './button';\nexport const icon = new Button();\n",
    }, ['.', 'libs/ui']);
    roots.push(root);
    // Committed, so `update` takes the git-diff path (an unborn HEAD lists every file as changed).
    for (const dir of [join(root, 'libs/ui'), root]) {
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
      commit(dir, 'init');
    }
    mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover', '--no-workspaces');
    mapx(root, 'workspaces', 'add', 'libs/ui');
    // The scan `add` runs sees no primary-repo files: button.ts's import is unresolved.
    expect(edges(root).filter(e => e.target_file === 'src/theme.ts')).toEqual([]);
    return root;
  };
  afterAll(() => roots.forEach(cleanup));

  for (const command of ['scan', 'update']) {
    it(`a plain ${command} --all resolves the new repo's references into the primary repo, as scan --all --force does`, () => {
      const root = fresh();
      mapx(root, command, '--all');
      const main = JSON.parse(readFileSync(join(root, '.mapx/config.json'), 'utf8')).repos[0].name;
      const plain = edges(root);
      expect(plain).toContainEqual({ source_file: 'libs/ui/button.ts', target_file: 'src/theme.ts', edge_type: 'import', repo: 'ui', target_repo: main });
      mapx(root, 'scan', '--all', '--force');
      expect(edges(root)).toEqual(plain);
    }, 120000);
  }
});

// M0-10-R4: cross-repo edges must not depend on the order repos are resolved in, and must come back
// after the target file or the whole repo leaves the index and returns, without --force.
describe('workspace surface: cross-repo edges independent of order and history (M0-10-R4)', () => {
  type Edge = { source_file: string; target_file: string; edge_type: string };
  const all = (root: string) => query<Edge>(root, 'SELECT source_file, target_file, edge_type FROM edges ORDER BY source_file, target_file, edge_type, source_symbol, target_symbol');
  const cross = (root: string) => all(root).filter(e => e.source_file === 'src/app.ts');
  const expected = [
    { source_file: 'src/app.ts', target_file: 'libs/ui/button.ts', edge_type: 'import' },
    { source_file: 'src/app.ts', target_file: 'libs/ui/button.ts', edge_type: 'instantiation' },
  ];
  const roots: string[] = [];
  afterAll(() => roots.forEach(cleanup));
  const setup = (order: 'primary-first' | 'ui-first' = 'primary-first') => {
    const root = workspace({
      'src/app.ts': "import { Button } from '../libs/ui/button';\nexport const app = () => new Button();\n",
      'libs/ui/button.ts': 'export class Button {}\n',
      'libs/ui/icon.ts': "import { Button } from './button';\nexport const icon = new Button();\n",
      '.gitignore': '.mapx/\nlibs/ui/\n',
    }, ['.', 'libs/ui']);
    roots.push(root);
    for (const dir of [join(root, 'libs/ui'), root]) {
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
      commit(dir, 'init');
    }
    mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover', '--no-workspaces');
    const path = join(root, '.mapx/config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const primary = config.repos[0];
    const ui = { name: 'ui', path: 'libs/ui' };
    config.repos = order === 'primary-first' ? [primary, ui] : [ui, primary];
    writeFileSync(path, JSON.stringify(config, null, 2));
    return root;
  };

  for (const order of ['primary-first', 'ui-first'] as const) {
    it(`the first scan --all gives the cross-repo instantiation edge (${order}), as scan --all --force does`, () => {
      const root = setup(order);
      mapx(root, 'scan', '--all');
      expect(cross(root)).toEqual(expected);
      const first = all(root);
      mapx(root, 'scan', '--all', '--force');
      expect(all(root)).toEqual(first);
    }, 120000);
  }

  for (const command of ['sync', 'scan'] as const) {
    it(`${command} --all restores cross-repo inbound edges after the target file is deleted and restored`, () => {
      const root = setup();
      mapx(root, 'scan', '--all');
      const fresh = all(root);
      expect(cross(root)).toEqual(expected);
      rmSync(join(root, 'libs/ui/button.ts'));
      mapx(root, command, '--all');
      expect(cross(root)).toEqual([]);
      execFileSync('git', ['checkout', '--', 'button.ts'], { cwd: join(root, 'libs/ui') });
      mapx(root, command, '--all');
      expect(all(root)).toEqual(fresh);
    }, 120000);

    it(`workspaces remove then add, then ${command} --all, restores the cross-repo edges`, () => {
      const root = setup();
      mapx(root, 'scan', '--all');
      const fresh = all(root);
      mapx(root, 'workspaces', 'remove', 'ui');
      expect(cross(root).filter(e => e.target_file.startsWith('libs/ui/'))).toEqual([]);
      mapx(root, 'workspaces', 'add', 'libs/ui');
      mapx(root, command, '--all');
      expect(all(root)).toEqual(fresh);
    }, 120000);
  }

  it('the dashboard server collapses duplicate repo entries and drops the dropped entry\'s rows', async () => {
    const tmp = workspace({ 'app/src/a.ts': 'export const a = 1;\n', 'app/lib/b.ts': 'export const b = 2;\n' }, ['app', 'app/lib']);
    roots.push(tmp);
    const root = join(tmp, 'app');
    symlinkSync('lib', join(root, 'lib-link'));
    commit(root, 'app: init');
    commit(join(root, 'lib'), 'lib: init');
    mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover', '--no-workspaces');
    const path = join(root, '.mapx/config.json');
    const setRepos = (repos: Array<{ name: string; path: string }>) => {
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.repos = repos;
      writeFileSync(path, JSON.stringify(config, null, 2));
    };
    setRepos([{ name: 'app', path: '.' }, { name: 'lib-link', path: 'lib-link' }]);
    mapx(root, 'scan', '--all');
    setRepos([{ name: 'app', path: '.' }, { name: 'lib', path: 'lib' }, { name: 'lib-link', path: 'lib-link' }]);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    const server = startUiServer({ port: 0, host: '127.0.0.1', dir: root, token: 't' }) as unknown as Server;
    try {
      await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/status`, { headers: { Authorization: 'Bearer t' } });
      expect(res.status).toBe(200);
      expect((await res.json() as { fileCount: number }).fileCount).toBe(1);
    } finally {
      console.error = original;
      await new Promise((r) => server.close(r));
    }
    expect(errors.join('\n')).toContain('Removed duplicate repo entry lib-link (lib-link): same folder as lib (lib).');
    expect(query(root, "SELECT path FROM files WHERE path LIKE 'lib-link/%'")).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8')).repos.map((r: { name: string }) => r.name)).toEqual(['app', 'lib']);
  }, 120000);
});

// Independent review of M0-10-R4 (2026-10-31).
describe('cross-repo edges after the independent review of M0-10-R4', () => {
  type Edge = { source_file: string; target_file: string; edge_type: string; target_symbol: string | null };
  const all = (root: string) => query<Edge>(root, 'SELECT source_file, target_file, edge_type, target_symbol FROM edges ORDER BY source_file, target_file, edge_type, target_symbol');
  const roots: string[] = [];
  afterAll(() => roots.forEach(cleanup));
  const setup = (order: 'primary-first' | 'ui-first') => {
    const root = workspace({
      'src/app.ts': "import { Button } from '../libs/ui/button';\nexport const app = () => new Button();\n",
      'libs/ui/button.ts': 'export class Button {}\n',
      '.gitignore': '.mapx/\nlibs/ui/\n',
    }, ['.', 'libs/ui']);
    roots.push(root);
    for (const dir of [join(root, 'libs/ui'), root]) {
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
      commit(dir, 'init');
    }
    mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover', '--no-workspaces');
    const path = join(root, '.mapx/config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const ui = { name: 'ui', path: 'libs/ui' };
    config.repos = order === 'primary-first' ? [config.repos[0], ui] : [ui, config.repos[0]];
    writeFileSync(path, JSON.stringify(config, null, 2));
    return root;
  };

  for (const order of ['primary-first', 'ui-first'] as const) {
    for (const command of ['sync', 'scan'] as const) {
      it(`${command} --all links a rename made in both repos in one run (${order})`, () => {
        const root = setup(order);
        mapx(root, 'scan', '--all');
        writeFileSync(join(root, 'libs/ui/button.ts'), 'export class Btn {}\n');
        writeFileSync(join(root, 'src/app.ts'), "import { Btn } from '../libs/ui/button';\nexport const app = () => new Btn();\n");
        mapx(root, command, '--all');
        expect(all(root).filter(e => e.source_file === 'src/app.ts')).toEqual([
          { source_file: 'src/app.ts', target_file: 'libs/ui/button.ts', edge_type: 'import', target_symbol: '../libs/ui/button' },
          { source_file: 'src/app.ts', target_file: 'libs/ui/button.ts', edge_type: 'instantiation', target_symbol: 'Btn' },
        ]);
        const synced = all(root);
        mapx(root, 'scan', '--all', '--force');
        expect(all(root)).toEqual(synced);
      }, 120000);
    }
  }

  it('an unchanged scan --all does not re-parse the other repo\'s referrers when a re-export still names a removed class', () => {
    const root = setup('primary-first');
    writeFileSync(join(root, 'libs/ui/index.ts'), "export { Button } from './button';\n");
    mapx(root, 'scan', '--all');
    rmSync(join(root, 'libs/ui/button.ts'));
    mapx(root, 'scan', '--all');
    // The referrer in the other repo (a file without symbols, like index.ts, is re-read by every scan).
    const stamps = () => query<{ s: string }>(root, "SELECT path || '|' || last_scanned AS s FROM files WHERE path = 'src/app.ts'").map(r => r.s);
    const before = stamps();
    mapx(root, 'scan', '--all');
    mapx(root, 'scan', '--all');
    expect(stamps()).toEqual(before);
  }, 120000);

  it('workspaces remove of a nested folder repo, then sync --all, indexes its files into the containing repo', () => {
    const root = workspace({ 'src/app.ts': 'export const app = 1;\n', 'packages/web/index.ts': 'export const web = 1;\n', '.gitignore': '.mapx/\n' }, ['.']);
    roots.push(root);
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    commit(root, 'init');
    mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover', '--no-workspaces');
    mapx(root, 'workspaces', 'add', 'packages/web');
    mapx(root, 'scan', '--all');
    mapx(root, 'workspaces', 'remove', 'web');
    mapx(root, 'sync', '--all');
    expect(query(root, "SELECT path FROM files WHERE path = 'packages/web/index.ts'")).toHaveLength(1);
    const synced = all(root);
    mapx(root, 'scan', '--all', '--force');
    expect(all(root)).toEqual(synced);
  }, 120000);
});
