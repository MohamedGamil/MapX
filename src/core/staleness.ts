// Is the graph index stale? Shared by CLI and MCP (docs/baton M0-11-R1): a file counts as changed
// only if its content differs from what was scanned (a rewrite with identical content is not
// stale), deleted files count, and new untracked files count when a scan would index them.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Store } from './store.js';
import type { MapxConfig, RepoConfig } from '../types.js';
import { getLanguageForFile } from '../languages/registry.js';
import { effectiveExcludesFor, isScannableDir, isScannablePath, shebangLanguage } from './file-rules.js';

export interface StaleReport {
  changed: string[];
  deleted: string[];
  added: string[];
}

/**
 * Would a scan index this workspace-relative file? The scanner's own rules (M0-11-R2): the file
 * belongs to a registered repo, passes that repo's filters from its last scan (`scan_filters:<repo>`,
 * which include CLI `--include` / `--exclude`; computed from config.json before any scan), and has
 * a known language. Before, only settings.excludePatterns applied, so files outside includePatterns,
 * Laravel's default excludes and dotfiles were reported "(new)" forever.
 */
export function scannableFilter(store: Store, dir: string): (path: string) => boolean {
  return scanRules(store, dir).file;
}

/** The scanner's rules for files and folders of the workspace, per registered repo. */
function scanRules(store: Store, dir: string): { file: (path: string) => boolean; dir: (relDir: string) => boolean } {
  let config: Partial<MapxConfig> = {};
  try {
    config = JSON.parse(readFileSync(join(dir, '.mapx', 'config.json'), 'utf-8'));
  } catch {
    // no config: settings defaults, one repo at the root
  }
  const settings = config.settings ?? ({} as MapxConfig['settings']);
  const repos = (config.repos?.length ? config.repos : [{ name: '', path: '.' } as RepoConfig])
    .map(repo => ({ repo, prefix: !repo.path || repo.path === '.' ? '' : `${repo.path.replace(/^\.\//, '').replace(/\/+$/, '')}/` }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const filters = new Map<string, { excludes: string[]; includes: string[] }>();
  const filtersFor = (repo: RepoConfig) => {
    if (!filters.has(repo.name)) {
      let stored: { excludes?: string[]; includes?: string[] } | null = null;
      try {
        stored = JSON.parse(store.getMeta('scan_filters:' + repo.name) ?? 'null');
      } catch {
        stored = null;
      }
      filters.set(repo.name, {
        excludes: stored?.excludes ?? effectiveExcludesFor(settings, repo),
        includes: stored?.includes ?? settings.includePatterns ?? [],
      });
    }
    return filters.get(repo.name)!;
  };
  const file = (path: string) => {
    const owner = repos.find(r => path.startsWith(r.prefix));
    if (!owner) return false;
    const { excludes, includes } = filtersFor(owner.repo);
    if (!isScannablePath(path, excludes, includes, owner.prefix)) return false;
    return getLanguageForFile(path) !== null || (!basename(path).includes('.') && shebangLanguage(resolve(dir, path)) !== null);
  };
  // A folder the walk enters: inside a repo, by that repo's pruning rules; outside every repo, only
  // when a registered repo lies below it.
  const folder = (relDir: string) => {
    const owner = repos.find(r => `${relDir}/`.startsWith(r.prefix));
    if (!owner) return repos.some(r => r.prefix.startsWith(`${relDir}/`));
    if (`${relDir}/` === owner.prefix) return true;
    return isScannableDir(relDir, filtersFor(owner.repo).excludes, owner.prefix);
  };
  return { file, dir: folder };
}

/**
 * Files a scan would index that the index does not hold, found by walking the workspace with the
 * scanner's rules (M5-05). Unlike the git listing, it sees new files in a workspace that is not a
 * git repository and in nested repos; it costs a directory walk, so only `mapx check` uses it.
 */
function walkedNewFiles(store: Store, dir: string, known: Set<string>): string[] {
  const rules = scanRules(store, dir);
  const out: string[] = [];
  const visit = (rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (rules.dir(path)) visit(path);
      } else if (e.isFile() && !known.has(path) && rules.file(path)) {
        out.push(path);
      }
    }
  };
  visit('');
  return out;
}

