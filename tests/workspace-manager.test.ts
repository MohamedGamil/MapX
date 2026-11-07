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
});
