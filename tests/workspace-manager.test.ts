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

  // ── discoverMonorepoPackages ────────────────────────────────────

  describe('discoverMonorepoPackages', () => {
    it('returns empty array when root has no monorepo structure', async () => {
      const root = join(tempDir, 'mono-empty');
      await mkdir(join(root, 'src'), { recursive: true });
      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(0);
    });

    it('returns empty array for nonexistent root', () => {
      expect(WorkspaceManager.discoverMonorepoPackages('/nonexistent/xyz')).toHaveLength(0);
    });

    it('discovers packages from npm package.json workspaces (array form)', async () => {
      const root = join(tempDir, 'mono-npm-ws');
      await mkdir(join(root, 'packages', 'core'), { recursive: true });
      await mkdir(join(root, 'packages', 'utils'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
      await writeFile(join(root, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@myorg/core' }));
      await writeFile(join(root, 'packages', 'utils', 'package.json'), JSON.stringify({ name: 'utils' }));

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(2);
      expect(results.map(r => r.name).sort()).toEqual(['core', 'utils']);
      expect(results[0].packageManager).toBe('npm');
      // @scope/ prefix stripped
      const coreResult = results.find(r => r.name === 'core');
      expect(coreResult?.name).toBe('core');
    });

    it('discovers packages from yarn workspaces (packages nested form)', async () => {
      const root = join(tempDir, 'mono-yarn-ws');
      await mkdir(join(root, 'apps', 'web'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: { packages: ['apps/*'] } }));
      await writeFile(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web' }));

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('web');
      expect(results[0].packageManager).toBe('yarn');
    });

    it('discovers packages from pnpm-workspace.yaml', async () => {
      const root = join(tempDir, 'mono-pnpm');
      await mkdir(join(root, 'apps', 'api'), { recursive: true });
      await mkdir(join(root, 'libs', 'shared'), { recursive: true });
      // Also has package.json workspaces — pnpm should win
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['other/*'] }));
      await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "libs/*"\n');
      await writeFile(join(root, 'apps', 'api', 'package.json'), JSON.stringify({ name: 'api' }));
      await writeFile(join(root, 'libs', 'shared', 'package.json'), JSON.stringify({ name: 'shared' }));

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results.map(r => r.name).sort()).toEqual(['api', 'shared']);
      expect(results[0].packageManager).toBe('pnpm');
    });

    it('discovers packages from lerna.json (defaults to packages/*)', async () => {
      const root = join(tempDir, 'mono-lerna');
      await mkdir(join(root, 'packages', 'alpha'), { recursive: true });
      await writeFile(join(root, 'lerna.json'), JSON.stringify({ version: '1.0.0' })); // no packages key
      await writeFile(join(root, 'packages', 'alpha', 'package.json'), JSON.stringify({ name: 'alpha' }));

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('alpha');
      expect(results[0].packageManager).toBe('npm');
    });

    it('discovers packages from lerna.json with explicit packages array', async () => {
      const root = join(tempDir, 'mono-lerna-explicit');
      await mkdir(join(root, 'apps', 'backend'), { recursive: true });
      await writeFile(join(root, 'lerna.json'), JSON.stringify({ packages: ['apps/*'] }));
      await writeFile(join(root, 'apps', 'backend', 'package.json'), JSON.stringify({ name: 'backend' }));

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('backend');
    });

    it('discovers packages from Cargo.toml workspace members', async () => {
      const root = join(tempDir, 'mono-cargo');
      await mkdir(join(root, 'crates', 'lib'), { recursive: true });
      await mkdir(join(root, 'crates', 'cli'), { recursive: true });
      await writeFile(join(root, 'Cargo.toml'), '[workspace]\nmembers = [\n  "crates/lib",\n  "crates/cli",\n]\n');
      await writeFile(join(root, 'crates', 'lib', 'Cargo.toml'), '[package]\nname = "mylib"\nversion = "0.1.0"\n');
      await writeFile(join(root, 'crates', 'cli', 'Cargo.toml'), '[package]\nname = "mycli"\nversion = "0.1.0"\n');

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(2);
      expect(results.map(r => r.name).sort()).toEqual(['mycli', 'mylib']);
      expect(results[0].packageManager).toBe('cargo');
    });

    it('discovers packages from go.work use block', async () => {
      const root = join(tempDir, 'mono-go');
      await mkdir(join(root, 'cmd', 'server'), { recursive: true });
      await mkdir(join(root, 'pkg', 'auth'), { recursive: true });
      await writeFile(join(root, 'go.work'), 'go 1.21\n\nuse (\n\t./cmd/server\n\t./pkg/auth\n)\n');
      await writeFile(join(root, 'cmd', 'server', 'go.mod'), 'module example.com/server\ngo 1.21\n');
      await writeFile(join(root, 'pkg', 'auth', 'go.mod'), 'module example.com/auth\ngo 1.21\n');

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(2);
      expect(results.map(r => r.path).sort()).toEqual(['cmd/server', 'pkg/auth']);
      expect(results[0].packageManager).toBe('go');
    });

    it('uses common dirs fallback when no manifest found', async () => {
      const root = join(tempDir, 'mono-fallback');
      await mkdir(join(root, 'apps', 'frontend'), { recursive: true });
      await mkdir(join(root, 'apps', 'backend'), { recursive: true });
      await writeFile(join(root, 'apps', 'frontend', 'package.json'), JSON.stringify({ name: 'frontend' }));
      await writeFile(join(root, 'apps', 'backend', 'package.json'), JSON.stringify({ name: 'backend' }));
      // No workspaces manifest at root

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(2);
      expect(results.map(r => r.name).sort()).toEqual(['backend', 'frontend']);
      expect(results[0].packageManager).toBe('inferred');
    });

    it('skips directories without a package manifest', async () => {
      const root = join(tempDir, 'mono-no-manifest');
      await mkdir(join(root, 'packages', 'has-pkg'), { recursive: true });
      await mkdir(join(root, 'packages', 'no-pkg'), { recursive: true }); // no manifest
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
      await writeFile(join(root, 'packages', 'has-pkg', 'package.json'), JSON.stringify({ name: 'has-pkg' }));

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('has-pkg');
    });

    it('skips directories that have their own .git (are separate repos)', async () => {
      const root = join(tempDir, 'mono-skip-git');
      await mkdir(join(root, 'packages', 'standalone'), { recursive: true });
      await mkdir(join(root, 'packages', 'standalone', '.git'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
      await writeFile(join(root, 'packages', 'standalone', 'package.json'), JSON.stringify({ name: 'standalone' }));

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(0);
    });

    it('strips @scope/ prefix from package.json name', async () => {
      const root = join(tempDir, 'mono-scope-strip');
      await mkdir(join(root, 'packages', 'ui'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
      await writeFile(join(root, 'packages', 'ui', 'package.json'), JSON.stringify({ name: '@acme/ui' }));

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('ui');
      expect(results[0].path).toBe('packages/ui');
    });

    it('falls back to directory name when no name in manifest', async () => {
      const root = join(tempDir, 'mono-no-name');
      await mkdir(join(root, 'packages', 'my-lib'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
      await writeFile(join(root, 'packages', 'my-lib', 'package.json'), JSON.stringify({})); // no name

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('my-lib');
    });

    it('does not double-count packages seen in multiple globs', async () => {
      const root = join(tempDir, 'mono-dedup');
      await mkdir(join(root, 'packages', 'shared'), { recursive: true });
      // Both patterns resolve to the same directory
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*', 'packages/shared'] }));
      await writeFile(join(root, 'packages', 'shared', 'package.json'), JSON.stringify({ name: 'shared' }));

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(1);
    });

    it('skips node_modules and other noise dirs in fallback scan', async () => {
      const root = join(tempDir, 'mono-skip-noise');
      await mkdir(join(root, 'node_modules', 'some-dep'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'some-dep', 'package.json'), JSON.stringify({ name: 'some-dep' }));
      // No workspace manifest — fallback would scan 'packages' etc, not node_modules

      const results = WorkspaceManager.discoverMonorepoPackages(root);
      expect(results).toHaveLength(0);
    });
  });
});
