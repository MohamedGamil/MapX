// Is the graph index stale? Shared by CLI and MCP (docs/baton M0-11-R1): a file counts as changed
// only if its content differs from what was scanned (a rewrite with identical content is not
// stale), deleted files count, and new files count when a scan would index them.
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Store } from './store.js';
import type { MapxConfig, RepoConfig } from '../types.js';
import { getBuiltinLanguages, getLanguageForFile } from '../languages/registry.js';
import { DEFAULT_IGNORE, buildMatcher, effectiveExcludesFor, isExcludedDir, isScannablePath, shebangLanguage } from './file-rules.js';

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

/** How the walk treats a folder: index its files, only pass through it to a registered repo below, or skip it. */
type FolderMode = 'scan' | 'pass' | 'skip';

interface ScanRules {
  /** Any workspace-relative path, every rule tested. */
  file: (path: string) => boolean;
  /** A file name the walk reached in a `scan` folder, tested before its path is built: its language by name, or null. */
  candidate: (name: string) => 'yes' | 'shebang' | null;
  /** A candidate's path: its folders already passed, so only the globs (and a shebang) are tested. */
  walkedFile: (path: string, lang: 'yes' | 'shebang') => boolean;
  /** A folder the walk reached, from its parent's mode. */
  folder: (relDir: string, name: string, parent: FolderMode) => FolderMode;
  /** The workspace root's mode. */
  root: FolderMode;
}

/**
 * The scanner's rules for files and folders of the workspace, per registered repo. Each repo's
 * matcher is built once, and a file's language (an extension lookup) is tested before any glob, so
 * a folder of thousands of images costs a directory listing (M5-05-R1 review).
 */
function scanRules(store: Store, dir: string): ScanRules {
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
  const filters = new Map<string, { excludes: string[]; includes: string[]; matcher: (rel: string) => boolean }>();
  const filtersFor = (repo: RepoConfig) => {
    if (!filters.has(repo.name)) {
      let stored: { excludes?: string[]; includes?: string[] } | null = null;
      try {
        stored = JSON.parse(store.getMeta('scan_filters:' + repo.name) ?? 'null');
      } catch {
        stored = null;
      }
      const excludes = stored?.excludes ?? effectiveExcludesFor(settings, repo);
      const includes = stored?.includes ?? settings.includePatterns ?? [];
      filters.set(repo.name, { excludes, includes, matcher: buildMatcher(excludes, includes) });
    }
    return filters.get(repo.name)!;
  };
  const ownerOf = (path: string) => repos.find(r => path.startsWith(r.prefix));
  // `getLanguageForFile` over the built-in languages, as sets, built when the walk first needs them.
  let extensions: Set<string> | null = null;
  const filenames = new Set<string>();
  // By name alone: a known language, maybe one (an extensionless file, by its shebang), or none.
  const language = (name: string): 'yes' | 'shebang' | null => {
    if (!extensions) {
      extensions = new Set();
      for (const lang of Object.values(getBuiltinLanguages())) {
        for (const e of lang.extensions) extensions.add(e);
        for (const f of lang.filenames ?? []) filenames.add(f);
      }
    }
    if (filenames.has(name)) return 'yes';
    const dot = name.lastIndexOf('.');
    if (dot < 0) return 'shebang';
    return extensions.has(name.slice(dot).toLowerCase()) ? 'yes' : null;
  };
  // The language before the globs; an extensionless file's shebang is read last.
  const accepts = (path: string, lang: 'yes' | 'shebang' | null, globs: (path: string) => boolean) =>
    !!lang && globs(path) && (lang === 'yes' || shebangLanguage(resolve(dir, path)) !== null);
  const file = (path: string) => {
    const owner = ownerOf(path);
    if (!owner) return false;
    const { excludes, includes, matcher } = filtersFor(owner.repo);
    const lang = getLanguageForFile(path) ? 'yes' : basename(path).includes('.') ? null : 'shebang';
    return accepts(path, lang, p => isScannablePath(p, excludes, includes, owner.prefix, matcher));
  };
  const candidate = (name: string) => (DEFAULT_IGNORE.has(name) || name.startsWith('.') ? null : language(name));
  const walkedFile = (path: string, lang: 'yes' | 'shebang') => {
    const owner = ownerOf(path);
    return !!owner && accepts(path, lang, filtersFor(owner.repo).matcher);
  };
  // A registered repo's folder is scanned from its root, whatever pruned the folders above it: the
  // walk passes through those to reach it (M5-05-R1 review). Inside a repo, a folder is tested by its
  // own name and that repo's excludes (its parents passed already), and an unregistered nested git
  // repository is skipped, as the scan walk does.
  const leadsToRepo = (relDir: string) => repos.some(r => r.prefix.startsWith(`${relDir}/`));
  const folder = (relDir: string, name: string, parent: FolderMode): FolderMode => {
    if (repos.some(r => r.prefix === `${relDir}/`)) return 'scan';
    if (parent === 'scan') {
      const owner = ownerOf(`${relDir}/`)!;
      if (!DEFAULT_IGNORE.has(name) && !name.startsWith('.') && !isExcludedDir(relDir, filtersFor(owner.repo).excludes)
        && !existsSync(join(dir, relDir, '.git'))) return 'scan';
    }
    return leadsToRepo(relDir) ? 'pass' : 'skip';
  };
  return { file, candidate, walkedFile, folder, root: repos.some(r => r.prefix === '') ? 'scan' : 'pass' };
}

