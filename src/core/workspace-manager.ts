import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { discoverSubmodules } from './git-tracker.js';
import type { SubmoduleInfo } from '../types.js';

export class WorkspaceManager {
  static discoverSubmodules(repoRoot: string): SubmoduleInfo[] {
    return discoverSubmodules(repoRoot);
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
