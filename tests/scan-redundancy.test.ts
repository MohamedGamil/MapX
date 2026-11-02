import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Scanner } from '../src/core/scanner.js';
import { Store } from '../src/core/store.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';

// M4-04: no redundant full walk, and no post-scan analysis for a sync that changes nothing indexed
// (docs/baton/iterations/M4-04.md).

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' });

describe('paths-only discovery', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns the full walk\'s paths and languages, in order, without reading content', async () => {
    root = mkdtempSync(join(tmpdir(), 'mapx-paths-'));
    write(root, {
      'src/a.ts': 'export const a = 1;\n',
      'src/deep/b/c.py': 'def c():\n    return 1\n',
      'src/deep/b/notes.txt': 'not code\n',
      'lib/z.go': 'package lib\n',
      'bin/tool': '#!/usr/bin/env node\nconsole.log(1);\n',
      'node_modules/pkg/index.js': 'module.exports = 1;\n',
      'dist/out.js': 'x\n',
      '.hidden/h.ts': 'export const h = 1;\n',
      '.eslintrc.js': 'module.exports = {};\n',
      'nested/.git/HEAD': 'ref: refs/heads/main\n',
      'nested/inner.ts': 'export const inner = 1;\n',
    });
    const config = await Config.load(root);
    const scanner = new Scanner(new Store(':memory:'), config, new MapxGraph(config.repos[0]!.name)) as any;
    const full = await scanner.discoverFiles(root, config.repos[0]!.name, true);
    const paths = await scanner.discoverFiles(root, config.repos[0]!.name, true, { pathsOnly: true });
    const view = (fs: any[]) => fs.map((f) => `${f.relativePath} ${f.language}`);
    expect(view(paths)).toEqual(view(full));
    expect(view(full).sort()).toEqual(['bin/tool javascript', 'lib/z.go go', 'src/a.ts typescript', 'src/deep/b/c.py python']);
    for (const f of paths) {
      expect(f.content).toBeUndefined();
      expect(f.contentHash).toBeUndefined();
    }
  });

  it.skipIf(process.getuid?.() === 0)('leaves out an unreadable file, as the full walk does (review 2026-11-01)', async () => {
    root = mkdtempSync(join(tmpdir(), 'mapx-paths-'));
    write(root, { 'src/a.ts': "import { b } from './b';\n", 'src/b.ts': 'export const b = 1;\n' });
    chmodSync(join(root, 'src/b.ts'), 0o000);
    try {
      const config = await Config.load(root);
      const scanner = new Scanner(new Store(':memory:'), config, new MapxGraph(config.repos[0]!.name)) as any;
      const view = (fs: any[]) => fs.map((f) => f.relativePath);
      const full = await scanner.discoverFiles(root, config.repos[0]!.name, true);
      expect(view(await scanner.discoverFiles(root, config.repos[0]!.name, true, { pathsOnly: true }))).toEqual(view(full));
      expect(view(full)).toEqual(['src/a.ts']);
    } finally {
      chmodSync(join(root, 'src/b.ts'), 0o644);
    }
  });
});