/**
 * Files a scan would index that the index does not hold, found by walking the workspace with the
 * scanner's rules (M5-05). Unlike a git listing, it sees new files in a workspace that is not a git
 * repository, in nested repos and in gitignored folders the scan enters (the scan walk does not
 * read .gitignore). A command walks at most once (M5-05-R1).
 */
function walkedNewFiles(store: Store, dir: string, known: Set<string>): string[] {
  const rules = scanRules(store, dir);
  const out: string[] = [];
  const visit = (rel: string, mode: FolderMode) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A folder of thousands of images costs its listing and a name test per entry (M5-05-R1 review).
    for (const e of entries) {
      if (e.isDirectory()) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        const inner = rules.folder(path, e.name, mode);
        if (inner !== 'skip') visit(path, inner);
      } else if (mode === 'scan' && e.isFile()) {
        const lang = rules.candidate(e.name);
        if (!lang) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (!known.has(path) && rules.walkedFile(path, lang) && readable(join(dir, path))) out.push(path);
      }
    }
  };
  visit('', rules.root);
  return out.sort();
}

/** The scan skips a file it cannot read, so it is never new (M5-05-R1 review). */
function readable(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface StaleOptions {
  /** Look for new files, with a walk of the workspace. False checks only the indexed files. */
  newFiles?: boolean;
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
    if (options.newFiles !== false) report.added = walkedNewFiles(store, dir, known);
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
 * `changes` are relative to `repoRoot`. `stale` is the caller's report, when it has one (M5-05-R1).
 */
export function indexableChanges<T extends { path: string; oldPath?: string; status: string }>(
  store: Store, dir: string, repoRoot: string, changes: T[], repoName?: string, stale: StaleReport = findStaleFiles(store, dir, { newFiles: false }),
): T[] {
  const scannable = scannableFilter(store, dir);
  const prefix = relative(dir, repoRoot).replace(/\\/g, '/');
  const at = (p: string) => (prefix ? `${prefix}/${p}` : p);
  const kept = changes.filter(c => scannable(at(c.path)) || !!store.getFile(at(c.path)) || (!!c.oldPath && !!store.getFile(at(c.oldPath))));
  // An indexed file of this repo edited or deleted since the scan that git does not list
  // (gitignored): a change too (M0-02-R8). Another registered repo's files are its own status.
  const listed = new Set(kept.flatMap(c => (c.oldPath ? [at(c.path), at(c.oldPath)] : [at(c.path)])));
  const ownPrefix = prefix ? `${prefix}/` : '';
  const own = (path: string) => !listed.has(path) && (!ownPrefix || path.startsWith(ownPrefix))
    && (!repoName || store.getFile(path)?.repo === repoName);
  for (const path of stale.changed.filter(own)) kept.push({ path: path.slice(ownPrefix.length), status: 'modified' } as T);
  for (const path of stale.deleted.filter(own)) kept.push({ path: path.slice(ownPrefix.length), status: 'removed' } as T);
  return kept;
}

/**
 * The stale files a status shows besides its git changes (M5-05-R1): every one in a workspace that
 * is not a git repository; otherwise another repo's, such as a nested repo's new file, and new files
 * git ignores but a scan indexes. `changes` are the git changes shown, relative to `repoRoot`; the
 * result is relative to the workspace.
 */
export function unlistedStale(
  stale: StaleReport, dir: string, repoRoot: string, changes: Array<{ path: string; oldPath?: string }> = [],
): Array<{ path: string; status: 'added' | 'modified' | 'removed' }> {
  const prefix = relative(dir, repoRoot).replace(/\\/g, '/');
  const at = (p: string) => (prefix ? `${prefix}/${p}` : p);
  const listed = new Set(changes.flatMap(c => (c.oldPath ? [at(c.path), at(c.oldPath)] : [at(c.path)])));
  return [
    ...stale.changed.map(path => ({ path, status: 'modified' as const })),
    ...stale.deleted.map(path => ({ path, status: 'removed' as const })),
    ...stale.added.map(path => ({ path, status: 'added' as const })),
  ].filter(c => !listed.has(c.path));
}
