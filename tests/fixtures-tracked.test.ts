import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// A fixture file that .gitignore hides passes locally and fails on every fresh clone and in CI.
// The arch-rules and arch-config configs live in `.mapx/`, which the root .gitignore ignores
// (review 2026-11-02, P0). Nothing under tests/ may be ignored, apart from installed packages.
const root = new URL('..', import.meta.url).pathname;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
let inGit = true;
try {
  git('rev-parse', '--is-inside-work-tree');
} catch {
  inGit = false;
}

describe.skipIf(!inGit)('test fixtures are committable', () => {
  it('no file under tests/ is ignored by git', () => {
    const ignored = git('ls-files', '--others', '--ignored', '--exclude-standard', '--', 'tests/')
      .split('\n')
      .filter((p) => p && !p.includes('/node_modules/'));
    expect(ignored).toEqual([]);
  });

  it('a scan database written into a fixture stays ignored', () => {
    const out = git('check-ignore', 'tests/fixtures/arch-rules/php/.mapx/mapx.db').trim();
    expect(out).toBe('tests/fixtures/arch-rules/php/.mapx/mapx.db');
  });
});