describe('git sync without analysis inputs (real scans, in process)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mapx-noise-'));
    write(root, {
      'src/a.ts': "import { b } from './b';\nexport function a() { return b(); }\n",
      'src/b.ts': 'export function b() { return 1; }\n',
      'src/c.ts': "import { a } from './a';\nexport function c() { return a(); }\n",
    });
    git(root, 'init', '-q');
    git(root, 'add', 'src');
    git(root, 'commit', '-qm', 'init');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const scanner = async (store: Store, phases: string[] = []) => {
    const config = await Config.load(root); // writes .mapx/config.json: untracked, like `mapx init`
    return new Scanner(store, config, new MapxGraph(config.repos[0]!.name), (p) => phases.push(p.phase));
  };
  const edgesOf = (store: Store) => store.getAllEdges()
    .map((e) => `${e.source_file} ${e.source_symbol} ${e.target_file} ${e.target_symbol} ${e.edge_type}`).sort();
  const syncPhases = async (store: Store) => {
    const phases: string[] = [];
    const result = await (await scanner(store, phases)).scanIncremental();
    return { phases: new Set(phases), result };
  };

  it('skips parsing and the post-scan analysis when git lists only files the walk never indexes', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    const before = edgesOf(store);
    write(root, { '.gitignore': '.mapx/\n', '.idea/workspace.xml': '<x/>\n', 'dist/out.js': 'x\n', 'node_modules/m/i.js': 'x\n' });
    const repo = (await Config.load(root)).repos[0]!.name;
    store.setMeta(`last_scan_time:${repo}`, 'before');

    const { phases, result } = await syncPhases(store);
    expect(result.filesScanned).toBe(0);
    expect(phases.has('parse')).toBe(false);
    expect(phases.has('cluster')).toBe(false);
    expect(store.getMeta(`last_scan_time:${repo}`)).not.toBe('before');
    expect(edgesOf(store)).toEqual(before);

    const fresh = new Store(':memory:');
    await (await scanner(fresh)).scanFull(undefined, { force: true });
    expect(edgesOf(store)).toEqual(edgesOf(fresh));
  }, 120000);

  // M0-10-R6: the count is the files re-indexed, not every path git listed (as the hash sync reports).
  it('reports the files it re-indexed, not the noise git listed', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    const noise = Object.fromEntries([...Array(10)].map((_, i) => [`.idea/f${i}.xml`, '<x/>\n']));
    write(root, { '.gitignore': '.mapx/\n', ...noise, 'src/c.ts': "import { a } from './a';\nexport function c() { return a(); }\nexport function c2() { return 2; }\n" });
    const { result } = await syncPhases(store);
    expect(result.filesScanned).toBe(1);
  }, 120000);

  it('skips the analysis for an untracked nested git repo, which git lists as a folder (review 2026-11-01)', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    write(root, { 'lib/inner.ts': 'export const inner = 1;\n' });
    git(join(root, 'lib'), 'init', '-q');
    const { phases } = await syncPhases(store);
    expect(phases.has('cluster')).toBe(false);
  }, 120000);

  it('reruns the analysis when settings change, though git lists only noise (review 2026-11-01)', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    write(root, { '.gitignore': '.mapx/\n' });
    const configPath = join(root, '.mapx/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.settings.graphExcludePatterns = ['src/c.ts'];
    writeFileSync(configPath, JSON.stringify(config));
    expect((await syncPhases(store)).phases.has('cluster')).toBe(true);
    // Recorded after the run: the next noise-only sync skips it again.
    expect((await syncPhases(store)).phases.has('cluster')).toBe(false);
  }, 120000);

  it.each([
    ['a deleted go.mod that was never indexed', (r: string) => unlinkSync(join(r, 'go.mod')), { 'go.mod': 'module example.com/app\n' }],
    ['an edited package.json, excluded from the walk by default', (r: string) => writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0' } })), { 'package.json': JSON.stringify({ name: 'app' }) }],
    ['an untracked requirements.txt (a framework-detection input no parser reads)', (r: string) => write(r, { 'requirements.txt': 'flask==3.0\n' })],
    ['an edited source file', (r: string) => appendFileSync(join(r, 'src/b.ts'), 'export function b2() { return 2; }\n')],
    ['a deleted indexed file', (r: string) => unlinkSync(join(r, 'src/c.ts'))],
  ] as Array<[string, (r: string) => void, Record<string, string>?]>)('still runs the post-scan analysis for %s', async (_name, change, committed) => {
    if (committed) {
      write(root, committed);
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'manifest');
    }
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    write(root, { '.gitignore': '.mapx/\n' });
    change(root);
    const { phases } = await syncPhases(store);
    expect(phases.has('cluster')).toBe(true);

    const fresh = new Store(':memory:');
    await (await scanner(fresh)).scanFull(undefined, { force: true });
    expect(edgesOf(store)).toEqual(edgesOf(fresh));
  }, 120000);
});
