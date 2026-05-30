import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { discoverSubmodules } from './git-tracker.js';
import type { SubmoduleInfo } from '../types.js';

/** Directories that are never git repository roots and should be skipped during deep scan. */
const NESTED_SCAN_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', 'coverage',
  'vendor', '.mapx', '__pycache__', '.next', '.nuxt', '.output',
  'target', 'bin', 'obj', '.svn', '.hg', '.tox', 'venv', '.venv',
  '.yarn', '.pnpm-store', '.turbo', 'out', '.parcel-cache',
]);

export class WorkspaceManager {
  static discoverSubmodules(repoRoot: string): SubmoduleInfo[] {
    return discoverSubmodules(repoRoot);
  }

  /**
   * Recursively scan `rootDir` up to `maxDepth` levels deep looking for
   * directories that contain a `.git` entry (file or folder).  The root
   * directory itself is excluded; each discovered repo is returned only once
   * and recursion stops at that boundary.
   *
   * Common noise directories (node_modules, dist, .cache, …) are skipped
   * automatically.
   */
  static discoverNestedGitRepos(rootDir: string, maxDepth = 3): SubmoduleInfo[] {
    const results: SubmoduleInfo[] = [];
    const absRoot = resolve(rootDir);

    function walk(dir: string, depth: number): void {
      if (depth > maxDepth) return;
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (NESTED_SCAN_SKIP.has(entry.name)) continue;
        const absEntry = join(dir, entry.name);
        const gitPath = join(absEntry, '.git');
        if (existsSync(gitPath)) {
          results.push({
            name: entry.name,
            path: relative(absRoot, absEntry),
            url: '',
            isInitialized: true,
          });
          // Don't recurse into a nested git repo; its own submodules are
          // discoverable via discoverSubmodules() when that repo is targeted.
          continue;
        }
        walk(absEntry, depth + 1);
      }
    }

    walk(absRoot, 1);
    return results;
  }

  static discoverPeerRepos(workspaceRoot: string): SubmoduleInfo[] {
    const parentDir = dirname(resolve(workspaceRoot));
    if (!existsSync(parentDir)) return [];

    const peers: SubmoduleInfo[] = [];
    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === basename(workspaceRoot)) continue;

        const siblingPath = join(parentDir, entry.name);
        const gitPath = join(siblingPath, '.git');
        if (existsSync(gitPath)) {
          peers.push({
            name: entry.name,
            path: `../${entry.name}`,
            url: '',
            isInitialized: true,
          });
        }
      }
    } catch {
      // ignore
    }
    return peers;
  }

  static discoverVSCodeWorkspace(workspaceFile: string, workspaceRoot: string): SubmoduleInfo[] {
    if (!existsSync(workspaceFile)) return [];

    const repos: SubmoduleInfo[] = [];
    try {
      const content = readFileSync(workspaceFile, 'utf-8');
      // Simple parse allowing comments or basic trailing commas if possible, but JSON.parse is standard.
      const ws = JSON.parse(content);
      const wsDir = dirname(resolve(workspaceFile));

      if (ws && Array.isArray(ws.folders)) {
        for (const folder of ws.folders) {
          if (typeof folder.path === 'string') {
            const absFolder = resolve(wsDir, folder.path);
            if (absFolder === resolve(workspaceRoot)) continue;

            const gitPath = join(absFolder, '.git');
            if (existsSync(gitPath)) {
              const relPath = relative(resolve(workspaceRoot), absFolder);
              repos.push({
                name: folder.name || basename(absFolder),
                path: relPath,
                url: '',
                isInitialized: true,
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return repos;
  }
}
