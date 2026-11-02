import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// M4-09-R1: scripts/baton/check-test-cwd.mjs must notice any change a test run makes to the
// checkout, not only new top-level names and `.mapx/` bytes (review 2026-11-02).
const SCRIPT = resolve(__dirname, '../scripts/baton/check-test-cwd.mjs');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

describe('check-test-cwd', () => {
  let repo: string;
  const write = (path: string, text: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  /** Runs the check with `node -e <js>` as the "test" command. */
  const check = (js: string) => spawnSync(process.execPath, [SCRIPT, '--cmd', process.execPath, '-e', js], { cwd: repo, encoding: 'utf8', env });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mapx-check-cwd-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env });
    git('init', '-q');
    write('.gitignore', '.mapx/\n');
    write('CLAUDE.md', 'notes\n');
    write('src/a.ts', 'export const a = 1;\n');
    write('src/dirty.ts', 'v1\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    write('src/dirty.ts', 'v2, already modified before the run\n');
    write('.mapx/config.json', '{}\n');
    write('.mapx/mapx.db', 'db\n');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('passes when the command leaves the checkout alone, and reports the command\'s own failure', () => {
    expect(check('1').status).toBe(0);
    // A temp directory the run removes again is fine (M4-09-R2).
    expect(check("const d = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mapx-x-')); require('fs').rmSync(d, { recursive: true })").status).toBe(0);
    // Tool caches are no leftovers, tsx's under a uid or a user name (review of M4-09-R2).
    expect(check("require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'node-compile-cache'))").status).toBe(0);
    expect(check("require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'tsx-someone'))").status).toBe(0);
    expect(check('process.exit(3)').status).toBe(3);
  });

  it('still reports a leftover the check cannot remove', () => {
    const r = check("const fs = require('fs'), p = require('path'); const d = p.join(require('os').tmpdir(), 'mapx-ro'); fs.mkdirSync(d); fs.writeFileSync(p.join(d, 'y'), 'y'); fs.chmodSync(d, 0o555)");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mapx-ro');
  });

  it.each([
    ['edits an existing top-level tracked file', "require('fs').appendFileSync('CLAUDE.md', 'x')", 'CLAUDE.md'],
    ['creates a nested untracked file', "require('fs').mkdirSync('src/deep', { recursive: true }); require('fs').writeFileSync('src/deep/new.ts', 'x')", 'src/deep/new.ts'],
    ['appends to .mapx/tool-calls.jsonl', "require('fs').appendFileSync('.mapx/tool-calls.jsonl', '{}\\n')", '.mapx/tool-calls.jsonl'],
    ['edits a file that was already modified', "require('fs').appendFileSync('src/dirty.ts', 'x')", 'src/dirty.ts'],
    ['deletes a tracked file', "require('fs').rmSync('src/a.ts')", 'src/a.ts'],
    ['changes the scan database', "require('fs').appendFileSync('.mapx/mapx.db', 'x')", '.mapx/mapx.db'],
    // M4-09-R2: a temp directory the run does not remove.
    ['leaves a temp directory behind', "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mapx-left-'))", 'mapx-left-'],
  ])('fails, naming the path, when the command %s', (_name, js, path) => {
    const r = check(js);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(path);
  });
});
