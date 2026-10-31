// Is the graph index stale? Shared by CLI and MCP (docs/baton M0-11-R1): a file counts as changed
// only if its content differs from what was scanned (a rewrite with identical content is not
// stale), deleted files count, and new untracked files count when a scan would index them.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Store } from './store.js';
import type { MapxConfig, RepoConfig } from '../types.js';
import { getLanguageForFile } from '../languages/registry.js';
import { effectiveExcludesFor, isScannablePath, shebangLanguage } from './file-rules.js';

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
function scannableFilter(store: Store, dir: string): (path: string) => boolean {
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
  return (path: string) => {
    const owner = repos.find(r => path.startsWith(r.prefix));
    if (!owner) return false;
    const { excludes, includes } = filtersFor(owner.repo);
    if (!isScannablePath(path, excludes, includes, owner.prefix)) return false;
    return getLanguageForFile(path) !== null || (!basename(path).includes('.') && shebangLanguage(resolve(dir, path)) !== null);
  };
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

export function findStaleFiles(store: Store, dir: string): StaleReport {
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
    report.added = untrackedSourceFiles(store, dir, new Set(files.map(f => f.path as string)));
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
