import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
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
