import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  execSync: vi.fn()
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
    vi.mocked(execSync).mockReturnValue(
      '100644 blob aaaaaa111111\tsrc/main.ts\n100644 blob bbbbbb222222\tsrc/utils.ts\n'
    );

    const hashes = getGitBlobHashes('/mock-repo');
    expect(hashes.get('src/main.ts')).toBe('aaaaaa111111');
    expect(hashes.get('src/utils.ts')).toBe('bbbbbb222222');
    expect(execSync).toHaveBeenCalledWith('git ls-tree -r HEAD', expect.any(Object));
  });

  it('getGitBlobHashes handles error safely', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('Not a git repo');
    });

    const hashes = getGitBlobHashes('/mock-repo');
    expect(hashes.size).toBe(0);
  });

  it('getChangedFiles parses changed and cached files', () => {
    // First call for git diff --name-status
    vi.mocked(execSync).mockReturnValueOnce('M\tsrc/main.ts\nD\tsrc/old.ts\n');
    // Second call for cached/staged files
    vi.mocked(execSync).mockReturnValueOnce('A\tsrc/new.ts\n');

    const changed = getChangedFiles('/mock-repo');
    expect(changed).toHaveLength(3);
    expect(changed).toContainEqual({ path: 'src/main.ts', status: 'modified' });
    expect(changed).toContainEqual({ path: 'src/old.ts', status: 'removed' });
    expect(changed).toContainEqual({ path: 'src/new.ts', status: 'added' });
  });

  it('getCurrentCommitSha and getPreviousCommitSha parse shas', () => {
    vi.mocked(execSync).mockReturnValueOnce('sha123\n');
    expect(getCurrentCommitSha('/mock-repo')).toBe('sha123');

    vi.mocked(execSync).mockReturnValueOnce('sha456\n');
    expect(getPreviousCommitSha('/mock-repo')).toBe('sha456');
  });

  it('isGitRepo checks if dir has a git config', () => {
    vi.mocked(execSync).mockReturnValueOnce('.git\n');
    expect(isGitRepo('/mock-repo')).toBe(true);

    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error(); });
    expect(isGitRepo('/mock-repo')).toBe(false);
  });

  it('getRepoName extracts repo name from git remote or folder', () => {
    vi.mocked(execSync).mockReturnValueOnce('git@github.com:User/my-repo-name.git\n');
    expect(getRepoName('/mock-repo')).toBe('my-repo-name');

    // Fallback when remote fails
    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error(); });
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
