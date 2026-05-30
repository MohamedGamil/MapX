import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkspaceManager } from '../src/core/workspace-manager.js';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('WorkspaceManager module', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mapx-workspace-test-'));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('discoverPeerRepos lists git directories in parent directory', async () => {
    const parent = join(tempDir, 'parent');
    await mkdir(parent);
    
    const currentRepo = join(parent, 'current');
    const sibling1 = join(parent, 'sibling-git');
    const sibling2 = join(parent, 'sibling-nongit');

    await mkdir(currentRepo);
    await mkdir(sibling1);
    await mkdir(sibling2);

    // Make sibling1 a git repo
    await mkdir(join(sibling1, '.git'));

    const peers = WorkspaceManager.discoverPeerRepos(currentRepo);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toEqual({
      name: 'sibling-git',
      path: '../sibling-git',
      url: '',
      isInitialized: true
    });
  });

  it('discoverVSCodeWorkspace parses vscode workspace configurations', async () => {
    const root = join(tempDir, 'root');
    await mkdir(root);

    const folder1 = join(root, 'folder1');
    const folder2 = join(root, 'folder2');
    await mkdir(folder1);
    await mkdir(folder2);
    await mkdir(join(folder1, '.git'));
    await mkdir(join(folder2, '.git'));

    const workspaceFile = join(root, 'project.code-workspace');
    await writeFile(workspaceFile, JSON.stringify({
      folders: [
        { path: 'folder1' },
        { path: 'folder2' },
        { path: '.' }
      ]
    }));

    const repos = WorkspaceManager.discoverVSCodeWorkspace(workspaceFile, root);
    expect(repos).toHaveLength(2);
    expect(repos.map(r => r.name)).toContain('folder1');
    expect(repos.map(r => r.name)).toContain('folder2');
  });

  it('discoverSubmodules delegates to discoverSubmodules', () => {
    // Just a sanity check that it runs
    const subs = WorkspaceManager.discoverSubmodules('/nonexistent');
    expect(subs).toEqual([]);
  });

  // ── discoverNestedGitRepos ──────────────────────────────────────

  describe('discoverNestedGitRepos', () => {
    it('finds a git repo 1 level deep', async () => {
      const root = join(tempDir, 'nested-depth1');
      const child = join(root, 'app');
      await mkdir(root, { recursive: true });
      await mkdir(join(child, '.git'), { recursive: true });

      const results = WorkspaceManager.discoverNestedGitRepos(root);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('app');
      expect(results[0].path).toBe('app');
      expect(results[0].isInitialized).toBe(true);
    });

    it('finds repos 2 levels deep', async () => {
      const root = join(tempDir, 'nested-depth2');
      const mid = join(root, 'packages');
      const deep = join(mid, 'lib');
      await mkdir(join(deep, '.git'), { recursive: true });

      const results = WorkspaceManager.discoverNestedGitRepos(root);
      expect(results.some(r => r.name === 'lib')).toBe(true);
      expect(results.find(r => r.name === 'lib')?.path).toBe('packages/lib');
    });

    it('finds repos 3 levels deep', async () => {
      const root = join(tempDir, 'nested-depth3');
      const deep = join(root, 'a', 'b', 'c');
      await mkdir(join(deep, '.git'), { recursive: true });

      const results = WorkspaceManager.discoverNestedGitRepos(root);
      expect(results.some(r => r.name === 'c')).toBe(true);
    });

    it('does NOT find repos 4 levels deep (exceeds maxDepth=3)', async () => {
      const root = join(tempDir, 'nested-depth4');
      const tooDeep = join(root, 'a', 'b', 'c', 'd');
      await mkdir(join(tooDeep, '.git'), { recursive: true });

      const results = WorkspaceManager.discoverNestedGitRepos(root);
      expect(results.some(r => r.name === 'd')).toBe(false);
    });

    it('respects custom maxDepth', async () => {
      const root = join(tempDir, 'nested-custom-depth');
      const level2 = join(root, 'a', 'b');
      const level3 = join(root, 'x', 'y', 'z');
      await mkdir(join(level2, '.git'), { recursive: true });
      await mkdir(join(level3, '.git'), { recursive: true });

      const shallow = WorkspaceManager.discoverNestedGitRepos(root, 2);
      expect(shallow.some(r => r.name === 'b')).toBe(true);
      expect(shallow.some(r => r.name === 'z')).toBe(false); // 3 levels deep, excluded

      const deep = WorkspaceManager.discoverNestedGitRepos(root, 3);
      expect(deep.some(r => r.name === 'z')).toBe(true);
    });

    it('skips node_modules directory', async () => {
      const root = join(tempDir, 'nested-skip-nm');
      const nm = join(root, 'node_modules', 'some-pkg');
      await mkdir(join(nm, '.git'), { recursive: true });

      const results = WorkspaceManager.discoverNestedGitRepos(root);
      expect(results).toHaveLength(0);
    });

    it('skips dist, build, and other noise directories', async () => {
      const root = join(tempDir, 'nested-skip-noise');
      for (const noise of ['dist', 'build', '.cache', 'vendor', 'coverage']) {
        await mkdir(join(root, noise, 'repo', '.git'), { recursive: true });
      }

      const results = WorkspaceManager.discoverNestedGitRepos(root);
      expect(results).toHaveLength(0);
    });

    it('does not recurse into a nested git repo', async () => {
      const root = join(tempDir, 'nested-no-recurse');
      const outer = join(root, 'outer');
      const inner = join(outer, 'inner');
      // Both outer and inner are git repos
      await mkdir(join(outer, '.git'), { recursive: true });
      await mkdir(join(inner, '.git'), { recursive: true });

      const results = WorkspaceManager.discoverNestedGitRepos(root);
      // Only outer should appear; inner is nested inside a git repo
      expect(results.some(r => r.name === 'outer')).toBe(true);
      expect(results.some(r => r.name === 'inner')).toBe(false);
    });

    it('finds multiple repos at the same level', async () => {
      const root = join(tempDir, 'nested-multi');
      for (const name of ['app-a', 'app-b', 'app-c']) {
        await mkdir(join(root, 'apps', name, '.git'), { recursive: true });
      }

      const results = WorkspaceManager.discoverNestedGitRepos(root);
      expect(results).toHaveLength(3);
      expect(results.map(r => r.name).sort()).toEqual(['app-a', 'app-b', 'app-c']);
    });

    it('returns empty array when no nested git repos exist', async () => {
      const root = join(tempDir, 'nested-empty');
      await mkdir(join(root, 'src', 'core'), { recursive: true });
      await mkdir(join(root, 'tests'), { recursive: true });

      const results = WorkspaceManager.discoverNestedGitRepos(root);
      expect(results).toHaveLength(0);
    });

    it('returns empty array for nonexistent root', () => {
      const results = WorkspaceManager.discoverNestedGitRepos('/nonexistent/path/xyz');
      expect(results).toHaveLength(0);
    });
  });
});
