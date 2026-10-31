// Per-repository summaries shared by `mapx workspaces`, `status --all`, `export --all` /
// mapx_export {all}, `deps --cross-repo` / mapx_dependencies {crossRepo} and the mapx_workspaces
// MCP tool (F18, M0-10-R1, M0-10-R2).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Store } from './store.js';
import type { RepoConfig } from '../types.js';
import type { LLMExporter } from '../exporters/llm-exporter.js';
import { WorkspaceManager } from './workspace-manager.js';

/** `folder`: a registered directory with no checkout of its own, such as a monorepo package. */
export type RepoType = 'primary' | 'submodule' | 'peer' | 'vscode-workspace' | 'folder';

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
  /** Abbreviated HEAD commit of the repo's own checkout; null for a folder without one. */
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

/** True when `dir` is the root of its own checkout (a `.git` directory, or a submodule's `.git` file). */
export function hasOwnGit(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * How a registered repo entered the workspace: the primary repo, a `.gitmodules` entry, a VS Code
 * workspace folder, a peer repo, or a plain folder. Paths compare with symlinks resolved (M0-10-R2).
 */
export function repoType(dir: string, repo: RepoConfig, primaryName: string): RepoType {
  const key = WorkspaceManager.repoKey(dir, repo.path);
  if (repo.name === primaryName || key === WorkspaceManager.repoKey(dir, '.')) return 'primary';
  if (WorkspaceManager.discoverSubmodules(dir).some(s => WorkspaceManager.repoKey(dir, s.path) === key)) return 'submodule';
  for (const file of codeWorkspaceFiles(dir)) {
    if (WorkspaceManager.discoverVSCodeWorkspace(file, dir).some(f => WorkspaceManager.repoKey(dir, f.path) === key)) return 'vscode-workspace';
  }
  return hasOwnGit(resolve(dir, repo.path)) ? 'peer' : 'folder';
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
  return repos.map(r => {
    const type = repoType(dir, r, primaryName);
    const abs = resolve(dir, r.path);
    return {
      name: r.name,
      path: r.path,
      type,
      files: store.getFileCount(r.name),
      symbols: store.getSymbolCount(r.name),
      edges: store.getEdgeCount(r.name),
      crossRepoEdgeCount: outgoing.get(r.name) ?? 0,
      lastScanned: store.getMeta('last_scan_time:' + r.name) || null,
      // `rev-parse` in a plain folder answers with the enclosing checkout's HEAD; only the
      // primary repo and real checkouts report one (M0-10-R2).
      head: type === 'primary' || hasOwnGit(abs) ? gitHead(abs) : null,
    };
  });
}

/**
 * `export --all` / mapx_export {all}: the repo list, cross-repo dependencies, then one section per
 * repo sharing the token budget. Each repo's own export nests two levels below its `## <repo>`
 * heading (M0-10-R1, M0-10-R2).
 */
export function workspaceExport(
  dir: string, repos: RepoConfig[], primaryName: string, store: Store,
  exporter: LLMExporter, tokenBudget: number, keptFiles: string[],
): string {
  const summaries = summarizeRepos(dir, repos, primaryName, store);
  const pairs = crossRepoPairs(store);
  const kept = new Set(keptFiles);
  const parts = [
    `# Workspace: ${primaryName}`,
    '',
    `## Repos (${summaries.length})`,
    ...summaries.map(r => `- ${r.name} (${r.type}) — ${r.files} files, ${r.symbols} symbols`),
    '',
    `## Cross-repo dependencies (${pairs.reduce((a, p) => a + p.count, 0)} edges)`,
    ...(pairs.length ? pairs.map(p => `${p.from} → ${p.to}: ${p.count} ${p.types.join('/')}`) : ['none']),
  ];
  const budget = Math.max(512, Math.floor(tokenBudget / Math.max(1, summaries.length)));
  for (const r of summaries) {
    const files = store.getAllFiles(r.name).map(f => f.path as string).filter(f => kept.has(f));
    const section = exporter.export({ format: 'llm', tokenBudget: budget, repo: r.name, files });
    parts.push('', `## ${r.name}`, '', section.replace(/^(#{1,4}) /gm, '$1## '));
  }
  return parts.join('\n');
}

/** `deps <file> --cross-repo` / mapx_dependencies {crossRepo}: edges whose two ends live in different repos (M0-10-R1). */
export function crossRepoDependencies(store: Store, file: string): string[] {
  const out = store.raw.prepare(
    'SELECT DISTINCT target_file, edge_type, target_repo FROM edges WHERE source_file = ? AND target_repo IS NOT NULL AND target_repo != repo ORDER BY target_file, edge_type'
  ).all(file) as { target_file: string; edge_type: string; target_repo: string }[];
  const inc = store.raw.prepare(
    'SELECT DISTINCT source_file, edge_type, repo FROM edges WHERE target_file = ? AND target_repo IS NOT NULL AND target_repo != repo ORDER BY source_file, edge_type'
  ).all(file) as { source_file: string; edge_type: string; repo: string }[];
  if (!out.length && !inc.length) return ['No cross-repo dependencies found'];
  const lines: string[] = [];
  if (out.length) lines.push('Cross-repo dependencies:', ...out.map(e => `  → [${e.target_repo}] ${e.target_file} (${e.edge_type})`));
  if (inc.length) lines.push(...(out.length ? [''] : []), 'Cross-repo dependents:', ...inc.map(e => `  ← [${e.repo}] ${e.source_file} (${e.edge_type})`));
  return lines;
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
