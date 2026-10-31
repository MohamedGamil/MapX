import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { cleanup, init, mapx, mapxWithStderr, query, workspace } from './helpers/e2e.js';

// M0-11-R1: impact risk without the try/catch downgrade (D010), import-only dependants, callee
// locations, staleness for new/identical files, and the JS globals blacklist on every extension.
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' });

describe('impact, callees, staleness and globals', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'src/core.ts': 'export function direct() {\n  return 1;\n}\n\n\nexport function helper() {\n  return 2;\n}\n',
      'src/caller.ts': "import { direct, helper } from './core';\nexport function commented() {\n  // we should try harder here\n  return direct();\n}\nexport function guarded() {\n  try { return direct(); } catch { return 0; }\n}\nexport function usesHelper() {\n  return helper();\n}\n",
      'src/types-only.ts': "import { direct } from './core';\nexport type T = typeof direct;\n",
      'src/Date.ts': 'export class Date {}\n',
      'src/viaMjs.mjs': 'export function viaMjs() { return new Date(); }\n',
      // M0-11-R2: the globals blacklist on the other JS-family extensions
      'src/viaCjs.cjs': 'function viaCjs() { return new Date(); }\nmodule.exports = { viaCjs };\n',
      'src/viaCts.cts': 'export function viaCts() { return new Date(); }\n',
      'src/View.svelte': '<script>\n  const d = new Date();\n</script>\n<p>{d}</p>\n',
      // M0-11-R2: imports core.ts but not `direct`
      'src/helper-only.ts': "import { helper } from './core';\nexport type H = typeof helper;\n",
    }, ['.']);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('keeps direct callers HIGH whether or not they contain `try`', () => {
    const out = JSON.parse(mapx(root, 'impact', 'direct', '-d', root, '--format', 'json'));
    const risk = Object.fromEntries(out.affected.map((a: any) => [a.symbol, a.risk]));
    expect(risk.commented).toBe('HIGH');
    expect(risk.guarded).toBe('HIGH');
  });

  it('lists import-only dependants as LOW', () => {
    const out = JSON.parse(mapx(root, 'impact', 'direct', '-d', root, '--format', 'json'));
    expect(out.affected).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'src/types-only.ts', risk: 'LOW' })]));
  });

  // M0-11-R2: the import edge names only the module, so every importer of core.ts used to be listed.
  it('lists an import-only dependant only when it imports the changed symbol', () => {
    const importers = (symbol: string) =>
      JSON.parse(mapx(root, 'impact', symbol, '-d', root, '--format', 'json')).affected
        .filter((a: { symbol: string }) => a.symbol === '<import>').map((a: { file: string }) => a.file).sort();
    expect(importers('direct')).toEqual(['src/types-only.ts']);
    expect(importers('helper')).toEqual(['src/helper-only.ts']);
  });

  it('creates no edge from new Date() in .cjs, .cts or .svelte to a user Date class', () => {
    expect(query(root, "SELECT path FROM files WHERE path IN ('src/viaCjs.cjs', 'src/viaCts.cts', 'src/View.svelte')").length).toBe(3);
    expect(query(root, "SELECT source_file FROM edges WHERE target_file = 'src/Date.ts'")).toEqual([]);
  });

  it("prints the callee's own declaration line", () => {
    expect(mapx(root, 'callees', 'usesHelper', '-d', root)).toMatch(/helper[\s\S]*src\/core\.ts:6\b/);
  });

  it('creates no edge from new Date() in .mjs to a user Date class', () => {
    expect(query(root, "SELECT * FROM edges WHERE source_file = 'src/viaMjs.mjs' AND target_file = 'src/Date.ts'")).toEqual([]);
  });

  it('does not flag a file rewritten with identical content', () => {
    const path = join(root, 'src/core.ts');
    writeFileSync(path, readFileSync(path, 'utf8'));
    const future = new Date(Date.now() + 5000);
    utimesSync(path, future, future);
    expect(mapxWithStderr(root, 'query', 'direct', '-d', root).stderr).not.toContain('may be stale');
  });

  it('flags a new untracked file, and sync indexes it', () => {
    writeFileSync(join(root, 'src/New.tsx'), 'export function Late() { return null; }\n');
    expect(mapxWithStderr(root, 'query', 'direct', '-d', root).stderr).toContain('src/New.tsx (new)');
    mapx(root, 'sync', root);
    expect(query(root, "SELECT name FROM symbols WHERE name = 'Late'")).toHaveLength(1);
  });
});

