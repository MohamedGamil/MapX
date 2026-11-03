import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn()
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn(),
    readFileSync: vi.fn()
  };
});

import {
  getGitBlobHashes,
  getChangedFiles,
  getCurrentCommitSha,
  getPreviousCommitSha,
  isGitRepo,
  getRepoName,
  discoverSubmodules
} from '../src/core/git-tracker.js';

describe('git-tracker module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getGitBlobHashes parses ls-tree output', () => {
    vi.mocked(execFileSync).mockReturnValue(
      '100644 blob aaaaaa111111\tsrc/main.ts\n100644 blob bbbbbb222222\tsrc/utils.ts\n'
    );

    const hashes = getGitBlobHashes('/mock-repo');
    expect(hashes.get('src/main.ts')).toBe('aaaaaa111111');
    expect(hashes.get('src/utils.ts')).toBe('bbbbbb222222');
    expect(execFileSync).toHaveBeenCalledWith('git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', 'HEAD'], expect.any(Object));
  });

  it('getGitBlobHashes handles error safely', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('Not a git repo');
    });

    const hashes = getGitBlobHashes('/mock-repo');
    expect(hashes.size).toBe(0);
  });

  it('getChangedFiles parses changed and cached files', () => {
    // First call for git diff --name-status
    vi.mocked(execFileSync).mockReturnValueOnce('M\tsrc/main.ts\nD\tsrc/old.ts\n');
    // Second call for cached/staged files
    vi.mocked(execFileSync).mockReturnValueOnce('A\tsrc/new.ts\n');

    const changed = getChangedFiles('/mock-repo');
    expect(changed).toHaveLength(3);
    expect(changed).toContainEqual({ path: 'src/main.ts', status: 'modified' });
    expect(changed).toContainEqual({ path: 'src/old.ts', status: 'removed' });
    expect(changed).toContainEqual({ path: 'src/new.ts', status: 'added' });
  });

  // M0-02-R3: a rename keeps its old path, and the diffs are relative to the repo folder.
  it('getChangedFiles keeps the old path of a rename and diffs with --relative', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('R087\tsrc/a.ts\tsrc/b.ts\nC100\tsrc/c.ts\tsrc/d.ts\n');
    vi.mocked(execFileSync).mockReturnValueOnce('R100\tsrc/e.ts\tsrc/f.ts\n');
    vi.mocked(execFileSync).mockReturnValueOnce('');

    expect(getChangedFiles('/mock-repo', 'abc123')).toEqual([
      { path: 'src/b.ts', status: 'renamed', oldPath: 'src/a.ts' },
      { path: 'src/d.ts', status: 'modified' },
      { path: 'src/f.ts', status: 'renamed', oldPath: 'src/e.ts' },
    ]);
    const commands = vi.mocked(execFileSync).mock.calls.map(([, args]) => args);
    expect(commands.slice(0, 2)).toEqual([
      ['-c', 'core.quotePath=false', 'diff', '--name-status', '--relative', 'abc123', '--'],
      ['-c', 'core.quotePath=false', 'diff', '--name-status', '--relative', '--cached'],
    ]);
  });

  it('getCurrentCommitSha and getPreviousCommitSha parse shas', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('sha123\n');
    expect(getCurrentCommitSha('/mock-repo')).toBe('sha123');

    vi.mocked(execFileSync).mockReturnValueOnce('sha456\n');
    expect(getPreviousCommitSha('/mock-repo')).toBe('sha456');
  });

  it('isGitRepo checks if dir has a git config', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('.git\n');
    expect(isGitRepo('/mock-repo')).toBe(true);

    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error(); });
    expect(isGitRepo('/mock-repo')).toBe(false);
  });

  it('getRepoName extracts repo name from git remote or folder', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('git@github.com:User/my-repo-name.git\n');
    expect(getRepoName('/mock-repo')).toBe('my-repo-name');

    // Fallback when remote fails
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error(); });
    expect(getRepoName('/mock-repo')).toBe('mock-repo');
  });

  it('discoverSubmodules parses .gitmodules file', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(`
[submodule "libs/foo"]
\tpath = libs/foo
\turl = https://github.com/user/foo.git
    `);

    const submodules = discoverSubmodules('/mock-repo');
    expect(submodules).toHaveLength(1);
    expect(submodules[0]).toEqual({
      name: 'libs/foo',
      path: 'libs/foo',
      url: 'https://github.com/user/foo.git',
      isInitialized: true
    });
  });
});
