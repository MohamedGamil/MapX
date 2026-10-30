// Per-repository summaries shared by `mapx workspaces`, `status --all`, `export --all` and the
// mapx_workspaces MCP tool (F18, M0-10-R1).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Store } from './store.js';
import type { RepoConfig } from '../types.js';
import { WorkspaceManager } from './workspace-manager.js';

export type RepoType = 'primary' | 'submodule' | 'peer' | 'vscode-workspace';

export interface RepoSummary {
  name: string;
  path: string;
  type: RepoType;
  files: number;
  symbols: number;
  edges: number;
  /** Edges from this repo into another registered repo. */
  crossRepoEdgeCount: number;
  lastScanned: string | null;
  /** Abbreviated HEAD commit of the repo's own git checkout. */
  head: string | null;
}

export interface CrossRepoPair {
  from: string;
  to: string;
  count: number;
  types: string[];
}

/** `*.code-workspace` files directly in `dir`. */
export function codeWorkspaceFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.code-workspace')).map(f => join(dir, f));
  } catch {
    return [];
  }
}

/** How a registered repo entered the workspace: the primary repo, a `.gitmodules` entry, a VS Code workspace folder, or a peer. */
export function repoType(dir: string, repo: RepoConfig, primaryName: string): RepoType {
  const abs = resolve(dir, repo.path);
  if (repo.name === primaryName || abs === resolve(dir)) return 'primary';
  if (WorkspaceManager.discoverSubmodules(dir).some(s => resolve(dir, s.path) === abs)) return 'submodule';
  for (const file of codeWorkspaceFiles(dir)) {
    if (WorkspaceManager.discoverVSCodeWorkspace(file, dir).some(f => resolve(dir, f.path) === abs)) return 'vscode-workspace';
  }
  return 'peer';
}

export function gitHead(repoDir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function crossRepoPairs(store: Store): CrossRepoPair[] {
  const rows = store.raw.prepare(
    `SELECT repo AS "from", target_repo AS "to", COUNT(*) AS count, GROUP_CONCAT(DISTINCT edge_type) AS types
     FROM edges WHERE target_repo IS NOT NULL AND target_repo != repo
     GROUP BY repo, target_repo ORDER BY count DESC, repo, target_repo`
  ).all() as { from: string; to: string; count: number; types: string | null }[];
  return rows.map(r => ({ from: r.from, to: r.to, count: Number(r.count), types: (r.types ?? '').split(',').filter(Boolean).sort() }));
}

export function summarizeRepos(dir: string, repos: RepoConfig[], primaryName: string, store: Store): RepoSummary[] {
  const outgoing = new Map<string, number>();
  for (const p of crossRepoPairs(store)) outgoing.set(p.from, (outgoing.get(p.from) ?? 0) + p.count);
  return repos.map(r => ({
    name: r.name,
    path: r.path,
    type: repoType(dir, r, primaryName),
    files: store.getFileCount(r.name),
    symbols: store.getSymbolCount(r.name),
    edges: store.getEdgeCount(r.name),
    crossRepoEdgeCount: outgoing.get(r.name) ?? 0,
    lastScanned: store.getMeta('last_scan_time:' + r.name) || null,
    head: gitHead(resolve(dir, r.path)),
  }));
}

/** "3 min ago", "2 hours ago", "never". */
export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(seconds)) return 'unknown';
  const units: [number, string][] = [[86400, 'day'], [3600, 'hour'], [60, 'min']];
  for (const [size, unit] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n === 1 || unit === 'min' ? '' : 's'} ago`;
  }
  return 'just now';
}

/** Fixed-width text table. */
export function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const line = (cells: string[]) => '  ' + cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(headers), '  ' + '─'.repeat(widths.reduce((a, w) => a + w + 2, -2)), ...rows.map(line)];
}
