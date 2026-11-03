import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChangedFiles } from '../src/core/git-tracker.js';

// Review of M5-14 (P0): a `since` ref from the CLI or an MCP tool reached a shell string, so
// `HEAD^{/.|$(touch PWNED)}` (a valid ref: git accepts any commit-message regex) ran a command.
// Every git call now passes an argument array, and a ref cannot start with `-` (an option).
describe('git refs never reach a shell or an option', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'pipe' });
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'mapx-git-injection-'));
    git('init', '-q');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'one');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('runs no shell syntax in a ref', () => {
    getChangedFiles(repo, 'HEAD^{/.|$(touch PWNED)}');
    getChangedFiles(repo, 'HEAD;touch PWNED2');
    getChangedFiles(repo, '`touch PWNED3`');
    expect(['PWNED', 'PWNED2', 'PWNED3'].filter((f) => existsSync(join(repo, f)))).toEqual([]);
  });

  it('refuses a ref that would be an option', () => {
    expect(getChangedFiles(repo, '--output=WRITTEN').some((c) => c.path === 'WRITTEN')).toBe(false);
    expect(existsSync(join(repo, 'WRITTEN'))).toBe(false);
  });

  it('still diffs against a real ref', () => {
    expect(getChangedFiles(repo, 'HEAD')).toEqual([{ path: 'a.ts', status: 'modified' }]);
  });
});
