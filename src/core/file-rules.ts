// Which files a scan indexes. Shared by the scanner and the staleness check, so the "graph may be
// stale" warning only reports files a scan would pick up (M0-11-R2).
import { closeSync, openSync, readSync } from 'node:fs';
import picomatch from 'picomatch';

// Each glob compiled once: `picomatch.isMatch` recompiles its pattern on every call, and the scan
// walk and git sync test every path (review 2026-10-31).
const compiled = new Map<string, (path: string) => boolean>();
const globMatch = (path: string, pattern: string) => {
  let match = compiled.get(pattern);
  if (!match) compiled.set(pattern, (match = picomatch(pattern, { dot: true })));
  return match(path);
};
import { LARAVEL_DEFAULT_EXCLUDES } from './config.js';
import { languageFromShebang } from '../languages/registry.js';
import type { MapxConfig, RepoConfig } from '../types.js';

/** Directory and file names the scan walk never enters; dot-prefixed names are skipped too. */
export const DEFAULT_IGNORE = new Set([
  'node_modules', 'vendor', '.git', 'dist', '.mapx', '__pycache__',
  '.next', '.nuxt', 'coverage', '.cache', '.turbo', 'target', 'build',
  '.gradle', '.idea', '.vscode', '.vs',
]);

/** Language of an extensionless script from its `#!` line (reads at most 256 bytes). */
export function shebangLanguage(path: string) {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = readSync(fd, buf, 0, 256, 0);
      return languageFromShebang(buf.subarray(0, n).toString('utf-8').split('\n')[0] ?? '');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Paths are matched with `/` and no leading `./`, so `./app/**` and Windows-style `app\Models\**`
 * name the same files as `app/**` and `app/Models/**` (M0-02-R2).
 */
export function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

export function buildMatcher(excludes: string[], includes: string[]): (rel: string) => boolean {
  excludes = excludes.map(normalizePattern);
  includes = includes.map(normalizePattern);
  return (rel: string) => {
    if (excludes.some(p => {
      if (globMatch(rel, p)) return true;
      const segments = rel.split('/');
      if (segments.some(seg => seg === p)) return true;
      return false;
    })) {
      return false;
    }
    if (includes.length > 0) {
      const matched = includes.some(p => {
        if (globMatch(rel, p)) return true;
        const segments = rel.split('/');
        if (segments.some(seg => seg === p)) return true;
        return false;
      });
      if (!matched) return false;
    }
    return true;
  };
}

/**
 * Prune a directory when the pattern names it (`**\/generated`, `packages/*\/generated`,
 * `app/Http/**`, an exact path or a bare directory name). A pattern ending in a bare `/*`
 * means the files directly in that directory: `app/Http/*` does not prune
 * app/Http/Controllers (M0-02-R1). Never match against a synthetic file name: `**\/_*`
 * must not prune every directory (review 2026-10-31).
 */
export function isExcludedDir(relDir: string, excludes: string[]): boolean {
  return excludes.some(p => {
    const pattern = normalizePattern(p).replace(/\/+$/, '');
    if (!pattern.endsWith('/*') && globMatch(relDir, pattern)) return true;
    if (pattern.endsWith('/**') && globMatch(relDir, pattern.slice(0, -3))) return true;
    return relDir.split('/').some(seg => seg === pattern);
  });
}

/**
 * The matcher plus the walk's directory pruning, for filtering indexed paths: `--exclude '**\/Http'`
 * leaves out app/Http/… in exports as it does at scan time (M0-02-R7).
 */
export function buildPathFilter(excludes: string[], includes: string[]): (rel: string) => boolean {
  const matcher = buildMatcher(excludes, includes);
  return (rel: string) => {
    const segments = rel.split('/');
    for (let i = 1; i < segments.length; i++) {
      if (isExcludedDir(segments.slice(0, i).join('/'), excludes)) return false;
    }
    return matcher(rel);
  };
}

/**
 * Config + CLI excludes, plus Laravel's defaults for `framework: laravel` repos (F10):
 * `laravelDefaultExcludes` false declines them, a list keeps only the defaults it names (M0-02-R2).
 */
export function effectiveExcludesFor(
  settings: Pick<MapxConfig['settings'], 'excludePatterns' | 'laravelDefaultExcludes'>,
  repo: Pick<RepoConfig, 'path' | 'framework'> | undefined,
  cliExcludes: string[] = [],
): string[] {
  const excludes = [...(settings.excludePatterns ?? []), ...cliExcludes].map(normalizePattern);
  const laravelDefaults = settings.laravelDefaultExcludes;
  if (repo?.framework === 'laravel' && laravelDefaults !== false) {
    const prefix = !repo.path || repo.path === '.' ? '' : `${repo.path.replace(/^\.\//, '').replace(/\/+$/, '')}/`;
    for (const p of Array.isArray(laravelDefaults) ? laravelDefaults.map(normalizePattern) : LARAVEL_DEFAULT_EXCLUDES) {
      const scoped = p.startsWith('**/') ? p : `${prefix}${p}`;
      if (!excludes.includes(scoped)) excludes.push(scoped);
    }
  }
  return excludes;
}

/** Would the scan walk enter this workspace-relative folder? The segment and pruning rules of `isScannablePath`. */
export function isScannableDir(relDir: string, excludes: string[], repoPath = ''): boolean {
  const segments = relDir.split('/');
  const start = repoPath ? repoPath.split('/').filter(Boolean).length : 0;
  if (segments.slice(start).some(s => DEFAULT_IGNORE.has(s) || s.startsWith('.'))) return false;
  for (let i = start + 1; i <= segments.length; i++) {
    if (isExcludedDir(segments.slice(0, i).join('/'), excludes)) return false;
  }
  return true;
}

/**
 * Would the scan walk reach this workspace-relative file? Same rules as `Scanner.discoverFiles`:
 * no ignored or dot-prefixed segment, no pruned ancestor directory, and the include/exclude
 * matcher accepts it. The language check is separate (it may need to read the file). `repoPath` is
 * the repo's workspace-relative folder ('' at the root): as in the walk, which starts there, the
 * segment and directory rules apply below it only. A caller testing many paths passes `matcher`,
 * `buildMatcher(excludes, includes)` built once (M5-05-R1 review).
 */
export function isScannablePath(
  rel: string, excludes: string[], includes: string[], repoPath = '', matcher?: (rel: string) => boolean,
): boolean {
  const segments = rel.split('/');
  const start = repoPath ? repoPath.split('/').filter(Boolean).length : 0;
  if (segments.slice(start).some(s => DEFAULT_IGNORE.has(s) || s.startsWith('.'))) return false;
  for (let i = start + 1; i < segments.length; i++) {
    if (isExcludedDir(segments.slice(0, i).join('/'), excludes)) return false;
  }
  return (matcher ?? buildMatcher(excludes, includes))(rel);
}
