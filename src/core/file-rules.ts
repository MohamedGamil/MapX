// Which files a scan indexes. Shared by the scanner and the staleness check, so the "graph may be
// stale" warning only reports files a scan would pick up (M0-11-R2).
import { closeSync, openSync, readSync } from 'node:fs';
import picomatch from 'picomatch';
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

export function buildMatcher(excludes: string[], includes: string[]): (rel: string) => boolean {
  return (rel: string) => {
    if (excludes.some(p => {
      if (picomatch.isMatch(rel, p, { dot: true })) return true;
      const segments = rel.split('/');
      if (segments.some(seg => seg === p)) return true;
      return false;
    })) {
      return false;
    }
    if (includes.length > 0) {
      const matched = includes.some(p => {
        if (picomatch.isMatch(rel, p, { dot: true })) return true;
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
    const pattern = p.replace(/\/+$/, '');
    if (!pattern.endsWith('/*') && picomatch.isMatch(relDir, pattern, { dot: true })) return true;
    if (pattern.endsWith('/**') && picomatch.isMatch(relDir, pattern.slice(0, -3), { dot: true })) return true;
    return relDir.split('/').some(seg => seg === pattern);
  });
}

/** Config + CLI excludes, plus Laravel's defaults for `framework: laravel` repos unless declined (F10). */
export function effectiveExcludesFor(
  settings: Pick<MapxConfig['settings'], 'excludePatterns' | 'laravelDefaultExcludes'>,
  repo: Pick<RepoConfig, 'path' | 'framework'> | undefined,
  cliExcludes: string[] = [],
): string[] {
  const excludes = [...(settings.excludePatterns ?? []), ...cliExcludes];
  if (repo?.framework === 'laravel' && settings.laravelDefaultExcludes !== false) {
    const prefix = !repo.path || repo.path === '.' ? '' : `${repo.path.replace(/^\.\//, '').replace(/\/+$/, '')}/`;
    for (const p of LARAVEL_DEFAULT_EXCLUDES) {
      const scoped = p.startsWith('**/') ? p : `${prefix}${p}`;
      if (!excludes.includes(scoped)) excludes.push(scoped);
    }
  }
  return excludes;
}

/**
 * Would the scan walk reach this workspace-relative file? Same rules as `Scanner.discoverFiles`:
 * no ignored or dot-prefixed segment, no pruned ancestor directory, and the include/exclude
 * matcher accepts it. The language check is separate (it may need to read the file).
 */
export function isScannablePath(rel: string, excludes: string[], includes: string[]): boolean {
  const segments = rel.split('/');
  if (segments.some(s => DEFAULT_IGNORE.has(s) || s.startsWith('.'))) return false;
  for (let i = 1; i < segments.length; i++) {
    if (isExcludedDir(segments.slice(0, i).join('/'), excludes)) return false;
  }
  return buildMatcher(excludes, includes)(rel);
}