/** New source files git does not track yet and the index has not seen, if a scan would index them. */
function untrackedSourceFiles(store: Store, dir: string, known: Set<string>): string[] {
  let out = '';
  try {
    out = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26,
    });
  } catch {
    return [];
  }
  const scannable = scannableFilter(store, dir);
  return out.split('\n').filter(p => p && !p.endsWith('/') && !known.has(p) && scannable(p));
}

export interface StaleOptions {
  /** Find new files by walking the workspace (every repo, git or not) instead of asking git. */
  walk?: boolean;
}

export function findStaleFiles(store: Store, dir: string, options: StaleOptions = {}): StaleReport {
  const report: StaleReport = { changed: [], deleted: [], added: [] };
  try {
    const files = store.getAllFiles();
    for (const file of files) {
      const path = file.path as string;
      const abs = resolve(dir, path);
      if (!existsSync(abs)) {
        report.deleted.push(path);
        continue;
      }
      const scannedAt = new Date(file.last_scanned as string).getTime();
      if (statSync(abs).mtimeMs <= scannedAt) continue;
      // Touched since the scan: stale only if the content really differs.
      const stored = file.content_hash as string | null;
      if (stored) {
        const hash = createHash('md5').update(readFileSync(abs, 'utf-8')).digest('hex');
        if (hash === stored) continue;
      }
      report.changed.push(path);
    }
    const known = new Set(files.map(f => f.path as string));
    report.added = options.walk ? walkedNewFiles(store, dir, known) : untrackedSourceFiles(store, dir, known);
  } catch {
    // An unreadable index is reported elsewhere; never fail a query on staleness.
  }
  return report;
}

export const staleCount = (r: StaleReport) => r.changed.length + r.deleted.length + r.added.length;

/** Up to `max` names: changed first, then `(deleted)` and `(new)` entries. */
export function staleNames(r: StaleReport, max = 5): string[] {
  return [...r.changed, ...r.deleted.map(p => `${p} (deleted)`), ...r.added.map(p => `${p} (new)`)].slice(0, max);
}

/**
 * The git changes a status should report (M0-11-R3): those a scan would index, and those touching a
 * file the index holds (a removed or renamed indexed file, whatever the rules say of its new name).
 * `changes` are relative to `repoRoot`.
 */
export function indexableChanges<T extends { path: string; oldPath?: string; status: string }>(store: Store, dir: string, repoRoot: string, changes: T[], repoName?: string): T[] {
  const scannable = scannableFilter(store, dir);
  const prefix = relative(dir, repoRoot).replace(/\\/g, '/');
  const at = (p: string) => (prefix ? `${prefix}/${p}` : p);
  const kept = changes.filter(c => scannable(at(c.path)) || !!store.getFile(at(c.path)) || (!!c.oldPath && !!store.getFile(at(c.oldPath))));
  // An indexed file of this repo edited or deleted since the scan that git does not list
  // (gitignored): a change too (M0-02-R8). Another registered repo's files are its own status.
  const listed = new Set(kept.flatMap(c => (c.oldPath ? [at(c.path), at(c.oldPath)] : [at(c.path)])));
  const ownPrefix = prefix ? `${prefix}/` : '';
  const stale = findStaleFiles(store, dir);
  const own = (path: string) => !listed.has(path) && (!ownPrefix || path.startsWith(ownPrefix))
    && (!repoName || store.getFile(path)?.repo === repoName);
  for (const path of stale.changed.filter(own)) kept.push({ path: path.slice(ownPrefix.length), status: 'modified' } as T);
  for (const path of stale.deleted.filter(own)) kept.push({ path: path.slice(ownPrefix.length), status: 'removed' } as T);
  return kept;
}
