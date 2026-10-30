import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, mapx, workspace } from './helpers/e2e.js';

// M0-10-R1: the F18 workspace surface. Layout: <tmp>/main is the primary repo with an
// initialised submodule (libs/ui), an uninitialised one (libs/legacy) and a JSONC
// .code-workspace naming tools/; <tmp>/peer is a sibling repo.
const files = {
  'main/src/app.ts': "import { Button } from '../libs/ui/button';\nexport const app = () => new Button();\n",
  'main/libs/ui/button.ts': 'export class Button {}\n',
  'main/libs/ui/icon.ts': "import { Button } from './button';\nexport const icon = new Button();\n",
  'main/tools/build.ts': 'export function build() { return 1; }\n',
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
    '  ],',
    '}',
  ].join('\n'),
  'peer/readme.md': '# peer\n',
};

const commit = (dir: string) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });

describe('workspace surface (F18)', () => {
  let tmp: string;
  let root: string;
  let initOut: string;
  beforeAll(() => {
    tmp = workspace(files, ['main', 'main/libs/ui', 'main/tools', 'peer']);
    root = join(tmp, 'main');
    commit(root);
    commit(join(root, 'libs/ui'));
    initOut = mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    mapx(root, 'workspaces', 'sync');
    mapx(root, 'scan', '--all');
  }, 120000);
  afterAll(() => cleanup(tmp));

  it('init reports submodules and VS Code workspace repos; --no-workspaces skips the step', () => {
    expect(initOut).toContain('Detected .gitmodules with 2 submodule(s)');
    expect(initOut).toMatch(/legacy\s+\(libs\/legacy\) ✗ not initialised/);
    expect(initOut).toContain('Detected VS Code workspace file: main.code-workspace');
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
    // sync registered the JSONC workspace folder (and not the peer)
    const repos = JSON.parse(readFileSync(join(root, '.mapx/config.json'), 'utf8')).repos.map((r: { path: string }) => r.path);
    expect(repos).toEqual(expect.arrayContaining(['libs/ui', 'tools']));
    expect(repos).not.toContain('../peer');
  });

  it('prints the workspaces table with Name, Path, Type, Files, Last scanned and HEAD', () => {
    const out = mapx(root, 'workspaces');
    expect(out).toMatch(/Name\s+Path\s+Type\s+Files\s+Last scanned\s+HEAD/);
    const head = (dir: string) => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(out).toMatch(new RegExp(`main\\s+\\.\\s+primary\\s+\\d+\\s+\\S.*${head(root)}`));
    expect(out).toMatch(new RegExp(`ui\\s+libs/ui\\s+submodule\\s+2\\s+\\S.*${head(join(root, 'libs/ui'))}`));
    expect(out).toMatch(/tools\s+tools\s+vscode-workspace\s+1\s/);
    expect(out).toMatch(/legacy\s+libs\/legacy\s+submodule\s+✗ not initialised/);
    expect(out).toContain('git submodule update --init libs/legacy');
  });

  it('status --all, export --all and deps --cross-repo report cross-repo edges', () => {
    const status = mapx(root, 'status', '--all');
    expect(status).toMatch(/Repo\s+Files\s+Symbols\s+Edges\s+HEAD\s+Last scan\s+Changed/);
    expect(status).toMatch(/Cross-repo edges: [1-9]\d* \(main → ui: [1-9]/);

    const exported = mapx(root, 'export', '--all');
    expect(exported).toContain('## Repos (3)');
    expect(exported).toMatch(/- ui \(submodule\) — 2 files/);
    expect(exported).toMatch(/## Cross-repo dependencies \([1-9]\d* edges\)\nmain → ui: /);
    for (const name of ['main', 'ui', 'tools']) expect(exported).toMatch(new RegExp(`^## ${name}$`, 'm'));

    expect(mapx(root, 'deps', 'src/app.ts', '--cross-repo')).toContain('→ [ui] libs/ui/button.ts');
    expect(mapx(root, 'deps', 'libs/ui/button.ts', '--cross-repo')).toContain('← [main] src/app.ts');
  });

  it('mapx_workspaces returns a top-level crossRepoEdgeCount and submodule types', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      const res = (await client.callTool({ name: 'mapx_workspaces', arguments: { dir: root } })) as any;
      const json = JSON.parse(res.content[0].text);
      expect(json.crossRepoEdgeCount).toBeGreaterThan(0);
      const types = Object.fromEntries(json.repos.map((r: { name: string; type: string }) => [r.name, r.type]));
      expect(types).toEqual({ main: 'primary', ui: 'submodule', tools: 'vscode-workspace' });
      expect(json.discovered.some((d: { source: string }) => d.source === 'peer')).toBe(false);
    } finally {
      await client.close();
    }
  });
});