// Review 2026-10-31 (post-acceptance defect): PHP namespaced callees printed the call-site line.
describe('callees of PHP namespaced classes', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'app/Models/User.php': '<?php\nnamespace App\\Models;\n\nclass User {}\n',
      'app/Http/Controllers/UserController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\User;\nclass UserController {\n  public function a() { return new User(); }\n}\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it("prints the class's own declaration line", () => {
    expect(mapx(root, 'callees', 'a', '-d', root)).toMatch(/App\\Models\\User[\s\S]*app\/Models\/User\.php:4\b/);
  });
});

// M0-11-R2: staleness applied only settings.excludePatterns, so files the scanner never indexes
// (outside includePatterns, Laravel default excludes, dotfiles) were flagged "(new)" forever.
describe('staleness follows the scanner file rules', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach(cleanup));
  const editConfig = (root: string, edit: (c: any) => void) => {
    const path = join(root, '.mapx', 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    edit(config);
    writeFileSync(path, JSON.stringify(config, null, 2));
  };
  const staleLines = (root: string) =>
    mapxWithStderr(root, 'query', 'zzz', '-d', root).stderr.split('\n').filter((l) => /stale|Changed:/.test(l)).join('\n');

  it('includePatterns and dotfiles: scripts/tool.ts and .eslintrc.js are not stale; a new src file is', () => {
    const root = workspace({ 'src/a.ts': 'export const a = 1;\n' }, ['.']);
    roots.push(root);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    writeFileSync(join(root, '.eslintrc.js'), 'module.exports = {};\n'); // untracked dotfile
    init(root);
    editConfig(root, (c) => { c.settings.includePatterns = ['src/**']; });
    mapx(root, 'scan', root);
    expect(staleLines(root)).toBe('');
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/tool.ts'), 'export const t = 1;\n');
    expect(staleLines(root)).toBe('');
    writeFileSync(join(root, 'src/b.ts'), 'export const b = 1;\n');
    const stale = staleLines(root);
    expect(stale).toContain('src/b.ts (new)');
    expect(stale).not.toMatch(/tool\.ts|eslintrc/);
  }, 60000);

  it('framework laravel without globs: a new migration and Blade view are not stale; a new model is', () => {
    const root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
    }, ['.']);
    roots.push(root);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    init(root);
    editConfig(root, (c) => {
      c.settings.excludePatterns = [];
      delete c.settings.laravelDefaultExcludes;
      c.repos[0].framework = 'laravel';
    });
    mapx(root, 'scan', root);
    mkdirSync(join(root, 'database/migrations'), { recursive: true });
    mkdirSync(join(root, 'resources/views'), { recursive: true });
    writeFileSync(join(root, 'database/migrations/2024_01_01_000000_create_users.php'), '<?php\nreturn new class {};\n');
    writeFileSync(join(root, 'resources/views/home.blade.php'), '<div>{{ $x }}</div>\n');
    // a dotfile and a directory the scan walk never enters (DEFAULT_IGNORE), with no glob naming them
    writeFileSync(join(root, '.eslintrc.js'), 'module.exports = {};\n');
    mkdirSync(join(root, 'coverage'));
    writeFileSync(join(root, 'coverage/lcov.ts'), 'export const covered = 1;\n');
    expect(staleLines(root)).toBe('');
    writeFileSync(join(root, 'app/Models/Post.php'), '<?php\nnamespace App\\Models;\nclass Post {}\n');
    expect(staleLines(root)).toContain('app/Models/Post.php (new)');
  }, 60000);
});

// M0-11-R2: callees took the first same-named declaration in the file and fell back to the call site.
describe('callee lines with homonyms and unknown declarations', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'src/models.ts': 'export class A {\n  save() { return 1; }\n}\n\nexport class B {\n  save() { return 2; }\n}\n',
      'src/run.ts': "import { B } from './models';\nexport function run() {\n  const b = new B();\n  return b.save();\n}\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it("prints the called class's method line, not an earlier homonym", () => {
    const out = mapx(root, 'callees', 'run', '-d', root);
    expect(out).toMatch(/→ save \(called by run\)\n\s+@ src\/models\.ts:6\n/);
    expect(out).toMatch(/→ B \(called by run\)\n\s+@ src\/models\.ts:5\n/);
  });

  it('prints no line, not the call-site line, when the declaration is unknown', () => {
    const db = new Database(join(root, '.mapx', 'mapx.db'));
    db.prepare("DELETE FROM symbols WHERE file_path = 'src/models.ts' AND name = 'save'").run();
    db.close();
    const out = mapx(root, 'callees', 'run', '-d', root);
    expect(out).toMatch(/→ save \(called by run\)\n\s+@ src\/models\.ts\n/);
    expect(out).not.toContain('src/models.ts:4');
  });
});
