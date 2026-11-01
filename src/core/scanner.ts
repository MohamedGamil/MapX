import { readFile, writeFile, unlink, stat, lstat, readdir, open } from 'node:fs/promises';
import { accessSync, constants as fsConstants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, extname, join, basename, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { Store } from './store.js';
import { findAssetRoot } from '../parsers/assets.js';
import { ClusterEngine } from './cluster-engine.js';
import { MapxGraph } from './graph.js';
import { Config } from './config.js';
import { CodebaseProfiler } from './codebase-profiler.js';
import { RoleClassifier } from './role-classifier.js';
import { ArchitectureAnalyzer } from './architecture-analyzer.js';
import { calculateClusterMetrics } from './metrics.js';
import { getParserForFile } from '../parsers/parser-registry.js';
import { getLanguageForFile, areLanguagesCompatible } from '../languages/registry.js';
import { getBuiltinLanguages } from '../languages/registry.js';
import { getGitBlobHashes, getChangedFiles, getCurrentCommitSha, getIgnoredEntries, gitBlobId, isGitRepo, type GitFileStatus } from './git-tracker.js';
import type { ScanResult, GraphEdge, ParseResult, ExtractedReference, ExtractedSymbol, ProgressCallback, RepoConfig, ScanContext, RouteBinding, HookBinding } from '../types.js';
import { FrameworkRegistry } from '../frameworks/framework-registry.js';
import { isInScopes } from '../frameworks/utils.js';
import { canonicalPath } from './workspace-manager.js';
import { DEFAULT_IGNORE, buildMatcher, effectiveExcludesFor, isExcludedDir, isScannableDir, isScannablePath, normalizePattern, shebangLanguage } from './file-rules.js';
import { collectProviders, extractHttpCalls, HTTP_SOURCE, isHttpSkipped, type HttpClientConfig } from '../frameworks/http/client-calls.js';
import { HttpCallRegistry, type HttpCallRecord } from '../frameworks/http/http-registry.js';
import { pairCall, urlHost } from '../frameworks/http/pairing.js';
import { closest, importResolverFor, nearestIndex, type ImportHit } from './import-resolvers.js';
import { collectConstants, constantsAnywhere, constantsAt, envCandidates, evaluate, expandDotenv, importedConstants, joinURL, parseDotenv } from '../frameworks/http/url-resolver.js';
import { RouteRegistry } from '../frameworks/route-registry.js';
import { buildScopedIgnoredSymbols, ignoredSymbolsForFile, type ScopedIgnoredSymbols } from '../parsers/ignored-symbols.js';
import { BUILTIN_GLOBALS, JS_GLOBAL_FUNCTIONS } from '../parsers/common-methods.js';
import { resolveThisMember } from '../parsers/languages/vue-options.js';
import { collectVuexFiles, resolveStoreTarget, type VueResolveContext, type VuexModuleInfo } from '../parsers/languages/vue-stores.js';
import { changedGlobalNames, globalRegistrations, usesTag, vueComponentName, vueGlobFiles, type GlobalRegistrations, type VueResolveHint } from '../parsers/languages/vue-template.js';
import { reExportsOf } from '../parsers/languages/vue-script-setup.js';
import { buildRouteTable, changedRoutes, matchRoute, mayDefineRoutes, mayNavigate, navigatesTo, routeRecords, type NavTarget, type ResolvedRoute, type StoredRoute } from '../parsers/languages/vue-navigation.js';
import { BUILD_TOOLS, BUNDLER_CONFIGS, jsAliasTargets, type AliasContext } from './js-aliases.js';

/** Languages whose `constant` and `variable` symbols are values: function-valued declarations are `function` symbols (M0-17-R2). */
const VALUE_SYMBOL_LANGUAGES = new Set(['javascript', 'typescript', 'python', 'svelte']);

/** Symbol index entry: a declaration by name, with its file, scope and kind. */
type SymbolIndexEntry = { name: string; file: string; scope: string | null; kind?: string };
const NAMESPACE_KINDS = new Set(['namespace']);
const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'enum', 'record', 'trait']);
/** Sources whose imports may use JS/TS path aliases (M3-09). */
const JS_MODULE_SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
/**
 * Whether a declaration of `kind` in `language` matches its name whatever the case: PHP class-like,
 * function and method names (PHP's constants, variables and properties are case-sensitive) and
 * Pascal identifiers. Every other language's names are case-sensitive (M3-10).
 */
function foldsCase(language: string | null, kind: string | undefined): boolean {
  return language === 'pascal' || (language === 'php' && (TYPE_KINDS.has(kind ?? '') || kind === 'function' || kind === 'method'));
}

const DEFAULT_CONCURRENCY = Math.min(cpus().length || 4, 8);

/**
 * Files framework detection reads by name, whatever the scan filters say: most are in the default
 * excludes (package.json, composer.json, go.mod), so the walk never indexes them (M4-04).
 */
const DETECTION_INPUT = /(^|\/)(package\.json|composer\.(json|lock)|pyproject\.toml|requirements[^/]*\.txt|Pipfile|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|pubspec\.yaml|Package\.swift|artisan|manage\.py|setup\.(py|cfg)|svelte\.config\.[cm]?[jt]s)$/;
/** Bump when the post-scan analysis changes what it stores: the next sync then reruns it (M4-04). */
const ANALYSIS_VERSION = 1;
/** The last segment of a dotted name that is a file extension, not a member: `utils.ts` stays whole. */
const COMMON_EXTENSIONS = new Set([
  'ts', 'js', 'cs', 'java', 'py', 'php', 'go', 'rs', 'swift', 'kt',
  'svelte', 'vue', 'lua', 'ex', 'zig', 'sh', 'pas', 'scala', 'rb',
  'c', 'cpp', 'h', 'hpp', 'json', 'yaml', 'yml', 'md',
]);
const readable = (path: string) => {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
};
/** The scan time of a file whose re-indexing has not written its result yet (M0-02-R10). */
const UNSCANNED = new Date(0).toISOString();
/** Manifests whose content decides how a language's imports resolve, tracked by sync (M0-02-R9). */
const MANIFEST_FAMILIES = [
  { prefix: '\0go:', manifest: 'go.mod', source: /\.go$/ },
  { prefix: '\0php:', manifest: 'composer.json', source: /\.php$/ },
];
/** A family key of the config signatures: a NUL-prefixed key, which no folder name can be (review 2026-11-01). */
const isFamilyKey = (key: string) => key.startsWith('\0');
/** Component files a template render edge may target: Vue and Svelte (M0-12-R10). */
const COMPONENT_FILE = /\.(vue|svelte)$/;
/**
 * A file's code without comments and string literals, for "is this name still in the file" checks
 * (M0-17-R6): `#` comments and docstrings for Python / Ruby / shell, `//` and `/* *\/` otherwise, and
 * `<!-- -->` in markup. Offsets are not kept.
 */
function codeOnly(path: string, text: string): string {
  // Data and markup files declare names in strings and prose (JSON keys, headings): kept as they are.
  if (/\.(json|jsonc|ya?ml|toml|md|mdx|markdown|xml|html?|css|scss|less)$/i.test(path)) return text;
  const hash = /\.(py|pyi|rb|sh|bash|zsh|fish)$/.test(path) || !/\.[^/]+$/.test(path);
  let code = text.replace(/<!--[\s\S]*?-->/g, ' ');
  if (hash) code = code.replace(/("""|''')[\s\S]*?\1/g, ' ').replace(/#.*$/gm, ' ');
  else code = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1 ');
  return code.replace(/`(?:\\[\s\S]|[^\\`])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, ' ');
}

/** Modules whose calls resolve through import bindings (M2-08). */
const MODULE_FILE = /\.([cm]?[jt]sx?|vue|svelte|py)$/;

/**
 * Source text without comments (and Python docstrings), for the import and re-export scans: a
 * commented-out `import` binds nothing (M2-08). `//` after a colon (a URL) is kept.
 */
function stripComments(text: string, python: boolean): string {
  if (python) return text.replace(/("""|''')[\s\S]*?\1/g, '').replace(/#.*$/gm, '');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** A name a file binds by import to a project module: `imported` is the export, null for the module itself (M2-08). */
interface ImportBinding {
  file: string;
  imported: string | null;
}
/** What resolveSymbolToFile finds for a name in one resolution phase, before the caller is known (M4-03). */
interface NameCandidates {
  /** Index entries of the name, case-matched and language-compatible. */
  compatible: SymbolIndexEntry[];
  /** Files declaring the name in its exact case. */
  sameFile: Set<string>;
  /** Candidate files, sorted: the exact-case ones, else all compatible. */
  files: string[];
  /** `closest(files, ·)`, built on first use. */
  nearest?: (sourcePath: string) => string;
}
/** JS/TS modules: where Vue global registrations (M3-02) and route tables (M3-06) live. */
const JS_TS_FILE = /\.[cm]?[jt]sx?$/;
/** What a JS/TS module contributes to Vue resolution, as kept in `meta vue_registry:<repo>` (M3-08). */
type VueModuleFacts = GlobalRegistrations & { routes?: StoredRoute[] };

/**
 * Resume state of an interrupted scan: `scan_resume_state:<repo>` holds the files completed when the
 * scan started, and each resolved batch appends `scan_resume_batch:<k>:<repo>` with its own files
 * and counts, so a batch writes a constant amount (M4-03).
 */
interface ScanResumeState {
  totalFiles: number;
  completedFiles: string[];
  totalSymbols: number;
  totalEdges: number;
}
type ScanResumeBatch = Omit<ScanResumeState, 'totalFiles'>;
const resumeBatchKey = (repoName: string, k: number) => `scan_resume_batch:${k}:${repoName}`;
/** Files per resolved batch, and so per resume batch record. */
const RESUME_BATCH_SIZE = 100;

interface FileInfo {
  absolutePath: string;
  language: string;
  sizeBytes: number;
  lines: number;
}

export interface DiscoveredFile extends FileInfo {
  relativePath: string;
  contentHash: string;
  content?: string;
  isNew: boolean;
  contentChanged: boolean;
}

export { buildMatcher };

/**
 * A bundler config building a library: `lib:` inside its `build: { … }` object (Vite library mode),
 * not an alias or any other key named `lib` (review 2026-10-31).
 */
function isLibraryBuild(config: string): boolean {
  for (const m of config.matchAll(/\bbuild\s*:\s*\{/g)) {
    let depth = 0;
    for (let i = m.index! + m[0].length - 1; i < config.length; i++) {
      if (config[i] === '{') depth++;
      else if (config[i] === '}' && --depth === 0) {
        if (/\blib\s*:/.test(config.slice(m.index!, i))) return true;
        break;
      }
    }
  }
  return false;
}

/** Whether `text` holds `name` as a whole word (identifier boundaries). */
function wordIn(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(text);
}

export class Scanner {
  private store: Store;
  private config: Config;
  private graph: MapxGraph;
  private onProgress?: ProgressCallback;
  private concurrency: number;
  private aborted = false;
  private cliExcludes: string[] = [];
  private cliIncludes: string[] = [];
  private workspaceFileMap = new Map<string, string>();
  private dartPackageMap = new Map<string, string>();
  private cachedActiveDetectors = new Map<string, any[]>();
  private cachedFrameworkScopes = new Map<string, Map<string, string[]>>();
  private symbolIndex: Map<string, SymbolIndexEntry[]> | null = null;
  /** resolveSymbolToFile per name, source language and callableOnly, for the index `nameCandidatesFor` (M4-03). */
  private nameCandidates = new Map<string, NameCandidates | null>();
  private nameCandidatesFor: Map<string, SymbolIndexEntry[]> | null = null;
  /** Per file, the names it binds by import to project modules, for one resolution phase (M2-08). */
  private importBindingsCache = new Map<string, Map<string, ImportBinding>>();
  /** findExport per file and name, for one resolution phase; null while being searched (M2-08). */
  private exportCache = new Map<string, { file: string; symbol: string } | false | null>();
  /** Source lines per file, for one resolution phase (Python call receivers, M2-08). */
  private lineCache = new Map<string, string[]>();
  /** Per symbols list, the names it declares (outside classes' methods), for the shadowing check (M2-08). */
  private declaredNames = new WeakMap<object, Set<string>>();
  /** Per called name, the patterns that find its receiver on a Python line (M2-08). */
  private callPatterns = new Map<string, { attribute: RegExp; bare: RegExp }>();
  private parallel: boolean;

  constructor(
    store: Store,
    config: Config,
    graph: MapxGraph,
    onProgress?: ProgressCallback,
    options?: { excludes?: string[]; includes?: string[]; parallel?: boolean }
  ) {
    this.store = store;
    this.config = config;
    this.graph = graph;
    this.onProgress = onProgress;
    this.concurrency = DEFAULT_CONCURRENCY;
    this.cliExcludes = options?.excludes ?? [];
    this.cliIncludes = options?.includes ?? [];
    this.parallel = options?.parallel !== false;
  }

  abort(): void {
    this.aborted = true;
  }

  private loadResumeState(repoName: string): ScanResumeState | null {
    const data = this.store.getMeta(`scan_resume_state:${repoName}`);
    if (!data) return null;
    let state: ScanResumeState;
    try {
      state = JSON.parse(data);
    } catch {
      return null;
    }
    const completedFiles = [...(state.completedFiles ?? [])];
    for (const batch of this.resumeBatches(repoName, state)) {
      completedFiles.push(...(batch.completedFiles ?? []));
      state.totalSymbols = (state.totalSymbols ?? 0) + (batch.totalSymbols ?? 0);
      state.totalEdges = (state.totalEdges ?? 0) + (batch.totalEdges ?? 0);
    }
    return { ...state, completedFiles };
  }

  /** The most batch records a scan of the header's file count can write. */
  private static resumeBatchLimit(state: Partial<ScanResumeState> | null): number {
    return state && Number.isFinite(state.totalFiles) ? Math.ceil(state.totalFiles! / RESUME_BATCH_SIZE) : 0;
  }

  /** The batch records in order, up to the first missing or unreadable one. */
  private resumeBatches(repoName: string, state: ScanResumeState): ScanResumeBatch[] {
    const batches: ScanResumeBatch[] = [];
    for (let k = 0; k < Scanner.resumeBatchLimit(state); k++) {
      const data = this.store.getMeta(resumeBatchKey(repoName, k));
      if (!data) break;
      try {
        batches.push(JSON.parse(data));
      } catch {
        break;
      }
    }
    return batches;
  }

  /** Starts a scan's resume state: the files already complete, and no batch records yet. */
  private saveResumeState(repoName: string, state: ScanResumeState): void {
    this.store.inTransaction(() => {
      this.clearResumeBatches(repoName);
      this.store.setMeta(`scan_resume_state:${repoName}`, JSON.stringify(state));
    });
  }

  private saveResumeBatch(repoName: string, k: number, batch: ScanResumeBatch): void {
    this.store.setMeta(resumeBatchKey(repoName, k), JSON.stringify(batch));
  }

  /**
   * Deletes every batch record the current header allows, gaps included. Callers clear in the same
   * transaction as the header write, so an interrupted clear leaves the old state whole (review 2026-11-01).
   */
  private clearResumeBatches(repoName: string): void {
    let header: ScanResumeState | null = null;
    try {
      header = JSON.parse(this.store.getMeta(`scan_resume_state:${repoName}`) || 'null');
    } catch {
      header = null;
    }
    for (let k = 0; k < Scanner.resumeBatchLimit(header); k++) {
      if (this.store.getMeta(resumeBatchKey(repoName, k))) this.store.deleteMeta(resumeBatchKey(repoName, k));
    }
  }

  private clearResumeState(repoName: string): void {
    this.store.inTransaction(() => {
      this.clearResumeBatches(repoName);
      this.store.setMeta(`scan_resume_state:${repoName}`, '');
    });
  }

  /** Drops the symbol index of a finished phase, and what was memoised from it (M4-03). */
  private releaseSymbolIndex(): void {
    this.symbolIndex = null;
    this.nameCandidates.clear();
    this.nameCandidatesFor = null;
  }

  private getLockPath(): string {
    return join(this.config.getWorkspaceRoot(), '.mapx', 'scan.lock');
  }

  private async acquireScanLock(): Promise<boolean> {
    const lockPath = this.getLockPath();
    try {
      const fd = await open(lockPath, 'wx');
      await fd.write(String(process.pid), 0, 'utf-8');
      await fd.close();
      return true;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          try { await unlink(lockPath); } catch { /* race: another process cleaned it */ }
          return this.acquireScanLock();
        }
      }
    } catch { /* unreadable */ }
    try { await unlink(lockPath); } catch { /* race */ }
    return this.acquireScanLock();
  }

  private async releaseScanLock(): Promise<void> {
    try { await unlink(this.getLockPath()); } catch { /* already gone */ }
  }

  async scanFull(repoNames?: string[], options?: { force?: boolean }): Promise<ScanResult> {
    const acquired = await this.acquireScanLock();
    if (!acquired) {
      const lockPath = this.getLockPath();
      const pid = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8').trim() : '?';
      throw new Error(`Another scan is already running on this project (PID ${pid}). Wait for it to finish or delete ${lockPath} if it is stale.`);
    }
    try {
      const reposToScan = repoNames && repoNames.length > 0
        ? (repoNames.includes('all') ? this.config.repos.map(r => r.name) : repoNames)
        : [this.config.repos[0].name];

      this.workspaceFileMap.clear();
      for (const f of this.store.getAllFiles()) {
        this.workspaceFileMap.set(f.path as string, f.repo as string);
      }
      for (const repoName of reposToScan) {
        const repo = this.config.repos.find(r => r.name === repoName);
        if (!repo) continue;
        const workspaceRoot = this.config.getWorkspaceRoot();
        const repoRoot = resolve(workspaceRoot, repo.path);
        const discovered = await this.discoverFiles(repoRoot, repo.name, true, { pathsOnly: true });
        for (const f of discovered) {
          this.workspaceFileMap.set(f.relativePath, repo.name);
        }
      }

      let filesScanned = 0;
      let symbolsFound = 0;
      let edgesFound = 0;
      const combinedLangBreakdown: Record<string, number> = {};
      const startTime = Date.now();

      this.parsedInRun = reposToScan.length > 1 ? new Map() : null;
      for (const repoName of reposToScan) {
        const repo = this.config.repos.find(r => r.name === repoName);
        if (!repo) continue;
        const res = await this._scanFullForRepo(repo, options?.force);
        filesScanned += res.filesScanned;
        symbolsFound += res.symbolsFound;
        edgesFound += res.edgesFound;
        for (const [lang, count] of Object.entries(res.languageBreakdown)) {
          combinedLangBreakdown[lang] = (combinedLangBreakdown[lang] || 0) + count;
        }
        if (this.aborted) break;
      }
      // Re-resolves files the counts above already include.
      if (reposToScan.length > 1 && !this.aborted) this.queueEarlyParsed(reposToScan);
      // The resolution configs as this run left them, for the next run to compare with (M0-02-R8).
      if (!this.aborted) for (const name of reposToScan) this.configReferrers(name);
      this.parsedInRun = null;
      for (const repoName of reposToScan.length > 1 && !this.aborted ? reposToScan : []) {
        const repo = this.config.repos.find(r => r.name === repoName);
        if (repo && this.needsSecondPass(repoName)) await this._scanFullForRepo(repo);
        if (this.aborted) break;
      }

      return {
        filesScanned,
        symbolsFound,
        edgesFound,
        durationMs: Date.now() - startTime,
        languageBreakdown: combinedLangBreakdown,
        interrupted: this.aborted,
        totalFiles: filesScanned,
      };
    } finally {
      await this.releaseScanLock();
    }
  }

  private async _scanFullForRepo(repo: RepoConfig, force = false): Promise<ScanResult> {
    const startTime = Date.now();
    this.aborted = false;
    const workspaceRoot = this.config.getWorkspaceRoot();
    const repoRoot = resolve(workspaceRoot, repo.path);

    if (force) {
      // Clear stale resume state so a previously-interrupted scan cannot
      // cause --force to silently skip files it considers "already completed".
      this.clearResumeState(repo.name);
      // Wipe all DB data for this repo before re-scanning so that symbols,
      // edges, files, and clusters from a prior run cannot become stale.
      this.store.resetRepoForScan(repo.name);
    }

    const discovered = await this.discoverFiles(repoRoot, repo.name);
    this.onProgress?.({ phase: 'discover', current: discovered.length, total: discovered.length });
    // The files git lists as changed now, for git sync to re-read once git stops listing them (M0-02-R6).
    if (isGitRepo(repoRoot)) {
      this.store.setMeta('dirty_paths:' + repo.name, JSON.stringify(this.dirtyPaths(getChangedFiles(repoRoot), repoRoot, this.nestedRepoTest(repoRoot))));
    }

    // Deleted files leave the index before anything is parsed: a file moved within this scan then
    // records its referrers and their names, and re-parsed references cannot resolve to the old path
    // through the file map or the symbol index (M0-02-R4).
    const deletedPaths = this.aborted ? [] : this.detectDeletedFiles(discovered, repo.name);
    if (deletedPaths.length > 0) this.store.inTransaction(() => this.removeFiles(repo.name, deletedPaths));

    const filesWithSymbols = new Set<string>();
    for (const sym of this.store.getAllSymbols(repo.name)) {
      filesWithSymbols.add(sym.file_path as string);
    }

    const newFiles = discovered.filter(f => f.isNew);
    const changedFiles = discovered.filter(f => !f.isNew && f.contentChanged);
    const incompleteFiles = discovered.filter(f => !f.isNew && !f.contentChanged && !filesWithSymbols.has(f.relativePath));
    // Changed include/exclude filters can bring files back whose inbound references were never
    // resolved (their referrers are unchanged and would not be re-parsed): re-parse everything
    // once when the effective filters differ from the last scan (M0-02-R1).
    const filterKey = 'scan_filters:' + repo.name;
    const filters = this.filterSignature(repo.name);
    const previousFilters = this.store.getMeta(filterKey);
    // Another repo whose files this repo could not see when it was last parsed (`workspaces add`
    // before the primary repo was scanned): unchanged files keep unresolved references into it,
    // so re-parse everything once, as for changed filters (M0-10-R3).
    const newlyVisible = this.newlyVisibleRepos(repo.name, discovered.some(f => !f.isNew));
    this.store.setMeta('resolution_repos:' + repo.name, JSON.stringify(this.indexedRepos(repo.name)));
    const reparseAll = force || newlyVisible || (previousFilters !== null && previousFilters !== undefined && previousFilters !== filters);
    this.store.setMeta(filterKey, filters);
    // Unchanged files that had edges into a removed file now back (M0-02-R2), or into a removed file
    // whose referenced names a new or changed file now holds (M0-02-R4), or that use a Vue tag whose
    // global registration changed (M3-08): re-parse them.
    const candidates = [...newFiles, ...changedFiles, ...incompleteFiles];
    const candidateTexts = candidates.map(f => ({ path: f.relativePath, content: f.content }));
    // A file without symbols is re-read by every scan: only new and changed files can name a moved
    // target, or a mention in an unchanged re-export would re-parse its referrers forever (M0-10-R4).
    const movedCandidates = [...newFiles, ...changedFiles];
    const referrers = new Set([
      ...this.takePendingReferrers(repo.name),
      ...this.ownReferrers(repo.name, [
        ...this.takeReferrers(repo.name, newFiles.map(f => f.relativePath)),
        ...this.importerReferrers([...newFiles, ...changedFiles].map(f => f.relativePath)),
        ...this.movedReferrers(repo.name, movedCandidates.map(f => ({ path: f.relativePath, content: f.content }))),
        ...this.removedSymbolReferrers(repo.name, changedFiles.map(f => ({ path: f.relativePath, content: f.content }))),
        ...this.vanishedNameReferrers(repo.name, movedCandidates.map(f => ({ path: f.relativePath, content: f.content }))),
        ...this.configReferrers(repo.name, deletedPaths),
        ...this.vueRegistryReferrers(repo.name, candidateTexts, deletedPaths),
      ]),
    ]);
    const stableFiles = discovered.filter(f => !f.isNew && !f.contentChanged && filesWithSymbols.has(f.relativePath));
    const unchangedFiles = reparseAll ? [] : stableFiles.filter(f => !referrers.has(f.relativePath));
    const filesToParse = reparseAll
      ? discovered
      : [...newFiles, ...changedFiles, ...incompleteFiles, ...stableFiles.filter(f => referrers.has(f.relativePath))];

    const resumeState = this.loadResumeState(repo.name);
    const resumedCompleted = new Set(resumeState?.completedFiles || []);

    const toParse = resumedCompleted.size > 0
      ? filesToParse.filter(f => !resumedCompleted.has(f.relativePath))
      : filesToParse;

    let totalSymbols = resumeState?.totalSymbols || 0;
    let totalEdges = resumeState?.totalEdges || 0;

    for (const f of unchangedFiles) {
      this.graph.addFileNode(f.relativePath, f.language, f.sizeBytes, f.lines);
    }

    if (toParse.length > 0) {
      this.onProgress?.({ phase: 'index', current: 0, total: toParse.length });

      // Keyed by workspace path, as files are stored, also for a repo that is not at the root.
      const gitHashes = isGitRepo(repoRoot) ? getGitBlobHashes(repoRoot, workspaceRoot) : new Map<string, string>();

      this.store.inTransaction(() => {
        for (let i = 0; i < toParse.length; i++) {
          const f = toParse[i];
          // HEAD's blob id, kept only when it is the indexed content: a file modified in the working
          // tree stores null, so sync never takes it for unchanged (M0-02-R4).
          const headBlob = gitHashes.get(f.relativePath);
          const blobHash = headBlob && f.content !== undefined && gitBlobId(f.content) === headBlob ? headBlob : null;

          this.store.upsertFile({
            path: f.relativePath,
            repo: repo.name,
            language: f.language,
            gitBlobHash: blobHash,
            contentHash: f.contentHash,
            lastScanned: new Date().toISOString(),
            sizeBytes: f.sizeBytes,
            lines: f.lines,
          });

          this.graph.addFileNode(f.relativePath, f.language, f.sizeBytes, f.lines);

          this.onProgress?.({ phase: 'index', current: i + 1, total: toParse.length, file: f.relativePath });
        }
      });

      this.onProgress?.({ phase: 'parse', current: unchangedFiles.length + resumedCompleted.size, total: discovered.length });

      const completed = new Set([
        ...unchangedFiles.map(f => f.relativePath),
        ...resumedCompleted,
      ]);

      this.saveResumeState(repo.name, {
        totalFiles: discovered.length,
        completedFiles: [...completed],
        totalSymbols,
        totalEdges,
      });

      // Detect active frameworks early so we can build ignored symbols for parsing
      const filePaths = discovered.map(f => f.relativePath);
      const activeDetectors = await this.getActiveDetectors(repoRoot, filePaths);
      const activeFrameworks = activeDetectors.map(d => d.name);
      const ignoredSymbols = buildScopedIgnoredSymbols(activeFrameworks, this.frameworkScopes(repoRoot));

      // Build pre-scan symbol index for O(1) lookups during reference resolution
      this.symbolIndex = this.buildSymbolIndex(repo.name);

      // Discover Dart packages for accurate package: URI resolution
      this.discoverDartPackages(workspaceRoot);

      let parsedFilesCount = 0;
      this.noteParsed(repo.name, toParse.map(f => f.relativePath));
      const parseResults = await this.parseFilesParallel(
        toParse,
        workspaceRoot,
        ignoredSymbols,
        (relPath) => {
          parsedFilesCount++;
          this.onProgress?.({
            phase: 'parse',
            current: unchangedFiles.length + resumedCompleted.size + parsedFilesCount,
            total: discovered.length,
            file: relPath,
          });
        }
      );

      // Rebuild the symbol index to include the newly parsed symbols before reference resolution
      this.symbolIndex = this.buildSymbolIndex(
        repo.name,
        toParse.map(f => f.relativePath),
        parseResults
      );

      // scanFull and scanIncremental fill workspaceFileMap with every indexed and discovered file.
      const fileMap = this.workspaceFileMap;

      const BATCH_SIZE = RESUME_BATCH_SIZE;
      for (let batchStart = 0, k = 0; batchStart < toParse.length && !this.aborted; batchStart += BATCH_SIZE, k++) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, toParse.length);

        this.store.inTransaction(() => {
          for (let i = batchStart; i < batchEnd; i++) {
            this.writeParseResultWithMap(toParse[i].relativePath, parseResults[i], repo.name, fileMap);
          }
        });

        const batch: ScanResumeBatch = { completedFiles: [], totalSymbols: 0, totalEdges: 0 };
        for (let i = batchStart; i < batchEnd; i++) {
          batch.totalSymbols += parseResults[i].symbols.length;
          batch.totalEdges += parseResults[i].references.length;
          batch.completedFiles.push(toParse[i].relativePath);
        }
        totalSymbols += batch.totalSymbols;
        totalEdges += batch.totalEdges;

        this.onProgress?.({
          phase: 'resolve',
          current: batchEnd,
          total: toParse.length,
          file: toParse[batchEnd - 1].relativePath,
        });

        this.saveResumeBatch(repo.name, k, batch);
      }
      if (!this.aborted) {
        const candidatePaths = new Set(movedCandidates.map(f => f.relativePath));
        this.settleMovedNames(repo.name, parseResults.filter((_, i) => candidatePaths.has(toParse[i].relativePath)));
        this.settleVanishedNames(repo.name, parseResults.filter((_, i) => candidatePaths.has(toParse[i].relativePath)));
      }
    } else if (unchangedFiles.length > 0) {
      this.onProgress?.({ phase: 'parse', current: unchangedFiles.length, total: discovered.length });
    }

    const langBreakdown: Record<string, number> = {};
    for (const f of discovered) {
      langBreakdown[f.language] = (langBreakdown[f.language] || 0) + 1;
    }

    // Release cached content to free memory after parsing
    for (const f of discovered) { (f as any).content = undefined; }

    if (!this.aborted) {
      this.settleVueRegistry(repo.name);
      const commitSha = isGitRepo(repoRoot) ? getCurrentCommitSha(repoRoot) : null;
      if (commitSha) this.store.setMeta('last_scan_commit:' + repo.name, commitSha);
      this.store.setMeta('last_scan_time:' + repo.name, new Date().toISOString());
      this.clearResumeState(repo.name);

      try {
        await this.runPostScanAnalysis(repo, repoRoot);
      } finally {
        this.releaseSymbolIndex();
      }
    } else {
      this.releaseSymbolIndex();
    }

    const totalParsed = unchangedFiles.length + (toParse.length > 0 ? toParse.length : 0);
    // A full scan reports what the repo now holds: raw reference counts include unresolved
    // and external references, and skip unchanged files (M0-23).
    const completed = !this.aborted;
    return {
      filesScanned: totalParsed,
      symbolsFound: completed ? this.store.getSymbolCount(repo.name) : totalSymbols,
      edgesFound: completed ? this.store.getEdgeCount(repo.name) : totalEdges,
      durationMs: Date.now() - startTime,
      languageBreakdown: langBreakdown,
      interrupted: this.aborted,
      totalFiles: discovered.length,
    };
  }

  async scanIncremental(repoNames?: string[]): Promise<ScanResult> {
    const acquired = await this.acquireScanLock();
    if (!acquired) {
      const lockPath = this.getLockPath();
      const pid = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8').trim() : '?';
      throw new Error(`Another scan is already running on this project (PID ${pid}). Wait for it to finish or delete ${lockPath} if it is stale.`);
    }
    try {
      const reposToScan = repoNames && repoNames.length > 0
        ? (repoNames.includes('all') ? this.config.repos.map(r => r.name) : repoNames)
        : [this.config.repos[0].name];

      this.workspaceFileMap.clear();
      for (const f of this.store.getAllFiles()) {
        this.workspaceFileMap.set(f.path as string, f.repo as string);
      }
      for (const repoName of reposToScan) {
        const repo = this.config.repos.find(r => r.name === repoName);
        if (!repo) continue;
        const workspaceRoot = this.config.getWorkspaceRoot();
        const repoRoot = resolve(workspaceRoot, repo.path);
        const discovered = await this.discoverFiles(repoRoot, repo.name, true, { pathsOnly: true });
        for (const f of discovered) {
          this.workspaceFileMap.set(f.relativePath, repo.name);
        }
      }

      let filesScanned = 0;
      let symbolsFound = 0;
      let edgesFound = 0;
      const combinedLangBreakdown: Record<string, number> = {};
      const startTime = Date.now();

      this.parsedInRun = reposToScan.length > 1 ? new Map() : null;
      for (const repoName of reposToScan) {
        const repo = this.config.repos.find(r => r.name === repoName);
        if (!repo) continue;
        const res = await this._scanIncrementalForRepo(repo);
        filesScanned += res.filesScanned;
        symbolsFound += res.symbolsFound;
        edgesFound += res.edgesFound;
        for (const [lang, count] of Object.entries(res.languageBreakdown)) {
          combinedLangBreakdown[lang] = (combinedLangBreakdown[lang] || 0) + count;
        }
        if (this.aborted) break;
      }
      // Re-resolves files the counts above already include.
      if (reposToScan.length > 1 && !this.aborted) this.queueEarlyParsed(reposToScan);
      // The resolution configs as this run left them, for the next run to compare with (M0-02-R8).
      if (!this.aborted) for (const name of reposToScan) this.configReferrers(name);
      this.parsedInRun = null;
      for (const repoName of reposToScan.length > 1 && !this.aborted ? reposToScan : []) {
        const repo = this.config.repos.find(r => r.name === repoName);
        if (repo && this.needsSecondPass(repoName)) await this._scanIncrementalForRepo(repo);
        if (this.aborted) break;
      }

      return {
        filesScanned,
        symbolsFound,
        edgesFound,
        durationMs: Date.now() - startTime,
        languageBreakdown: combinedLangBreakdown,
        interrupted: this.aborted,
        totalFiles: filesScanned,
      };
    } finally {
      await this.releaseScanLock();
    }
  }

  private async _scanIncrementalForRepo(repo: RepoConfig): Promise<ScanResult> {
    const startTime = Date.now();
    this.aborted = false;
    const workspaceRoot = this.config.getWorkspaceRoot();
    const repoRoot = resolve(workspaceRoot, repo.path);

    // Changed include/exclude filters: take the full-scan path, which re-parses every file once,
    // so sync gives the edges scan gives (M0-02-R2).
    const filterKey = 'scan_filters:' + repo.name;
    const previousFilters = this.store.getMeta(filterKey);
    if (previousFilters === null) this.store.setMeta(filterKey, this.filterSignature(repo.name));
    else if (previousFilters !== this.filterSignature(repo.name)) return this._scanFullForRepo(repo);
    // Likewise when another repo became visible since this one was parsed, and when nothing of the
    // repo is indexed yet: a git diff from HEAD would list none of its committed files (M0-10-R3).
    const indexed = this.store.getAllFiles(repo.name).length > 0;
    if (!indexed || this.newlyVisibleRepos(repo.name, indexed)) return this._scanFullForRepo(repo);
    this.store.setMeta('resolution_repos:' + repo.name, JSON.stringify(this.indexedRepos(repo.name)));

    // Content-hash based incremental for non-git projects, and for a repo inside a gitignored folder
    // of an enclosing checkout, where git lists none of its files (review 2026-10-31).
    const ignoredEntries = isGitRepo(repoRoot) ? getIgnoredEntries(repoRoot) : null;
    if (!ignoredEntries) return this._scanIncrementalByHash(repo);

    const excludes = this.effectiveExcludes(repo.name);
    const includes = [
      ...this.config.settings.includePatterns,
      ...this.cliIncludes,
    ];
    // The scan walk's rules, not only the matcher: git lists dot-named files, DEFAULT_IGNORE folders
    // and files under pruned directories, which scan never indexes (review 2026-10-31).
    const repoPath = relative(workspaceRoot, repoRoot).replace(/\\/g, '/');
    const matcher = (p: string) => isScannablePath(p, excludes, includes, repoPath);

    const lastCommit = this.store.getMeta('last_scan_commit:' + repo.name);
    this.onProgress?.({ phase: 'detect', current: 0, total: 0 });
    this.listings.clear();
    // A registered repo nested in this one indexes its own files: git lists them for this repo too,
    // and the walk leaves them out. Compared by canonical path, as in the walk (M0-02-R7).
    const inNestedRepo = this.nestedRepoTest(repoRoot);
    const gitChanges = getChangedFiles(repoRoot, lastCommit || undefined);
    const changes = [...gitChanges, ...await this.ignoredChanges(repo, repoRoot, ignoredEntries, inNestedRepo)]
      // A rename into a nested repo still removes its old path here.
      .map(c => (inNestedRepo(c.path) && c.oldPath && !inNestedRepo(c.oldPath) ? { path: c.oldPath, status: 'removed' as const } : c))
      .filter(c => !inNestedRepo(c.path));
    // The files indexed from a state git listed as changed (M0-02-R6). Once git stops listing one (an
    // edit reverted to HEAD's content), it is read again; the blob comparison below skips it if the
    // indexed content is still the file's. A checkout whose files differ from HEAD's blobs only by
    // eol conversion is never listed, so it costs nothing.
    const dirtyKey = 'dirty_paths:' + repo.name;
    const wasDirty = new Set(JSON.parse(this.store.getMeta(dirtyKey) ?? '[]') as string[]);
    this.store.setMeta(dirtyKey, JSON.stringify(this.dirtyPaths(gitChanges, repoRoot, inNestedRepo)));

    // A file removed and restored while HEAD stayed at the last scanned commit is not in the diff:
    // look for the removed files on disk (M0-02-R2).
    const listed = new Set(changes.map(c => resolve(repoRoot, c.path)));
    for (const p of Object.keys(this.removedFiles(repo.name))) {
      const absolutePath = resolve(workspaceRoot, p);
      if (!listed.has(absolutePath) && matcher(p) && existsSync(absolutePath)) {
        changes.push({ path: relative(repoRoot, absolutePath).replace(/\\/g, '/'), status: 'added' });
      }
    }

    // A file indexed while untracked or only staged is in neither tree git diff compares, and
    // ls-files --others stops listing it once it is deleted: an indexed file missing from HEAD's
    // tree and from disk is a removal (M0-02-R5).
    const committed = getGitBlobHashes(repoRoot, workspaceRoot);
    for (const f of this.store.getAllFiles(repo.name)) {
      const absolutePath = resolve(workspaceRoot, f.path as string);
      if (listed.has(absolutePath)) continue;
      const exists = committed.has(f.path as string) ? existsSync(absolutePath) : this.existsExactly(absolutePath);
      if (wasDirty.has(f.path as string) && exists) {
        changes.push({ path: relative(repoRoot, absolutePath).replace(/\\/g, '/'), status: 'modified' });
        continue;
      }
      // Cleared by a sync that was interrupted before writing its parse result: its hashes are still
      // null, and git may not list it (an unchanged referrer). Parse it again (M0-02-R10).
      if (exists && !f.content_hash) {
        changes.push({ path: relative(repoRoot, absolutePath).replace(/\\/g, '/'), status: 'modified' });
        continue;
      }
      if (committed.has(f.path as string) || exists) continue;
      changes.push({ path: relative(repoRoot, absolutePath).replace(/\\/g, '/'), status: 'removed' });
    }

    const pending = this.takePendingReferrers(repo.name);
    // A package.json git does not list (untracked, then deleted) can still move Vue scopes (M3-08-R1).
    const facts = () => JSON.parse(this.store.getMeta('vue_registry:' + repo.name) ?? '{}');
    if (changes.length === 0 && pending.length === 0 && this.vueScopeMoves(repo.name, [], [], {}, facts(), true).size === 0
      && this.configReferrers(repo.name, [], true).size === 0 && !this.analysisInputsChanged(repo.name)) {
      await this.refreshHttpIfInputsChanged(repo, repoRoot);
      return {
        filesScanned: 0,
        symbolsFound: 0,
        edgesFound: 0,
        durationMs: Date.now() - startTime,
        languageBreakdown: {},
      };
    }

    const toRemove: string[] = [];
    const toReindex: Array<{ path: string; fileInfo: FileInfo; contentHash: string; blobHash: string }> = [];
    const contents = new Map<string, string>();
    // A listed file the analysis may read although no parser does: a manifest framework detection
    // reads (package.json, go.mod, requirements.txt), a scannable file without a parser, or a removed
    // file that was never indexed. The post-scan analysis then runs (M4-04).
    let analysisInput = false;

    // A rename is listed by its new path; its old path leaves the index, and the files with edges
    // into it are re-parsed so references that now resolve to the new path find it (M0-02-R3).
    const renamedReferrers = new Set<string>();
    for (const change of changes) {
      // `git mv a b` with a copy left at a: a is still a file the walk indexes (M0-02-R7). Compared in
      // its exact case: on a case-insensitive disk `git mv User.php user.php` leaves no `User.php`.
      if (!change.oldPath || inNestedRepo(change.oldPath) || this.existsExactly(resolve(repoRoot, change.oldPath))) continue;
      const oldPath = relative(workspaceRoot, resolve(repoRoot, change.oldPath)).replace(/\\/g, '/');
      toRemove.push(oldPath);
      for (const r of this.store.getReferrers(oldPath)) renamedReferrers.add(r);
    }

    for (const change of changes) {
      const absolutePath = resolve(repoRoot, change.path);
      const relativePath = relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
      if (DETECTION_INPUT.test(relativePath)) analysisInput = true;
      if (!matcher(relativePath)) {
        toRemove.push(relativePath);
        continue;
      }
      // A listed file that is gone is removed too: a staged-only file deleted from the working tree
      // is still listed as added by `git diff --cached` (M0-02-R5).
      if (change.status === 'removed' || !existsSync(absolutePath)) {
        // A removed file that was never indexed may still be a detector input (go.mod).
        if (this.store.getFile(relativePath)?.repo !== repo.name) analysisInput = true;
        toRemove.push(relativePath);
        continue;
      }
      const fileInfo = await this.getFileInfo(absolutePath, relativePath);
      // An indexed file no parser can read any more (unreadable, its language removed) leaves the
      // index, as the walk drops it; otherwise it would be listed again on every sync (review 2026-11-01).
      if (!fileInfo && this.store.getFile(relativePath)?.repo === repo.name) {
        toRemove.push(relativePath);
        continue;
      }
      // Only a regular file it can read: git lists an untracked nested repo or submodule as its folder,
      // and an unreadable file is no input to anything (review 2026-11-01).
      if (!fileInfo && statSync(absolutePath).isFile() && readable(absolutePath)) analysisInput = true;
      if (fileInfo) {
        const bytes = await readFile(absolutePath);
        // Listed, but the indexed blob is still the content (a mode change, or a commit of what an
        // earlier sync indexed): nothing to re-parse. Blob hashes are stored under workspace paths,
        // so this holds for a repo that is not at the root too (M0-02-R4).
        const blobHash = gitBlobId(bytes);
        const stored = this.store.getFile(relativePath);
        if (stored?.repo === repo.name && stored.git_blob_hash === blobHash) continue;
        const content = bytes.toString('utf-8');
        const contentHash = createHash('md5').update(content).digest('hex');
        toReindex.push({ path: relativePath, fileInfo, contentHash, blobHash });
        contents.set(relativePath, content);
      }
    }

    const removesIndexed = toRemove.some(p => this.store.getFile(p)?.repo === repo.name);
    this.store.inTransaction(() => this.removeFiles(repo.name, toRemove));

    // Unchanged files of this repo that had edges into a removed file now back (M0-02-R2), into
    // a renamed file's old path, or into a removed file whose referenced names a listed file now
    // holds (M0-02-R4), and those using a Vue tag whose global registration changed (M3-08).
    const reindexed = new Set(toReindex.map(r => r.path));
    const listedTexts = [...contents].map(([path, content]) => ({ path, content }));
    const moved = [...this.movedReferrers(repo.name, listedTexts), ...this.removedSymbolReferrers(repo.name, listedTexts), ...this.vanishedNameReferrers(repo.name, listedTexts), ...this.configReferrers(repo.name, toRemove), ...this.importerReferrers(listedTexts.map(t => t.path))];
    const vueUsers = this.vueRegistryReferrers(repo.name, listedTexts, toRemove);
    for (const r of new Set([...pending, ...this.ownReferrers(repo.name, [...this.takeReferrers(repo.name, [...reindexed]), ...renamedReferrers, ...moved, ...vueUsers])])) {
      if (reindexed.has(r) || toRemove.includes(r) || this.store.getFile(r)?.repo !== repo.name) continue;
      const absolutePath = resolve(workspaceRoot, r);
      const fileInfo = existsSync(absolutePath) ? await this.getFileInfo(absolutePath, r) : null;
      if (!fileInfo) continue;
      const bytes = await readFile(absolutePath);
      const contentHash = createHash('md5').update(bytes.toString('utf-8')).digest('hex');
      toReindex.push({ path: r, fileInfo, contentHash, blobHash: gitBlobId(bytes) });
    }

    // Git listed only files the walk never indexes and the analysis never reads (an untracked
    // .gitignore, .idea/, dist/, *.log), or files whose indexed content is unchanged: nothing to parse,
    // and the analysis inputs are those of its last run. Finish as the no-change return does, without the post-scan analysis (M4-04).
    if (toReindex.length === 0 && !removesIndexed && !analysisInput && !this.analysisInputsChanged(repo.name)) {
      this.settleVueRegistry(repo.name);
      const commitSha = getCurrentCommitSha(repoRoot);
      if (commitSha) this.store.setMeta('last_scan_commit:' + repo.name, commitSha);
      this.store.setMeta('last_scan_time:' + repo.name, new Date().toISOString());
      await this.refreshHttpIfInputsChanged(repo, repoRoot);
      return {
        filesScanned: 0,
        symbolsFound: 0,
        edgesFound: 0,
        durationMs: Date.now() - startTime,
        languageBreakdown: {},
      };
    }

    this.store.inTransaction(() => {
      for (const { path: p, fileInfo, contentHash, blobHash } of toReindex) {
        this.store.deleteSymbolsForFile(p);
        this.store.deleteEdgesForFile(p);
        this.store.upsertFile({
          path: p,
          repo: repo.name,
          language: fileInfo.language,
          // Set by setFileHashes once the parse result is written: a sync interrupted before that
          // leaves them null, so the next sync re-parses the file (M0-02-R10). The blob id is then
          // what the skip above compares with (M0-02-R5).
          gitBlobHash: null,
          contentHash: null,
          // Until the result is written the file reads as never scanned, so `mapx status` lists it.
          lastScanned: UNSCANNED,
          sizeBytes: fileInfo.sizeBytes,
          lines: fileInfo.lines,
        });
      }
    });

    // Detect active frameworks early so we can build ignored symbols for parsing
    const allFilePaths = this.store.getAllFiles(repo.name).map(f => f.path as string);
    const activeDetectors = await this.getActiveDetectors(repoRoot, allFilePaths);
    const activeFrameworks = activeDetectors.map(d => d.name);
    const ignoredSymbols = buildScopedIgnoredSymbols(activeFrameworks, this.frameworkScopes(repoRoot));

    // Build pre-scan symbol index for O(1) lookups during reference resolution
    this.symbolIndex = this.buildSymbolIndex(repo.name);

    // Discover Dart packages for accurate package: URI resolution
    this.discoverDartPackages(workspaceRoot);

    let parsedFilesCount = 0;
    this.noteParsed(repo.name, toReindex.map(r => r.path));
    const parseResults = await this.parseFilesParallel(
      toReindex.map(r => r.fileInfo),
      workspaceRoot,
      ignoredSymbols,
      (relPath) => {
        parsedFilesCount++;
        this.onProgress?.({
          phase: 'parse',
          current: parsedFilesCount,
          total: toReindex.length,
          file: relPath,
        });
      }
    );

    // Rebuild the symbol index to include the newly parsed symbols before reference resolution
    this.symbolIndex = this.buildSymbolIndex(
      repo.name,
      toReindex.map(r => r.path),
      parseResults
    );

    let totalSymbols = 0;
    let totalEdges = 0;
    const langBreakdown: Record<string, number> = {};

    this.onProgress?.({ phase: 'resolve', current: 0, total: toReindex.length });

    this.store.inTransaction(() => {
      for (let i = 0; i < toReindex.length && !this.aborted; i++) {
        const { path: relPath, fileInfo, contentHash, blobHash } = toReindex[i];
        const result = parseResults[i];

        this.writeParseResult(relPath, result, repo.name);
        this.store.setFileHashes(relPath, contentHash, blobHash);

        totalSymbols += result.symbols.length;
        totalEdges += result.references.length;
        langBreakdown[fileInfo.language] = (langBreakdown[fileInfo.language] || 0) + 1;

        this.onProgress?.({
          phase: 'resolve',
          current: i + 1,
          total: toReindex.length,
          file: relPath,
        });
      }
    });

    if (!this.aborted) {
      this.settleMovedNames(repo.name, parseResults.filter((_, i) => contents.has(toReindex[i].path)));
      this.settleVanishedNames(repo.name, parseResults.filter((_, i) => contents.has(toReindex[i].path)));
      this.settleVueRegistry(repo.name);
      const commitSha = getCurrentCommitSha(repoRoot);
      if (commitSha) this.store.setMeta('last_scan_commit:' + repo.name, commitSha);
      this.store.setMeta('last_scan_time:' + repo.name, new Date().toISOString());

      try {
        await this.runPostScanAnalysis(repo, repoRoot);
      } finally {
        this.releaseSymbolIndex();
      }
    } else {
      this.releaseSymbolIndex();
    }

    return {
      filesScanned: changes.length,
      symbolsFound: totalSymbols,
      edgesFound: totalEdges,
      durationMs: Date.now() - startTime,
      languageBreakdown: langBreakdown,
    };
  }

  /**
   * The walk of a repo, or of some of its folders (`from`), under the same rules. `skipUnchanged`
   * leaves out, unread, the indexed files whose size and mtime say they did not change.
   */
  private async discoverFiles(
    repoRoot: string, repoName: string, silent = false, options: { from?: string[]; skipUnchanged?: boolean; pathsOnly?: boolean } = {},
  ): Promise<DiscoveredFile[]> {
    const files: DiscoveredFile[] = [];
    const workspaceRoot = this.config.getWorkspaceRoot();
    const excludes = this.effectiveExcludes(repoName);
    const includes = [
      ...this.config.settings.includePatterns,
      ...this.cliIncludes,
    ];
    const matcher = buildMatcher(excludes, includes);

    const trackedHashes = new Map<string, string>();
    const allTracked = this.store.getAllFiles(repoName);
    for (const f of allTracked) {
      if (f.content_hash) trackedHashes.set(f.path as string, f.content_hash as string);
    }

    if (!silent) {
      this.onProgress?.({ phase: 'discover', current: 0, total: 0 });
    }

    // Another registered repo nested inside this one indexes its own files; walking into it
    // would index them twice under two repos and inflate counts (M0-23). Roots are compared by
    // canonical path, so a repo registered through a symlink is recognised at its real folder
    // (M0-02-R3). The walk never follows symlinks, so a child's canonical path is its parent's
    // plus its name.
    const ownRoot = canonicalPath(repoRoot);
    const registeredRoots = new Set(this.config.repos.map(r => canonicalPath(resolve(workspaceRoot, r.path))));
    const nestedRepoRoots = new Set([...registeredRoots].filter(p => p !== ownRoot));

    const walk = async (currentDir: string, canonicalDir: string) => {
      const entries = await readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (this.aborted) return;
        if (DEFAULT_IGNORE.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.mapx') continue;

        const fullPath = join(currentDir, entry.name);

        if (entry.isDirectory()) {
          const canonical = join(canonicalDir, entry.name);
          const relDir = relative(workspaceRoot, fullPath).replace(/\\/g, '/');
          if (this.shouldExcludeDir(relDir, excludes)) continue;

          if (nestedRepoRoots.has(canonical)) continue;

          // Check if this directory contains a .git entry (file or directory)
          // and is NOT the root or any registered repository path.
          const gitPath = join(fullPath, '.git');
          if (existsSync(gitPath)) {
            if (!registeredRoots.has(canonical)) {
              if (!silent) console.warn(`\n⚠️ Warning: Found unregistered nested git repository at ${fullPath}. Skipping walk inside this directory.`);
              continue;
            }
          }

          await walk(fullPath, canonical);
        } else if (entry.isFile()) {
          const relPath = relative(workspaceRoot, fullPath).replace(/\\/g, '/');
          if (!matcher(relPath)) continue;

          const langDef = getLanguageForFile(fullPath, this.config.getResolvedUserLanguages())
            ?? (entry.name.includes('.') ? null : shebangLanguage(fullPath));
          if (!langDef) continue;
          // The files the walk indexes, unread: what scanFull and scanIncremental need for
          // workspaceFileMap before each repo's own walk (M4-04). Only path and language are set.
          if (options.pathsOnly) {
            // The full walk skips a file it cannot read; so does this one (review 2026-11-01).
            try {
              accessSync(fullPath, fsConstants.R_OK);
            } catch {
              continue;
            }
            files.push({ absolutePath: fullPath, relativePath: relPath, language: langDef.name } as DiscoveredFile);
            continue;
          }

          try {
            if (options.skipUnchanged && trackedHashes.has(relPath) && this.unchangedSinceScan(relPath, await stat(fullPath))) continue;
            const content = await readFile(fullPath, 'utf-8');
            const stats = await stat(fullPath);
            const lines = content.split('\n').length;
            const contentHash = createHash('md5').update(content).digest('hex');
            const storedHash = trackedHashes.get(relPath);
            const isNew = !storedHash;
            const contentChanged = !!storedHash && storedHash !== contentHash;

            files.push({
              absolutePath: fullPath,
              relativePath: relPath,
              language: langDef.name,
              sizeBytes: stats.size,
              lines,
              contentHash,
              content,
              isNew,
              contentChanged,
            });

            if (!silent) {
              this.onProgress?.({ phase: 'discover', current: files.length, total: 0, file: relPath });
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    };

    for (const from of options.from ?? [repoRoot]) await walk(from, join(ownRoot, relative(repoRoot, from)));
    return files;
  }

  /** Tests a repo-relative path for lying inside another registered repo nested in this one. */
  private nestedRepoTest(repoRoot: string): (repoRelative: string) => boolean {
    const workspaceRoot = this.config.getWorkspaceRoot();
    const ownRoot = canonicalPath(repoRoot);
    const nested = this.config.repos
      .map(r => canonicalPath(resolve(workspaceRoot, r.path)))
      .filter(p => p !== ownRoot && p.startsWith(ownRoot + sep));
    if (nested.length === 0) return () => false;
    return (p: string) => {
      const canonical = join(ownRoot, p);
      return nested.some(n => canonical === n || canonical.startsWith(n + sep));
    };
  }

  /**
   * Gitignored files the scan walk reaches whose content is not the indexed content, repo-relative.
   * The walk does not read .gitignore, so scan indexes them; git never lists them (M0-02-R7). Removed
   * ones are found with the other indexed files missing from HEAD's tree and from disk.
   */
  private async ignoredChanges(
    repo: RepoConfig, repoRoot: string, entries: string[], inNestedRepo: (p: string) => boolean,
  ): Promise<GitFileStatus[]> {
    const workspaceRoot = this.config.getWorkspaceRoot();
    const repoPath = relative(workspaceRoot, repoRoot).replace(/\\/g, '/');
    const excludes = this.effectiveExcludes(repo.name);
    const includes = [...this.config.settings.includePatterns, ...this.cliIncludes];
    const changed: GitFileStatus[] = [];
    const folders: string[] = [];
    for (const entry of entries) {
      const path = entry.replace(/\/+$/, '');
      const absolutePath = resolve(repoRoot, path);
      const rel = relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
      if (inNestedRepo(path)) continue;
      if (entry.endsWith('/')) {
        // The walk skips an unregistered nested git repository (registered ones are tested above).
        if (isScannableDir(rel, excludes, repoPath) && !existsSync(join(absolutePath, '.git'))) folders.push(absolutePath);
        continue;
      }
      if (!isScannablePath(rel, excludes, includes, repoPath) || !this.languageFor(absolutePath)) continue;
      // Regular files only: the walk never follows a symlink.
      const stats = await lstat(absolutePath).catch(() => null);
      if (!stats?.isFile() || this.unchangedSinceScan(rel, stats)) continue;
      const content = await readFile(absolutePath, 'utf-8').catch(() => null);
      if (content !== null && this.store.getFile(rel)?.content_hash !== createHash('md5').update(content).digest('hex')) {
        changed.push({ path, status: 'modified' });
      }
    }
    // One walk for every ignored folder, reading only the files whose size or mtime moved.
    const walked = folders.length ? await this.discoverFiles(repoRoot, repo.name, true, { from: folders, skipUnchanged: true }) : [];
    for (const f of walked) {
      if (f.isNew || f.contentChanged) changed.push({ path: relative(repoRoot, f.absolutePath).replace(/\\/g, '/'), status: 'modified' });
    }
    return changed;
  }

  /** The language of a file as the walk decides it: by extension, else an extensionless script's shebang. */
  private languageFor(absolutePath: string) {
    return getLanguageForFile(absolutePath, this.config.getResolvedUserLanguages())
      ?? (basename(absolutePath).includes('.') ? null : shebangLanguage(absolutePath));
  }

  /** An indexed file whose size is the stored one and that was not modified after it was indexed. */
  private unchangedSinceScan(rel: string, stats: { size: number; mtimeMs: number }): boolean {
    const stored = this.store.getFile(rel);
    // ctime too: `cp -p` or `tar x` restores an older mtime, never an older ctime.
    const touched = Math.max(stats.mtimeMs, (stats as { ctimeMs?: number }).ctimeMs ?? 0);
    return !!stored && stored.size_bytes === stats.size && Date.parse(stored.last_scanned as string) > touched;
  }

  /**
   * Whether the path exists with this exact case (a case-insensitive disk finds `User.php` as
   * `user.php`). Each folder is listed once per sync (`listings`, cleared when a sync starts).
   */
  private existsExactly(absolutePath: string): boolean {
    if (!existsSync(absolutePath)) return false;
    const dir = dirname(absolutePath);
    let names = this.listings.get(dir);
    if (!names) {
      try {
        names = new Set(readdirSync(dir));
      } catch {
        names = new Set();
      }
      this.listings.set(dir, names);
    }
    return names.has(basename(absolutePath));
  }

  /** The workspace paths of the files git lists as changed that exist and belong to this repo. */
  private dirtyPaths(changes: GitFileStatus[], repoRoot: string, inNestedRepo: (p: string) => boolean): string[] {
    const workspaceRoot = this.config.getWorkspaceRoot();
    return [...new Set(changes
      .filter(c => c.status !== 'removed' && !inNestedRepo(c.path) && existsSync(resolve(repoRoot, c.path)))
      .map(c => relative(workspaceRoot, resolve(repoRoot, c.path)).replace(/\\/g, '/')))].sort();
  }


  private detectDeletedFiles(discovered: DiscoveredFile[], repoName: string): string[] {
    const currentPaths = new Set(discovered.map(f => f.relativePath));
    const tracked = this.store.getAllFiles(repoName);
    const deleted: string[] = [];
    for (const f of tracked) {
      const p = f.path as string;
      if (!currentPaths.has(p)) deleted.push(p);
    }
    return deleted;
  }

  private async parseFilesParallel(
    files: FileInfo[],
    workspaceRoot: string,
    ignoredSymbols?: ScopedIgnoredSymbols,
    onFileParsed?: (relPath: string) => void
  ): Promise<ParseResult[]> {
    if (files.length === 0) return [];
    if (this.parallel && files.length > 10) {
      try {
        return await this.parseWithWorkers(files, workspaceRoot, ignoredSymbols, onFileParsed);
      } catch (err: any) {
        // Fallback to main thread on error (e.g. worker initialization/spawn error). Say so: a
        // silent fallback hid a broken worker bootstrap for every source-mode scan (M0-06-R1).
        console.warn(`[mapx] Parallel parsing unavailable (${err?.message ?? err}); parsing on one thread.`);
        return this.parseOnMainThread(files, workspaceRoot, ignoredSymbols, onFileParsed);
      }
    }
    return this.parseOnMainThread(files, workspaceRoot, ignoredSymbols, onFileParsed);
  }

  private async parseWithWorkers(
    files: FileInfo[],
    workspaceRoot: string,
    ignoredSymbols?: ScopedIgnoredSymbols,
    onFileParsed?: (relPath: string) => void
  ): Promise<ParseResult[]> {
    const workerCount = Math.min(this.concurrency, files.length, 8);
    const workerExt = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    // If running in Vitest/TS, point to parse-worker.ts, otherwise parse-worker.js
    const workerUrl = new URL(`../parsers/parse-worker${workerExt}`, import.meta.url);

    const workers: Worker[] = [];
    const readyPromises: Promise<void>[] = [];
    const languages = {
      ...getBuiltinLanguages(),
      ...this.config.getResolvedUserLanguages()
    };
    const assetRoot = findAssetRoot(import.meta.url);
    // Workers parse with the same language parsers as the main thread (PHP post-processing etc.).
    const userLanguages = this.config.getResolvedUserLanguages();
    const facadeMap = this.config.settings.php?.facadeMap;

    for (let i = 0; i < workerCount; i++) {
      const worker = /\.ts$/.test(workerUrl.pathname)
        ? new Worker(
            // Resolve tsx from MapX's own install, not from the scanned workspace (which usually
            // has no tsx), otherwise every source-mode scan silently fell back to one thread.
            `import { register } from '${import.meta.resolve('tsx/esm/api')}';
             register();
             import('${workerUrl.href}');`,
            {
              eval: true,
              workerData: { languages, ignoredSymbols, assetRoot, userLanguages, facadeMap }
            }
          )
        : new Worker(workerUrl, {
            workerData: { languages, ignoredSymbols, assetRoot, userLanguages, facadeMap }
          });
      workers.push(worker);

      readyPromises.push(new Promise<void>((resolveReady, rejectReady) => {
        const onMessage = (msg: any) => {
          if (msg.type === 'ready') {
            worker.off('message', onMessage);
            worker.off('error', onError);
            resolveReady();
          } else if (msg.type === 'error') {
            worker.off('message', onMessage);
            worker.off('error', onError);
            rejectReady(new Error(msg.error || 'Worker init error'));
          }
        };
        const onError = (err: Error) => {
          worker.off('message', onMessage);
          worker.off('error', onError);
          rejectReady(err);
        };
        worker.on('message', onMessage);
        worker.on('error', onError);
      }));
    }

    // Wait for all workers to be initialized
    await Promise.all(readyPromises);

    let nextIdx = 0;
    const results: ParseResult[] = new Array(files.length);

    const runWorkerLoop = async (worker: Worker) => {
      return new Promise<void>((resolveLoop, rejectLoop) => {
        let currentResolve: (() => void) | null = null;
        let currentReject: ((err: Error) => void) | null = null;

        const onMessage = (msg: any) => {
          const resultIndex = msg.id;
          // fileMetadata carries the PHP namespace; dropping it lost namespace clusters on every
          // fresh parallel scan (M0-08-R1).
          results[resultIndex] = {
            symbols: msg.symbols || [],
            references: msg.references || [],
            errors: msg.errors || [],
            ...(msg.fileMetadata ? { fileMetadata: msg.fileMetadata } : {}),
          };

          const fileInfo = files[resultIndex];
          const relPath = relative(workspaceRoot, fileInfo.absolutePath).replace(/\\/g, '/');
          onFileParsed?.(relPath);

          if (currentResolve) {
            const cb = currentResolve;
            currentResolve = null;
            cb();
          }
        };

        const onError = (err: Error) => {
          if (currentReject) {
            currentReject(err);
          } else {
            rejectLoop(err);
          }
        };

        const onExit = (code: number) => {
          if (code !== 0) {
            const err = new Error(`Worker exited with code ${code}`);
            if (currentReject) currentReject(err);
            else rejectLoop(err);
          }
        };

        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);

        const nextJob = () => {
          if (this.aborted || nextIdx >= files.length) {
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
            resolveLoop();
            return;
          }

          const i = nextIdx++;
          const fileInfo = files[i];
          const relPath = relative(workspaceRoot, fileInfo.absolutePath).replace(/\\/g, '/');

          new Promise<void>((res, rej) => {
            currentResolve = res;
            currentReject = rej;
            worker.postMessage({
              id: i,
              filePath: relPath,
              absolutePath: fileInfo.absolutePath,
              language: fileInfo.language
            });
          }).then(() => {
            nextJob();
          }).catch((err) => {
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
            rejectLoop(err);
          });
        };

        nextJob();
      });
    };

    try {
      await Promise.all(workers.map(w => runWorkerLoop(w)));
    } finally {
      await Promise.all(workers.map(w => w.terminate()));
    }

    return results;
  }

  private async parseOnMainThread(
    files: FileInfo[],
    workspaceRoot: string,
    ignoredSymbols?: ScopedIgnoredSymbols,
    onFileParsed?: (relPath: string) => void
  ): Promise<ParseResult[]> {
    const results: ParseResult[] = new Array(files.length);

    // Use cached content from discovery when available, otherwise read from disk
    const sources = await Promise.all(
      files.map(async (f) => {
        try {
          return (f as DiscoveredFile).content || await readFile(f.absolutePath, 'utf-8');
        } catch {
          return null;
        }
      }),
    );

    // Parse with bounded concurrency: run up to CONCURRENCY parses simultaneously.
    // Each parse() is async and yields around WASM I/O points, so multiple can
    // interleave without blocking the event loop.
    const CONCURRENCY = this.concurrency;
    let nextIdx = 0;

    const runWorker = async () => {
      while (!this.aborted) {
        const i = nextIdx++;
        if (i >= files.length) break;

        const fileInfo = files[i];
        const relPath = relative(workspaceRoot, fileInfo.absolutePath).replace(/\\/g, '/');

        if (sources[i] === null) {
          results[i] = { symbols: [], references: [], errors: [{ message: `Failed to read ${relPath}` }] };
          onFileParsed?.(relPath);
          await new Promise(resolve => setImmediate(resolve));
          continue;
        }

        try {
          const parser = getParserForFile(relPath, this.config.getResolvedUserLanguages(), fileInfo.language);
          results[i] = await parser.parse(relPath, sources[i]!, {
            facadeMap: this.config.settings.php?.facadeMap,
            ignoredSymbols: ignoredSymbolsForFile(ignoredSymbols, relPath),
          });
        } catch {
          results[i] = { symbols: [], references: [], errors: [{ message: `Failed to parse ${relPath}` }] };
        }
        onFileParsed?.(relPath);
        await new Promise(resolve => setImmediate(resolve));
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, runWorker));

    return results;
  }

  private writeParseResult(relativePath: string, result: ParseResult, repoName: string): void {
    this.store.inTransaction(() => {
      this.writeParseResultWithMap(relativePath, result, repoName, this.workspaceFileMap);
    });
  }

  private writeParseResultWithMap(
    relativePath: string,
    result: ParseResult,
    repoName: string,
    fileMap: Map<string, string>,
  ): void {
    if (result.fileMetadata) {
      this.store.updateFileMetadata(relativePath, result.fileMetadata);
    }
    this.store.deleteSymbolsForFile(relativePath);

    for (const sym of result.symbols) {
      this.graph.addSymbolNode(
        sym.name, relativePath, sym.name, sym.kind,
        sym.startLine, sym.endLine, sym.scope,
      );

      this.store.insertSymbol({
        filePath: relativePath,
        repo: repoName,
        name: sym.name,
        kind: sym.kind,
        scope: sym.scope,
        signature: sym.signature,
        startLine: sym.startLine,
        endLine: sym.endLine,
        metadata: JSON.stringify(sym.metadata),
      });
    }

    this.store.deleteEdgesForFile(relativePath);

    const resolvedRefs = this.resolveReferencesWithMap(result.references, relativePath, repoName, fileMap, result.symbols);
    for (const edge of resolvedRefs) {
      this.graph.addDependencyEdge(edge);
      this.store.insertEdge(edge);
    }
  }

  private resolveReferencesWithMap(
    refs: ExtractedReference[],
    sourcePath: string,
    repoName: string,
    fileMap: Map<string, string>,
    symbols?: any[],
  ): GraphEdge[] {
    const edges: GraphEdge[] = [];
    // From the path, or the shebang language discovery stored for an extensionless script.
    const sourceLanguage = this.languageOf(sourcePath);
    const isJsOrTs = /\.([cm]?[jt]sx?|vue|svelte)$/.test(sourcePath) || sourceLanguage === 'javascript' || sourceLanguage === 'typescript';

    const resolver = sourceLanguage ? importResolverFor(sourceLanguage) : undefined;
    // Simple names this file uses (C# picks, among the files declaring a namespace, those whose types it uses).
    let referencedNames: Set<string> | undefined;
    let jsBindings: { packages: Set<string>; local: Set<string> } | undefined;
    const usedNames = () => (referencedNames ??= new Set(refs
      .filter(r => r.referenceType !== 'import' && r.referenceType !== 'require' && typeof r.targetName === 'string')
      .map(r => r.targetName.replace(/<[\s\S]*$/, '').split(/\.|::/).pop()!)));

    for (const ref of refs) {
      if (!ref.targetName || typeof ref.targetName !== 'string') continue;
      const vueHint = ref.metadata?.vue as VueResolveHint | undefined;
      const navigate = ref.referenceType === 'navigate';
      if (isJsOrTs && !vueHint && !navigate && BUILTIN_GLOBALS.has(ref.targetName)) continue;
      // Library code, not a project symbol of the same name (M0-17-R4): a call on a receiver bound by
      // an import from an npm package (`axios.create()`, `_.get()`), and a global function the file
      // neither imports nor declares (`fetch()`).
      if (isJsOrTs && ref.referenceType === 'call' && !vueHint && !ref.vueThis && !ref.vueStore) {
        const receiver = ref.metadata?.receiver as string | undefined;
        jsBindings ??= this.jsImportBindings(sourcePath, fileMap);
        if (receiver ? jsBindings.packages.has(receiver) : jsBindings.packages.has(ref.targetName)
          || (JS_GLOBAL_FUNCTIONS.has(ref.targetName) && !jsBindings.local.has(ref.targetName)
            && !(symbols ?? []).some((s: any) => s.name === ref.targetName && !s.scope))) continue;
      }
      // Module-style imports (Java, Rust, Go, Python, Ruby, C#, PHP): one edge per resolved file,
      // named by the module/namespace rather than the raw statement (M0-12-R4).
      let targets: { file: string; symbol: string; verifiability?: 'verified' | 'inferred'; metadata?: Record<string, unknown> }[] | undefined;
      let vueHit: { file: string; symbol: string } | null | undefined;

      if (navigate) {
        targets = this.resolveNavigation(ref, sourcePath, fileMap);
      } else if (vueHint) {
        targets = this.resolveVueReference(ref, vueHint, sourcePath, fileMap);
      } else if (resolver && (ref.referenceType === 'import' || ref.referenceType === 'require')) {
        targets = this.resolveModuleImport(resolver, ref.targetName, sourcePath, fileMap, usedNames);
      } else if (ref.phpFunction) {
        // A PHP function call: the first candidate declared as a function in its namespace (M0-04-R5).
        targets = this.resolvePhpFunction(ref.phpFunction, sourcePath);
      } else if (sourceLanguage === 'go' && ref.metadata && 'goPackage' in ref.metadata) {
        // Go `struct { log.Logger }`: the type in the imported project package, never a homonym
        // elsewhere; a standard-library or third-party package links nothing (M0-17-R5).
        targets = this.resolveGoQualifiedType(ref, resolver, sourcePath, fileMap, usedNames);
      } else if ((ref.vueThis || ref.vueStore) && (vueHit = ref.vueStore
        ? resolveStoreTarget(ref.targetName, ref.vueStore, this.vueResolveContext(sourcePath, fileMap))
        : resolveThisMember(ref.targetName, ref.vueThis!, this.vueResolveContext(sourcePath, fileMap))) !== undefined) {
        // Options API `this.x()` (M3-03) and Vuex / Pinia members (M3-05): resolved by the Vue
        // rules in their component, mixin or store file, never by name alone. Undefined: the hook
        // is not a store after all (M3-05-R1), so the reference resolves as any other.
        targets = vueHit ? [vueHit] : [];
      } else {
        let targetFile: string | null = null;
        if (ref.referenceType === 'require') {
          targetFile = this.resolveRequirePath(ref.targetName, sourcePath, fileMap);
        } else if (ref.referenceType === 'import') {
          targetFile = this.resolveImportPath(ref.targetName, sourcePath, fileMap);
        } else {
          // Calls and instantiations skip value symbols (constants, variables) (M0-17-R2).
          const callable = ref.referenceType === 'call' || ref.referenceType === 'instantiation';
          // A name the file imports from a project module is that module's declaration (M2-08).
          const viaImport = callable ? this.resolveImportedCall(ref, sourcePath, sourceLanguage, isJsOrTs, fileMap, symbols) : null;
          if (viaImport !== null) {
            // false: the import binds a value (`export const options = {…}`), which no call reaches (M0-17-R2).
            targets = viaImport ? [viaImport] : [];
            targetFile = null;
          } else {
            targetFile = this.resolveSymbolToFile(ref.targetName, fileMap, sourcePath, callable);
          }
        }
        targets ??= targetFile ? [{ file: targetFile, symbol: ref.targetName }] : [];
      }

      for (const { file: targetFile, symbol: targetSymbol, verifiability, metadata: targetMetadata } of targets) {
        const targetRepoName = fileMap.get(targetFile);

        let sourceSymbol: string | null = ref.sourceSymbol;
        if (!sourceSymbol && symbols) {
          let bestSym: any = null;
          let bestSpan = Infinity;
          for (const sym of symbols) {
            if (sym.startLine <= ref.startLine && ref.startLine <= sym.endLine) {
              const span = sym.endLine - sym.startLine;
              if (span < bestSpan) {
                bestSpan = span;
                bestSym = sym;
              }
            }
          }
          if (bestSym) {
            sourceSymbol = bestSym.scope ? `${bestSym.scope}::${bestSym.name}` : bestSym.name;
          }
        }

        // C# base lists: the parser guesses class or interface from the name; an indexed target's
        // kind decides (M0-17-R3).
        const edgeType = sourceLanguage === 'c-sharp' && (ref.referenceType === 'extends' || ref.referenceType === 'implements') && symbols
          ? this.csharpBaseEdgeType(ref, targetFile, symbols)
          : ref.referenceType;
        // The Vue resolution hint has served its purpose; the edge keeps the rest.
        const { vue: _vueHint, receiver: _receiver, goPackage: _goPackage, ...metadata } = ref.metadata ?? {};

        edges.push({
          sourceFile: sourcePath,
          targetFile,
          sourceSymbol,
          targetSymbol,
          edgeType,
          repo: repoName,
          weight: 1.0,
          verifiability: verifiability ?? ref.verifiability ?? 'verified',
          targetRepo: (targetRepoName && targetRepoName !== repoName) ? targetRepoName : undefined,
          // Keep what the parser recorded (relationship, binding, facade, dispatch details).
          metadata: { ...metadata, ...targetMetadata, startLine: ref.startLine },
        });
      }
    }

    return edges;
  }

  /**
   * The files importing a changed JS/TS/Python module, and the importers of each barrel among them
   * (a module that re-exports, or a package __init__.py), up to five levels: their calls resolve
   * through what the module declares or re-exports, so sync re-parses them (M2-08).
   */
  private importerReferrers(paths: string[]): Set<string> {
    const importers = new Set<string>();
    let level = paths.filter(p => MODULE_FILE.test(p));
    for (let depth = 0; depth < 5 && level.length; depth++) {
      const next: string[] = [];
      for (const p of level) {
        for (const importer of this.store.getImporters(p)) {
          if (importers.has(importer) || paths.includes(importer)) continue;
          importers.add(importer);
          if (this.isBarrel(importer)) next.push(importer);
        }
      }
      level = next;
    }
    return importers;
  }

  /** A module whose exports include another module's: `export … from`, or a package __init__.py. */
  private isBarrel(path: string): boolean {
    if (path.endsWith('__init__.py')) return true;
    return /\bexport\s*(?:\*|\{[^}]*\})\s*from\b/.test(stripComments(this.readWorkspaceText(path) ?? '', false));
  }

  /**
   * A call or instantiation of a name the file binds by import to a project module: the declaration
   * in that module, through re-exports (M2-08). JS/TS: a bare name's named or default binding, or a
   * receiver's namespace binding (`ns.f()`). Python: the dotted receiver on the call's line when it
   * is a module binding (`utils.f()`, `pkg.mod.f()`), else a bare name's `from m import` binding.
   * False when the binding is a value symbol (a literal constant), which no call reaches (M0-17-R2).
   * Null when the name is not bound, or its declaration is not found: name lookup then applies.
   */
  private resolveImportedCall(
    ref: ExtractedReference, sourcePath: string, language: string | null, isJsOrTs: boolean, fileMap: Map<string, string>,
    symbols?: Array<{ name: string; kind: string; startLine: number; endLine: number }>,
  ): { file: string; symbol: string } | false | null {
    const python = language === 'python';
    if (!isJsOrTs && !python) return null;
    const bindings = this.importBindings(sourcePath, python, fileMap);
    if (!bindings.size) return null;
    const name = ref.targetName;
    let receiver = ref.metadata?.receiver as string | undefined;
    // The file declares the name where the call sees it (a later top-level def, a function nested in
    // the caller's enclosing function): the declaration shadows the import, and name lookup picks the
    // file's own (review 2026-11-01).
    if (!receiver && symbols) {
      let declared = this.declaredNames.get(symbols);
      if (!declared) this.declaredNames.set(symbols, (declared = new Set(symbols.filter(d => d.kind !== 'method').map(d => d.name))));
      if (declared.has(name) && symbols.some(d => d.name === name && d.kind !== 'method' && this.visibleAt(d, ref.startLine, symbols))) return null;
    }
    if (python && !receiver) {
      let lines = this.lineCache.get(sourcePath);
      if (!lines) this.lineCache.set(sourcePath, (lines = (this.readWorkspaceText(sourcePath) ?? '').split('\n')));
      const line = lines[ref.startLine - 1] ?? '';
      if (!line.includes(name)) return null;
      let patterns = this.callPatterns.get(name);
      if (!patterns) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        patterns = { attribute: new RegExp(`([A-Za-z_][\\w.]*)\\.${escaped}\\s*\\(`), bare: new RegExp(`(^|[^\\w.])${escaped}\\s*\\(`) };
        this.callPatterns.set(name, patterns);
      }
      const attribute = patterns.attribute.exec(line)?.[1];
      const bare = patterns.bare.test(line);
      // Both forms on one line (`utils.create(create())`): which reference is which is unknown.
      if ((attribute && bare) || (!attribute && !bare)) return null;
      receiver = attribute;
    }
    if (receiver) {
      const module = bindings.get(receiver);
      return module && module.imported === null ? this.findExport(module.file, name, fileMap) : null;
    }
    const binding = bindings.get(name);
    if (!binding || binding.imported === null) return null;
    const exported = binding.imported === 'default' && !python ? this.defaultExportName(binding.file) : binding.imported;
    return exported ? this.findExport(binding.file, exported, fileMap) : null;
  }

  /** A declaration is visible at a line: anywhere at module level, else within its enclosing symbol. */
  private visibleAt(
    decl: { startLine: number; endLine: number }, line: number, symbols: Array<{ startLine: number; endLine: number; kind: string }>,
  ): boolean {
    let enclosing: { startLine: number; endLine: number } | null = null;
    for (const s of symbols) {
      if (s === decl || s.kind === 'class' || s.startLine > decl.startLine || s.endLine < decl.endLine) continue;
      if (s.startLine === decl.startLine && s.endLine === decl.endLine) continue;
      if (!enclosing || s.endLine - s.startLine < enclosing.endLine - enclosing.startLine) enclosing = s;
    }
    return !enclosing || (enclosing.startLine <= line && line <= enclosing.endLine);
  }

  /**
   * The top-level declaration of `name` in `file`, or in the module it re-exports it from (M2-08).
   * False when it is a value symbol a call cannot reach (a JS/TS/Python constant or variable).
   */
  private findExport(file: string, name: string, fileMap: Map<string, string>, depth = 0): { file: string; symbol: string } | false | null {
    // Memoised per phase, and a module seen on the current path ends it: a barrel graph (`export *`
    // fan-out, cycles) is walked once per name (review 2026-11-01).
    const key = `${file}\0${name}`;
    if (this.exportCache.has(key)) return this.exportCache.get(key)!;
    this.exportCache.set(key, null);
    const found = this.findExportUncached(file, name, fileMap, depth);
    this.exportCache.set(key, found);
    return found;
  }

  private findExportUncached(file: string, name: string, fileMap: Map<string, string>, depth: number): { file: string; symbol: string } | false | null {
    const declared = (this.symbolIndex?.get(name.toLowerCase()) ?? []).filter(e => e.file === file && e.name === name && !e.scope);
    if (declared.length) {
      const value = (e: SymbolIndexEntry) => (e.kind === 'constant' || e.kind === 'variable') && VALUE_SYMBOL_LANGUAGES.has(this.languageOf(file) ?? '');
      return declared.every(value) ? false : { file, symbol: name };
    }
    if (depth >= 5) return null;
    const python = file.endsWith('.py');
    // A name the file imports and passes on: `from .impl import x` in a package's __init__.py, or
    // `import { x } from './a'; export { x }`.
    const bound = this.importBindings(file, python, fileMap).get(name);
    const text = stripComments(this.readWorkspaceText(file) ?? '', python);
    if (python) return bound?.imported ? this.findExport(bound.file, bound.imported, fileMap, depth + 1) : null;
    let hit: { file: string; symbol: string } | false | null;
    for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      for (const part of m[1]!.split(',')) {
        const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        if ((alias ?? orig) !== name || !orig) continue;
        const target = this.resolveImportPath(m[2]!, file, fileMap);
        return target ? this.findExport(target, orig === 'default' ? this.defaultExportName(target) ?? orig : orig, fileMap, depth + 1) : null;
      }
    }
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (bound?.imported && new RegExp(`\\bexport\\s*\\{[^}]*(?<![\\w$])${escapedName}(?![\\w$])[^}]*\\}(?!\\s*from)`).test(text)) {
      return this.findExport(bound.file, bound.imported, fileMap, depth + 1);
    }
    for (const m of text.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
      const target = this.resolveImportPath(m[1]!, file, fileMap);
      hit = target ? this.findExport(target, name, fileMap, depth + 1) : null;
      if (hit !== null) return hit;
    }
    return null;
  }

  /** The declared name of a JS/TS module's default export (`export default function build`). */
  private defaultExportName(file: string): string | null {
    const text = this.readWorkspaceText(file) ?? '';
    const m = /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+)?([A-Za-z_$][\w$]*)/.exec(text);
    return m && !['function', 'class', 'async'].includes(m[1]!) ? m[1]! : null;
  }

  /** The names a file binds by import to project modules, keyed by local name or dotted module path (M2-08). */
  private importBindings(file: string, python: boolean, fileMap: Map<string, string>): Map<string, ImportBinding> {
    const cached = this.importBindingsCache.get(file);
    if (cached) return cached;
    const bindings = new Map<string, ImportBinding>();
    this.importBindingsCache.set(file, bindings);
    const text = stripComments(this.readWorkspaceText(file) ?? '', python);
    if (python) {
      const resolver = importResolverFor('python');
      if (!resolver) return bindings;
      const moduleFile = (module: string) => this.resolveModuleImport(resolver, module, file, fileMap, () => new Set())[0]?.file ?? null;
      // Joined continuation lines: `from m import (\n a,\n b)`.
      const source = text.replace(/\(\s*([^)]*?)\s*\)/g, (m, inner: string) => (m.includes('\n') ? `(${inner.replace(/\s*\n\s*/g, ' ')})` : m));
      for (const line of source.split('\n')) {
        const from = /^\s*from\s+([\w.]+)\s+import\s+\(?([^)#]+)\)?/.exec(line);
        if (from) {
          const module = from[1]!;
          for (const part of from[2]!.split(',')) {
            const [imported, alias] = part.trim().split(/\s+as\s+/);
            if (!imported || imported === '*' || !/^\w+$/.test(imported)) continue;
            const sub = moduleFile(module.endsWith('.') ? module + imported : `${module}.${imported}`);
            if (sub && (sub.endsWith(`/${imported}.py`) || sub === `${imported}.py` || sub.endsWith(`/${imported}/__init__.py`))) {
              bindings.set(alias ?? imported, { file: sub, imported: null });
              continue;
            }
            const target = moduleFile(module);
            if (target) bindings.set(alias ?? imported, { file: target, imported });
          }
          continue;
        }
        const imp = /^\s*import\s+([^#]+)/.exec(line);
        if (!imp) continue;
        for (const part of imp[1]!.split(',')) {
          const [module, alias] = part.trim().split(/\s+as\s+/);
          if (!module || !/^[\w.]+$/.test(module)) continue;
          const target = moduleFile(module);
          if (target) bindings.set(alias ?? module, { file: target, imported: null });
        }
      }
      return bindings;
    }
    const bind = (specifier: string, entries: [string, string | null][]) => {
      const target = this.resolveImportPath(specifier, file, fileMap);
      if (!target || !fileMap.has(target)) return;
      for (const [local, imported] of entries) bindings.set(local, { file: target, imported });
    };
    const named = (clause: string, renameSeparator: RegExp): [string, string][] => clause.split(',').flatMap((part) => {
      const [imported, local] = part.trim().replace(/^type\s+/, '').split(renameSeparator);
      const name = (local ?? imported)?.trim();
      return imported && name && /^[\w$]+$/.test(imported.trim()) && /^[\w$]+$/.test(name) ? [[name, imported.trim()] as [string, string]] : [];
    });
    for (const m of text.matchAll(/\bimport\s+(?!type\s)([^'"`;]+?)\s+from\s*['"]([^'"]+)['"]/g)) {
      const clause = m[1]!;
      const entries: [string, string | null][] = [];
      const braces = /\{([^}]*)\}/.exec(clause);
      if (braces) entries.push(...named(braces[1]!, /\s+as\s+/));
      const rest = clause.replace(/\{[^}]*\}/, '');
      const star = /\*\s*as\s+([\w$]+)/.exec(rest);
      if (star) entries.push([star[1]!, null]);
      const def = /^\s*([\w$]+)/.exec(rest.replace(/\*\s*as\s+[\w$]+/, ''));
      if (def) entries.push([def[1]!, 'default']);
      bind(m[2]!, entries);
    }
    for (const m of text.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      bind(m[2]!, m[1]!.startsWith('{') ? named(m[1]!.slice(1, -1), /\s*:\s*/) : [[m[1]!, null]]);
    }
    return bindings;
  }

  /**
   * The names a JS/TS/Vue file binds by import or require: `local` holds them all, `packages` those
   * whose specifier is an npm package (M0-17-R4): listed with a registry version in an enclosing
   * package.json, declared by no workspace package, and resolved to no project file. A name the file
   * also declares as a variable is left out of `packages` (a local `api` shadows an imported one).
   */
  private jsImportBindings(sourcePath: string, fileMap: Map<string, string>): { packages: Set<string>; local: Set<string> } {
    const text = this.readWorkspaceText(sourcePath) ?? '';
    const packages = new Set<string>();
    const local = new Set<string>();
    // Declared by the file (a `require` binding is the import itself, not a shadowing local).
    const declared = new Set([
      ...[...text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=(?!\s*require\s*\()/g)].map(m => m[1]!),
      ...[...text.matchAll(/\b(?:function|class)\s+([\w$]+)/g)].map(m => m[1]!),
    ]);
    const bind = (names: string[], specifier: string) => {
      const external = this.isNpmPackage(specifier, sourcePath) && !this.resolveImportPath(specifier, sourcePath, fileMap);
      for (const name of names) {
        local.add(name);
        if (external && !declared.has(name)) packages.add(name);
      }
    };
    const namesOf = (clause: string) => {
      const names: string[] = [];
      const braces = /\{([^}]*)\}/.exec(clause);
      for (const part of braces?.[1]?.split(',') ?? []) {
        const n = /(?:^|\s)(?:type\s+)?[\w$]+(?:\s+as\s+([\w$]+))?\s*$/.exec(part.trim());
        const name = n?.[1] ?? part.trim().replace(/^type\s+/, '').split(/\s+/)[0];
        if (name && /^[\w$]+$/.test(name)) names.push(name);
      }
      const rest = clause.replace(/\{[^}]*\}/, '');
      const star = /\*\s*as\s+([\w$]+)/.exec(rest);
      if (star) names.push(star[1]!);
      const def = /^\s*(?:type\s+)?([\w$]+)/.exec(rest.replace(/\*\s*as\s+[\w$]+/, ''));
      if (def && def[1] !== 'type') names.push(def[1]!);
      return names;
    };
    for (const m of text.matchAll(/\bimport\s+([^'"`;]+?)\s+from\s*['"]([^'"]+)['"]/g)) bind(namesOf(m[1]!), m[2]!);
    for (const m of text.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      bind(m[1]!.startsWith('{') ? namesOf(m[1]!) : [m[1]!], m[2]!);
    }
    return { packages, local };
  }

  /**
   * Whether a bare specifier names an npm package: an enclosing package.json lists it with a
   * registry version (not `workspace:`, `file:`, `link:` or a path), and no package.json of the
   * workspace declares that name (a workspace package is project code) (M0-17-R4).
   */
  private isNpmPackage(specifier: string, sourcePath: string): boolean {
    if (/^[./~#@]\//.test(specifier) || /^[./]/.test(specifier)) return false;
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
    if (!name || name === '@') return false;
    // The package names declared in the folders holding indexed files (manifests are not indexed).
    let workspaceNames = this.npmWorkspaceNames;
    if (!workspaceNames) {
      workspaceNames = new Set<string>();
      const dirs = new Set<string>();
      for (const path of this.workspaceFileMap.keys()) {
        for (let dir = path; dir.includes('/');) {
          dir = dir.slice(0, dir.lastIndexOf('/'));
          if (dirs.has(dir)) break;
          dirs.add(dir);
        }
      }
      for (const dir of dirs) {
        try {
          const declared = JSON.parse(this.readWorkspaceText(`${dir}/package.json`) ?? 'null')?.name;
          if (typeof declared === 'string') workspaceNames.add(declared);
        } catch { /* not a manifest */ }
      }
      this.npmWorkspaceNames = workspaceNames;
    }
    if (workspaceNames.has(name)) return false;
    const workspaceRoot = this.config.getWorkspaceRoot();
    for (let dir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : ''; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
      let manifest: any = null;
      try { manifest = JSON.parse(this.readWorkspaceText(dir ? `${dir}/package.json` : 'package.json') ?? 'null'); } catch { /* unreadable */ }
      if (manifest && typeof manifest === 'object') {
        if (manifest.name === name) return false;
        const version = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }[name];
        if (typeof version === 'string') return !/^(workspace:|file:|link:|portal:|\.|\/)/.test(version);
      }
      // Installed although no manifest lists it.
      if (existsSync(resolve(workspaceRoot, dir, 'node_modules', name))) return true;
      if (!dir) return false;
    }
  }

  /** What the Vue resolvers need from the scanner (M3-03, M3-05). */
  private vueResolveContext(sourcePath: string, fileMap: Map<string, string>): VueResolveContext {
    return {
      sourceFile: sourcePath,
      resolveImport: (specifier, from = sourcePath) => this.resolveImportPath(specifier, from, fileMap),
      defines: (file, name) => this.fileDefines(file, name),
      vuexFiles: () => this.vuexFiles,
    };
  }

  /**
   * Vue template references (M3-02, edge contract rules 4 and 5) resolve only through their hint:
   * a call to a symbol of the SFC itself, then of the first hinted module that defines it, then (in
   * an Options API component) as `this.x()` would; a render to the `.vue` file of the local
   * registration, or of the global one. Never by name elsewhere.
   */
  private resolveVueReference(
    ref: ExtractedReference, hint: VueResolveHint, sourcePath: string, fileMap: Map<string, string>,
  ): { file: string; symbol: string }[] {
    if (ref.referenceType === 'render') {
      const from = hint.from?.[0];
      let file = hint.global
        ? this.vueGlobalComponents(sourcePath, fileMap).get(ref.targetName)
        : from && this.resolveImportPath(from.specifier, sourcePath, fileMap);
      // A Svelte `<ui.Button>` of `import * as ui from './ui'`: Button in that module, through its
      // re-exports (M0-12-R10).
      if (file && from && from.name !== 'default' && !COMPONENT_FILE.test(file)) {
        file = this.moduleMember(from.specifier, from.name, sourcePath, fileMap)?.file ?? this.defaultReExport(file, from.name, fileMap);
      }
      return file && COMPONENT_FILE.test(file) ? [{ file, symbol: vueComponentName(file).replace(/\.svelte$/, '') }] : [];
    }
    if (hint.sameFile && this.fileDefines(sourcePath, ref.targetName)) return [{ file: sourcePath, symbol: ref.targetName }];
    for (const { specifier, name } of hint.from ?? []) {
      const found = this.moduleMember(specifier, name, sourcePath, fileMap);
      if (found) return [found];
    }
    const hit = ref.vueThis ? resolveThisMember(ref.targetName, ref.vueThis, this.vueResolveContext(sourcePath, fileMap)) : null;
    return hit ? [hit] : [];
  }

  /**
   * The component a barrel re-exports under a new name: `export { default as PrimaryButton } from
   * './Button.svelte'` (review 2026-11-01). Null when `file` holds no such re-export.
   */
  private defaultReExport(file: string, name: string, fileMap: Map<string, string>): string | null {
    const text = this.readWorkspaceText(file) ?? '';
    for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      if (!m[1]!.split(',').some(part => new RegExp(`^\\s*default\\s+as\\s+${name.replace(/[$]/g, '\\$')}\\s*$`).test(part))) continue;
      const target = this.resolveImportPath(m[2]!, file, fileMap);
      if (target && COMPONENT_FILE.test(target)) return target;
    }
    return null;
  }

  /**
   * The symbol `name` of the module `specifier` imported from `fromFile`, following up to three
   * re-exports (`export { name } from …`, `export * from …`) of a barrel file (M3-04).
   */
  private moduleMember(
    specifier: string, name: string, fromFile: string, fileMap: Map<string, string>, depth = 0,
  ): { file: string; symbol: string } | null {
    const file = this.resolveImportPath(specifier, fromFile, fileMap);
    if (!file) return null;
    if (this.fileDefines(file, name)) return { file, symbol: name };
    const text = depth < 3 ? this.readWorkspaceText(file) : null;
    for (const next of text ? reExportsOf(text, name) : []) {
      const found = this.moduleMember(next.specifier, next.name, file, fileMap, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /**
   * Vue Router navigation (M3-06, edge contract rule 9): the component of the route record the
   * target names, from the repo's route table; exact name or path, never by similarity. The edge
   * carries the record in `metadata.route`; a `:param` pattern match is inferred.
   */
  private resolveNavigation(
    ref: ExtractedReference, sourcePath: string, fileMap: Map<string, string>,
  ): { file: string; symbol: string; verifiability: 'verified' | 'inferred'; metadata: Record<string, unknown> }[] {
    const target = ref.metadata?.navigate as NavTarget | undefined;
    if (!target) return [];
    const repo = fileMap.get(sourcePath) ?? '';
    // The route records of the caller's app folder, in files where vue-router is active (M3-08-R1).
    const scope = this.vueScope(repo, sourcePath);
    const key = `${repo}\0${scope}`;
    let table = this.vueRoutes.get(key);
    if (!table) {
      const files = [...fileMap]
        .filter(([path, r]) => r === repo && /\.[cm]?[jt]sx?$/.test(path) && this.vueSees(scope, this.vueScope(repo, path)) && this.vueRouterActive(repo, path))
        .map(([path]) => path);
      table = buildRouteTable(files, (path) => this.readWorkspaceText(path), (spec, from) => this.resolveImportPath(spec, from, fileMap));
      this.vueRoutes.set(key, table);
    }
    const hit = matchRoute(target, table, sourcePath);
    const file = hit?.route.componentFile;
    if (!hit || !file?.endsWith('.vue')) return [];
    const { name, path } = hit.route;
    return [{
      file, symbol: vueComponentName(file), verifiability: hit.exact ? 'verified' : 'inferred',
      metadata: { route: { file: hit.route.file, name, path } },
    }];
  }

  /** Whether `file` declares a symbol named exactly `name` (this phase's index, else the store). */
  private fileDefines(file: string, name: string): boolean {
    const entries = this.symbolIndex?.get(name);
    if (this.symbolIndex) return !!entries?.some((e) => e.file === file && e.name === name);
    return this.store.getSymbolsForFile(file).some((s: any) => s.name === name);
  }

  /**
   * Globally registered Vue components seen from `sourcePath` (PascalCase name → `.vue` file): those
   * of the JS/TS files of its repo and Vue scope that call `.component(`: `Vue.component('Name', X)` /
   * `app.component('Name', X)` through X's import, and `require.context` / `import.meta.glob`
   * auto-registration by basename. Built once per resolution phase and scope; the first
   * registration of a name, by file path, wins, so a fresh index and a sync agree (M3-08-R1).
   */
  private vueGlobalComponents(sourcePath: string, fileMap: Map<string, string>): Map<string, string> {
    const repo = fileMap.get(sourcePath);
    const own = this.vueScopeRegistry(repo, this.vueScope(repo, sourcePath), fileMap);
    // A component an app's registering file imports runs inside that app too (an nWidart module's
    // SFC that the root app.js registers): its registrations follow the component's own scope's
    // (final review 2026-10-31).
    const importers = this.vueImporterScopes(repo, fileMap).get(sourcePath);
    if (!importers?.size) return own;
    const merged = new Map(own);
    for (const scope of [...importers].sort()) {
      for (const [name, file] of this.vueScopeRegistry(repo, scope, fileMap)) if (!merged.has(name)) merged.set(name, file);
    }
    return merged;
  }

  /** The scopes, other than its own, whose registering files import each `.vue` file. */
  private vueImporterScopes(repo: string | undefined, fileMap: Map<string, string>): Map<string, Set<string>> {
    const key = `${repo ?? ''}\0importers`;
    const cached = this.vueImporters.get(key);
    if (cached) return cached;
    const importers = new Map<string, Set<string>>();
    for (const path of [...fileMap.keys()].sort()) {
      if (fileMap.get(path) !== repo || !JS_TS_FILE.test(path)) continue;
      const text = this.readWorkspaceText(path);
      if (!text || !/\.component\s*\(/.test(text)) continue;
      const scope = this.vueScope(repo, path);
      // The components it registers (`app.component('X', X)`), not every .vue file it imports.
      for (const { specifier } of globalRegistrations(text).named) {
        const file = this.resolveImportPath(specifier, path, fileMap);
        if (!file?.endsWith('.vue') || this.vueScope(repo, file) === scope) continue;
        (importers.get(file) ?? importers.set(file, new Set()).get(file)!).add(scope);
      }
    }
    this.vueImporters.set(key, importers);
    return importers;
  }

  /** The global registrations one Vue scope sees (see `vueGlobalComponents`). */
  private vueScopeRegistry(repo: string | undefined, scope: string, fileMap: Map<string, string>): Map<string, string> {
    const key = `${repo ?? ''}\0${scope}`;
    let registry = this.vueGlobals.get(key);
    if (registry) return registry;
    registry = new Map();
    this.vueGlobals.set(key, registry);
    const inScope = (f: string) => fileMap.get(f) === repo && this.vueSees(scope, this.vueScope(repo, f));
    const vueFiles = [...fileMap.keys()].filter((f) => f.endsWith('.vue') && inScope(f));
    // An app's own registrations first, then the libraries' (a plugin's `install(app)`), each by path.
    const own = (f: string) => this.vueScope(repo, f) === scope;
    const registrars = [...fileMap.keys()].filter((f) => JS_TS_FILE.test(f) && inScope(f)).sort();
    for (const path of [...registrars.filter(own), ...registrars.filter((f) => !own(f))]) {
      const text = this.readWorkspaceText(path);
      if (!text || !/\.component\s*\(/.test(text)) continue;
      const { named, globs } = globalRegistrations(text);
      for (const { name, specifier } of named) {
        const file = this.resolveImportPath(specifier, path, fileMap);
        if (file?.endsWith('.vue') && !registry.has(name)) registry.set(name, file);
      }
      for (const glob of globs) {
        for (const file of vueGlobFiles(path, glob, vueFiles)) {
          const name = vueComponentName(file);
          if (!registry.has(name)) registry.set(name, file);
        }
      }
    }
    return registry;
  }

  /**
   * The Vue scope of a file, `<kind>:<folder>`: its nearest folder whose `package.json` is a
   * boundary, up to the repo folder, whatever the repo root's manifest lists (M3-08, M3-08-R1).
   * A component library declares vue as a peer dependency, builds in library mode or publishes an
   * entry (`exports`, `module`); otherwise a folder with a bundler config, or a package.json listing a
   * bundler or dev server (vite, @vue/cli-service, nuxt, webpack, …), is an app, and any other
   * package.json naming a package or dependencies is a library; a `{"type": "module"}` marker is no
   * boundary (see `vueManifestKind`). Each app keeps its own global registry and route
   * table; a library sees them all, and an app sees the libraries' registrations after its own.
   */
  private vueScope(repoName: string | undefined, path: string): string {
    const cached = this.vueScopes.get(path);
    if (cached !== undefined) return cached;
    const repo = this.config.repos.find(r => r.name === repoName);
    const workspaceRoot = this.config.getWorkspaceRoot();
    const repoPath = repo ? relative(workspaceRoot, resolve(workspaceRoot, repo.path)).replace(/\\/g, '/') : '';
    const parent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    let scope = `app:${repoPath}`;
    for (let dir = parent(path); dir && dir !== repoPath && dir.startsWith(repoPath); dir = parent(dir)) {
      const kind = this.vueManifestKind(dir);
      if (kind) {
        scope = `${kind}:${dir}`;
        break;
      }
    }
    this.vueScopes.set(path, scope);
    return scope;
  }

  private vueManifestKind(dir: string): 'app' | 'library' | null {
    const configs = BUNDLER_CONFIGS.map(name => this.readWorkspaceText(`${dir}/${name}`)).filter((t): t is string => t !== null);
    let manifest: any = null;
    try {
      manifest = JSON.parse(this.readWorkspaceText(`${dir}/package.json`) ?? 'null');
    } catch { /* no manifest */ }
    if (manifest && typeof manifest === 'object') {
      const deps = { ...manifest.dependencies, ...manifest.devDependencies };
      const peers = manifest.peerDependencies ?? {};
      if (!manifest.name && Object.keys(deps).length === 0 && Object.keys(peers).length === 0 && !configs.length) return null;
      // A component library: vue as a peer dependency, a library build (Vite `build.lib`, Vue CLI
      // `--target lib`) or a published entry (`exports`, `module`), whatever builds it (final
      // review 2026-10-31). `main` alone says nothing (`npm init` writes it for apps too).
      const scripts = Object.values(manifest.scripts ?? {}).join(' ');
      if ('vue' in peers || manifest.exports || manifest.module || /--target\s+lib\b/.test(scripts)
        || configs.some(isLibraryBuild)) return 'library';
      // An app is built (a bundler or dev server among its dependencies, or a bundler config).
      return BUILD_TOOLS.some(tool => tool in deps) || configs.length ? 'app' : 'library';
    }
    if (!configs.length) return null;
    return configs.some(isLibraryBuild) ? 'library' : 'app';
  }

  /** Whether code in scope `from` sees the registrations and routes of scope `of`. */
  private vueSees(from: string, of: string): boolean {
    return from === of || from.startsWith('library:') || of.startsWith('library:');
  }

  /** Whether vue-router is active for the file: for its repo, or for the sub-folder holding it (M3-07). */
  private vueRouterActive(repoName: string, path: string): boolean {
    const repo = this.config.repos.find(r => r.name === repoName);
    if (!repo) return false;
    const repoRoot = resolve(this.config.getWorkspaceRoot(), repo.path);
    const detectors = this.cachedActiveDetectors.get(repoRoot);
    // Not detected in this phase (a direct resolution call): no folder is ruled out.
    if (!detectors) return true;
    if (!detectors.some(d => d.name === 'vue-router')) return false;
    const scopes = this.frameworkScopes(repoRoot).get('vue-router');
    return !scopes || isInScopes(path, scopes);
  }

  /**
   * Unchanged `.vue` files of a repo whose template tags or navigations this scan's JS/TS edits
   * re-target (M3-08). Global registrations: a `.component('X', …)` added, removed or retargeted in
   * a new, changed or deleted file, a changed auto-registration glob, or a `.vue` file added to or
   * removed from a glob folder; then the files using `<X/>`. Route tables: a route record added,
   * removed or changed (name, path, component, redirect); then the files navigating to it. Their
   * references resolve through these tables, so, like the referrers of moved targets (M0-02-R4),
   * they are re-parsed; no other file is. Each file's facts are kept in `meta vue_registry:<repo>`;
   * `settleVueRegistry` stores the new record after the parse.
   */
  private vueRegistryReferrers(repoName: string, files: Array<{ path: string; content?: string }>, deleted: string[]): Set<string> {
    this.pendingVueRegistry.delete(repoName);
    const users = new Set<string>();
    const key = 'vue_registry:' + repoName;
    const stored = this.store.getMeta(key);
    let previous: Record<string, VueModuleFacts> = {};
    try { previous = JSON.parse(stored ?? '{}'); } catch { /* rebuilt below */ }
    const next = { ...previous };
    const listed = new Set(files.map(f => f.path));
    const record = (path: string, text: string | null | undefined) => {
      const regs = text && /\.component\s*\(/.test(text) ? globalRegistrations(text) : { named: [], globs: [] };
      // Lines are left out: moving a record in its file re-targets nothing.
      const routes = text && mayDefineRoutes(text) ? routeRecords(text).map(({ line: _line, ...r }) => r) : [];
      if (regs.named.length > 0 || regs.globs.length > 0 || routes.length > 0) next[path] = { ...regs, routes };
      else delete next[path];
    };
    for (const f of files) if (JS_TS_FILE.test(f.path)) record(f.path, f.content);
    for (const p of deleted) delete next[p];
    const scopeUsers = this.vueScopeMoves(repoName, files, deleted, previous, next);
    if (stored === null || stored === undefined) {
      // No record yet (a first scan, or an index from before M3-08): read the other JS/TS files
      // once and keep the result; there is nothing to compare with.
      for (const f of this.store.getAllFiles(repoName)) {
        const p = f.path as string;
        if (JS_TS_FILE.test(p) && !listed.has(p)) record(p, this.readWorkspaceText(p));
      }
      this.store.setMeta(key, JSON.stringify(next));
      return new Set([...users, ...scopeUsers]);
    }
    if (JSON.stringify(next) !== stored) this.pendingVueRegistry.set(repoName, next);

    const indexedVue = this.store.getAllFiles(repoName).map(f => f.path as string).filter(p => p.endsWith('.vue'));
    const addedVue = files.map(f => f.path).filter(p => p.endsWith('.vue') && !this.store.getFile(p));
    // A component registered or unregistered by a changed file gains or loses that app's
    // registrations when it lives in another scope (`vueImporterScopes`): re-parse it.
    const registration = (r: { name: string; specifier: string }) => `${r.name}\0${r.specifier}`;
    for (const path of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const was = new Set((previous[path]?.named ?? []).map(registration));
      const now = new Set((next[path]?.named ?? []).map(registration));
      for (const r of [...(previous[path]?.named ?? []), ...(next[path]?.named ?? [])]) {
        if (was.has(registration(r)) === now.has(registration(r))) continue;
        const file = this.resolveImportPath(r.specifier, path, this.workspaceFileMap);
        if (file?.endsWith('.vue') && !listed.has(file) && this.store.getFile(file)?.repo === repoName) users.add(file);
      }
    }
    const names = changedGlobalNames(previous, next, indexedVue, [...addedVue, ...deleted.filter(p => p.endsWith('.vue'))]);
    const routesOf = (facts: Record<string, VueModuleFacts>) =>
      Object.fromEntries(Object.entries(facts).map(([p, f]) => [p, f.routes ?? []]));
    const routes = changedRoutes(routesOf(previous), routesOf(next));
    if (names.size === 0 && routes.length === 0) return new Set([...users, ...scopeUsers]);
    // JS/TS modules navigate too (stores, guards, composables: M3-11); they are read only for routes.
    const modules = routes.length > 0 ? this.store.getAllFiles(repoName).map(f => f.path as string).filter(p => JS_TS_FILE.test(p)) : [];
    for (const p of [...indexedVue, ...modules]) {
      if (listed.has(p)) continue;
      const text = this.readWorkspaceText(p) ?? '';
      if ((p.endsWith('.vue') && usesTag(text, names)) || navigatesTo(p, text, routes)) users.add(p);
    }
    return new Set([...users, ...scopeUsers]);
  }

  /**
   * Files whose Vue scope moved since the last scan (M3-08-R1). Scopes are drawn by package.json
   * files, which no scan parses: a manifest added, removed or edited moves files between scopes.
   * The scope of every folder holding indexed JS/TS/Vue files is kept in `meta vue_dir_scopes:<repo>`
   * (no file is read for it). When one moved, its files are re-parsed, every file that navigates
   * (its route table may have changed: final review 2026-10-31), and the `.vue` files using a tag
   * registered by a moved file. Repos without Vue files or registrations record nothing.
   */
  private vueScopeMoves(
    repoName: string, files: Array<{ path: string }>, deleted: string[],
    previous: Record<string, VueModuleFacts>, next: Record<string, VueModuleFacts>, dryRun = false,
  ): Set<string> {
    // Manifests may have changed since the last phase (a long-lived scanner).
    this.vueScopes.clear();
    this.vueImporters.clear();
    this.importTextCache.clear();
    const key = 'vue_dir_scopes:' + repoName;
    const gone = new Set(deleted);
    const indexed = [...new Set([...this.store.getAllFiles(repoName).map(f => f.path as string), ...files.map(f => f.path)])]
      .filter(p => !gone.has(p) && (p.endsWith('.vue') || JS_TS_FILE.test(p)));
    if (!indexed.some(p => p.endsWith('.vue')) && Object.keys(next).length === 0) return new Set();
    const dirOfFile = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const scopes: Record<string, string> = {};
    for (const p of indexed) {
      const dir = dirOfFile(p);
      if (!(dir in scopes)) scopes[dir] = this.vueScope(repoName, p);
    }
    let before: Record<string, string> = {};
    try { before = JSON.parse(this.store.getMeta(key) ?? '{}'); } catch { /* recorded below */ }
    const movedDirs = new Set(Object.keys(scopes).filter(d => before[d] !== undefined && before[d] !== scopes[d]));
    const moved = indexed.filter(p => movedDirs.has(dirOfFile(p)));
    if (dryRun) return new Set(moved);
    this.store.setMeta(key, JSON.stringify(scopes));
    if (moved.length === 0) return new Set();
    const listed = new Set(files.map(f => f.path));
    const users = new Set(moved.filter(p => !listed.has(p)));
    const facts = moved.flatMap(p => [previous[p], next[p]]).filter((f): f is VueModuleFacts => !!f);
    // A moved glob registration names every component of its folder: re-parse every user.
    const anyGlob = facts.some(f => f.globs.length > 0);
    const names = new Set(facts.flatMap(f => f.named.map(n => n.name)));
    for (const p of indexed) {
      if (listed.has(p) || users.has(p)) continue;
      const text = this.readWorkspaceText(p) ?? '';
      // The parser's own pre-filter: guard redirects may name no router.push (M3-11-R1).
      if (mayNavigate(text) || (p.endsWith('.vue') && (anyGlob || usesTag(text, names)))) users.add(p);
    }
    return users;
  }

  /** Store the facts `vueRegistryReferrers` read, once the files it named are parsed (M3-08). */
  private settleVueRegistry(repoName: string): void {
    const next = this.pendingVueRegistry.get(repoName);
    if (!next) return;
    this.pendingVueRegistry.delete(repoName);
    this.store.setMeta('vue_registry:' + repoName, JSON.stringify(next));
  }

  /** A workspace file's text, cached for the resolution phase (null when it does not exist). */
  private readWorkspaceText(path: string): string | null {
    if (!this.importTextCache.has(path)) {
      const abs = resolve(this.config.getWorkspaceRoot(), path);
      this.importTextCache.set(path, existsSync(abs) ? readFileSync(abs, 'utf-8') : null);
    }
    return this.importTextCache.get(path)!;
  }

  /**
   * C# `class A : X` in a class's base list: implements when X resolves to an indexed interface,
   * extends when it resolves to an indexed class. Interfaces extend and structs implement whatever
   * the target, so their parser type stands, as does a target of another kind.
   */
  private csharpBaseEdgeType(ref: ExtractedReference, targetFile: string, symbols: any[]): ExtractedReference['referenceType'] {
    const owner = symbols
      .filter((s) => ['class', 'interface', 'struct'].includes(s.kind) && s.startLine <= ref.startLine && ref.startLine <= s.endLine)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
    if (owner?.kind !== 'class') return ref.referenceType;
    const name = ref.targetName.split('.').pop()!;
    const candidates = this.symbolIndex?.get(name)
      ?? this.store.getSymbolsForFile(targetFile).map((s: any) => ({ name: s.name, file: targetFile, kind: s.kind }));
    const kind = candidates.find((m) => m.file === targetFile && m.name === name && (m.kind === 'class' || m.kind === 'interface'))?.kind;
    return kind === 'interface' ? 'implements' : kind === 'class' ? 'extends' : ref.referenceType;
  }

  private resolveRequirePath(target: string, sourcePath: string, fileMap: Map<string, string>): string | null {
    if (!target || typeof target !== 'string') return null;
    const dir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
    const candidates = [
      target.startsWith('./') ? join(dir, target) : target,
      target.startsWith('./') ? join(dir, target + '.php') : target,
      target + '.php',
    ];

    for (const candidate of candidates) {
      const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
      if (fileMap.has(normalized)) return normalized;
    }
    return null;
  }

  // Per resolution phase (reset by buildSymbolIndex): the file set import resolvers index once
  // (M0-12-R3), go.mod texts, and each path's language.
  private importFiles: { map: Map<string, string>; files: Set<string> } | null = null;
  private importTextCache = new Map<string, string | null>();
  private languageCache = new Map<string, string | null>();
  // PHP file → the namespace it declares ('' for none), built with the symbol index (M0-04-R2).
  private phpNamespaces = new Map<string, string>();
  // Repo → its globally registered Vue components (M3-02).
  private vueGlobals = new Map<string, Map<string, string>>();
  /** Vuex store models by file, per resolution phase (M3-05). */
  private vuexFiles = new Map<string, VuexModuleInfo>();
  // Repo → its Vue Router route records (M3-06).
  private vueRoutes = new Map<string, ResolvedRoute[]>();
  /** Names declared by the workspace's package.json files, per resolution phase (M0-17-R4). */
  private npmWorkspaceNames: Set<string> | null = null;
  /** Folder listings for exact-case checks, per sync. */
  private listings = new Map<string, Set<string>>();
  /** The files each repo parsed in the current multi-repo run, in run order (M0-10-R4). */
  private parsedInRun: Map<string, string[]> | null = null;
  /** The Vue app folder of each file, per resolution phase (M3-08-R1). */
  private vueScopes = new Map<string, string>();
  /** Per repo, the other scopes whose registering files import each `.vue` file, per phase. */
  private vueImporters = new Map<string, Map<string, Set<string>>>();
  /** Per repo: the Vue registrations and route records to store once this scan's parse completes (M3-08). */
  private pendingVueRegistry = new Map<string, Record<string, VueModuleFacts>>();

  /** Language of an indexed path: its extension or file name, else what discovery stored (shebang scripts). */
  private languageOf(path: string): string | null {
    let lang = this.languageCache.get(path);
    if (lang === undefined) {
      lang = getLanguageForFile(path, this.config.getResolvedUserLanguages())?.name
        ?? ((this.store.getFile(path)?.language as string | undefined) || null);
      this.languageCache.set(path, lang);
    }
    return lang;
  }

  /**
   * Go `pkg.Type` embedded in a struct or interface: the type declared in the directory of the
   * imported package when the import resolves to a project package, else nothing (M0-17-R5).
   */
  private resolveGoQualifiedType(
    ref: ExtractedReference,
    resolver: ReturnType<typeof importResolverFor>,
    sourcePath: string,
    fileMap: Map<string, string>,
    referencedNames: () => Set<string>,
  ): { file: string; symbol: string }[] {
    const importPath = ref.metadata?.goPackage;
    if (!resolver || typeof importPath !== 'string') return [];
    const hit = this.resolveModuleImport(resolver, importPath, sourcePath, fileMap, referencedNames)[0];
    if (!hit) return [];
    const entries: { name: string; file: string; kind?: string }[] = this.symbolIndex?.get(ref.targetName.toLowerCase())
      ?? this.store.searchSymbols(ref.targetName).map((m: any) => ({ name: m.name, file: m.file_path, kind: m.kind }));
    const files = [...new Set(entries
      .filter(e => e.name === ref.targetName && TYPE_KINDS.has(e.kind ?? '') && dirname(e.file) === dirname(hit.file))
      .map(e => e.file))].sort();
    return files.length ? [{ file: files[0]!, symbol: ref.targetName }] : [];
  }

  /** Languages whose imports name modules, packages or namespaces (Java, Rust, Go, Python, Ruby, C#, PHP). */
  private resolveModuleImport(
    resolver: NonNullable<ReturnType<typeof importResolverFor>>,
    target: string,
    sourcePath: string,
    fileMap: Map<string, string>,
    referencedNames: () => Set<string>,
  ): ImportHit[] {
    // One Set per phase and file map, so the resolvers' index over it is built once.
    if (this.importFiles?.map !== fileMap) this.importFiles = { map: fileMap, files: new Set(fileMap.keys()) };
    const files = this.importFiles.files;
    // The symbol index holds every stored symbol plus this phase's parse results, so a namespace
    // declared in a file the scan does not re-parse is found too.
    const declaring = (name: string, kinds: Set<string>) => [...new Set(
      (this.symbolIndex?.get(name) ?? []).filter(e => e.name === name && kinds.has(e.kind ?? '')).map(e => e.file),
    )];
    return resolver(target, sourcePath, {
      files,
      readText: (path) => this.readWorkspaceText(path),
      namespaceFiles: (namespace) => declaring(namespace, NAMESPACE_KINDS),
      typeFiles: (name) => declaring(name, TYPE_KINDS),
      fileNamespace: (file) => this.phpNamespaces.get(file) ?? null,
      get referencedNames() { return referencedNames(); },
    });
  }

  private resolveImportPath(target: string, sourcePath: string, fileMap: Map<string, string>): string | null {
    if (!target || typeof target !== 'string') return null;

    let resolvedTarget = target;

    // ── Dart: skip stdlib (`dart:core`, `dart:async`, etc.) ─────────────────
    if (target.startsWith('dart:')) return null;

    // ── Dart: resolve package: URIs ──────────────────────────────────────────
    // `package:my_app/src/services/auth.dart` → try `lib/src/services/auth.dart`
    // First checks the pubspec-derived package map for monorepo support, then
    // falls back to stripping the package name and prepending `lib/`.
    if (target.startsWith('package:')) {
      const withoutScheme = target.slice('package:'.length);
      const slashIdx = withoutScheme.indexOf('/');
      if (slashIdx !== -1) {
        const pkgName = withoutScheme.slice(0, slashIdx);
        const pkgPath = withoutScheme.slice(slashIdx + 1);

        // 1. Try known package map (monorepo-aware)
        const pkgRoot = this.dartPackageMap.get(pkgName);
        if (pkgRoot) {
          const candidate = pkgRoot + pkgPath;
          if (fileMap.has(candidate)) return candidate;
        }

        // 2. Fallback: strip package name, prepend lib/ (same-project)
        const dartCandidate = 'lib/' + pkgPath;
        if (fileMap.has(dartCandidate)) return dartCandidate;
      }
      return null;
    }

    // ── Dart: relative imports always use explicit .dart extension ───────────
    // Fast-path that avoids trying JS/TS/Vue extension candidates for Dart files.
    // In Dart, all non-scheme imports (including bare paths like 'user.g.dart'
    // from part directives) are relative to the source file's directory.
    if (sourcePath.endsWith('.dart')) {
      const dir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
      resolvedTarget = dir ? join(dir, target) : target;
      const normalized = resolvedTarget.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
      if (fileMap.has(normalized)) return normalized;
      return null;
    }

    // JS/TS/Vue/Svelte: aliases from the nearest tsconfig/jsconfig `paths` or bundler config, then
    // `@/` → src/ (M3-09); then the specifier itself, relative to the importing file when it is `./…`.
    const dir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
    const bases = !target.startsWith('.') && JS_MODULE_SOURCE.test(sourcePath)
      ? jsAliasTargets(target, sourcePath, this.aliasContext(fileMap))
      : [];
    bases.push(target.startsWith('.') ? join(dir, target) : target);
    for (const base of bases) {
      const hit = this.probeModule(base, fileMap);
      if (hit) return hit;
    }
    return null;
  }

  /** The indexed file a JS-style module path names: itself, its .ts twin, an index file or an extension. */
  private probeModule(resolvedTarget: string, fileMap: Map<string, string>): string | null {
    const normalizedTarget = resolvedTarget.replace(/\\/g, '/').replace(/^\.\//,  '').replace(/^\//, '');

    // When a .ts file imports with an explicit .js extension (TypeScript "use .js for .ts"
    // convention), we must also try the .ts/.tsx source equivalents.
    const jsToTsCandidates: string[] = [];
    if (normalizedTarget.endsWith('.js')) {
      const base = normalizedTarget.slice(0, -3);
      jsToTsCandidates.push(base + '.ts', base + '.tsx');
    } else if (normalizedTarget.endsWith('.jsx')) {
      const base = normalizedTarget.slice(0, -4);
      jsToTsCandidates.push(base + '.tsx', base + '.ts');
    }

    const candidates = [
      normalizedTarget,
      ...jsToTsCandidates,
      normalizedTarget + '/index.js',
      normalizedTarget + '/index.ts',
      normalizedTarget + '/index.tsx',
      normalizedTarget + '/index.jsx',
      normalizedTarget + '/index.vue',
      normalizedTarget + '.js',
      normalizedTarget + '.ts',
      normalizedTarget + '.tsx',
      normalizedTarget + '.jsx',
      normalizedTarget + '.vue',
    ];

    for (const candidate of candidates) {
      if (fileMap.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /** What `jsAliasTargets` reads: this phase's file set and the workspace's config files (M3-09). */
  private aliasContext(fileMap: Map<string, string>): AliasContext {
    if (this.importFiles?.map !== fileMap) this.importFiles = { map: fileMap, files: new Set(fileMap.keys()) };
    return { files: this.importFiles.files, readText: (path) => this.readWorkspaceText(path) };
  }

  /**
   * Discovers Dart packages by walking the workspace for pubspec.yaml files
   * and extracting the `name:` field. Populates `dartPackageMap` with
   * `packageName → relative/path/to/lib/` mappings.
   */
  private discoverDartPackages(workspaceRoot: string): void {
    this.dartPackageMap.clear();
    const allFiles = this.store.getFilesByPattern ? this.store.getFilesByPattern('pubspec.yaml') : this.store.getAllFiles();
    for (const f of allFiles) {
      const filePath = f.path as string;
      if (!filePath.endsWith('pubspec.yaml')) continue;

      try {
        const absPath = resolve(workspaceRoot, filePath);
        const content = readFileSync(absPath, 'utf-8');
        // Extract the `name:` field from pubspec.yaml (simple regex, no YAML lib)
        const nameMatch = content.match(/^name:\s*([^\s#]+)/m);
        if (nameMatch) {
          const pkgName = nameMatch[1];
          // The lib/ directory is relative to the pubspec.yaml directory
          const pkgDir = filePath.includes('/')
            ? filePath.substring(0, filePath.lastIndexOf('/') + 1)
            : '';
          this.dartPackageMap.set(pkgName, pkgDir + 'lib/');
        }
      } catch {
        // Skip unreadable pubspec files
      }
    }
  }

  /**
   * A PHP function call: the first candidate FQN (`App\fmt`, then the global `fmt`) that a PHP file
   * declaring that namespace declares as a function, preferring the calling file, then the
   * declaration nearest it (two apps in one repo, review 2026-10-31). Never a method, class or
   * constant; built-ins are declared nowhere, so they resolve to nothing. The edge names the
   * matched candidate (M0-04-R5).
   */
  private resolvePhpFunction(candidates: string[], sourcePath: string): { file: string; symbol: string }[] {
    for (const fqn of candidates) {
      const parts = fqn.split('\\');
      const name = parts.pop()!.toLowerCase();
      const namespace = parts.join('\\').toLowerCase();
      const files = (this.symbolIndex?.get(name) ?? [])
        .filter(e => e.kind === 'function' && e.name.toLowerCase() === name
          && this.phpNamespaces.has(e.file) && this.phpNamespaces.get(e.file)!.toLowerCase() === namespace)
        .map(e => e.file)
        .sort();
      if (files.length) return [{ file: files.includes(sourcePath) ? sourcePath : closest(files, sourcePath), symbol: fqn }];
    }
    return [];
  }

  private resolveSymbolToFile(symbolName: string, fileMap: Map<string, string>, sourcePath?: string, callableOnly = false): string | null {
    if (!symbolName || typeof symbolName !== 'string') return null;

    const sourceLang = sourcePath ? this.languageOf(sourcePath) : null;

    // Fail closed: without a known source language there is no safe way to pick a candidate
    // across languages, so name-only resolution returns nothing (M2-01).
    const filterMatches = (matches: any[]): any[] => {
      if (!sourceLang) return [];
      return matches.filter(m => {
        const targetPath = (m.file_path || m.file) as string;
        const targetLang = this.languageOf(targetPath) ?? '';
        // `config()` on a parameter must not link to a JS/TS/Python `const config` or module
        // variable (M0-17-R2). Other languages keep their constants as targets: C function-like
        // macros, Rust tuple variants, Lua function values and Bash aliases are callable.
        if (callableOnly && (m.kind === 'constant' || m.kind === 'variable') && VALUE_SYMBOL_LANGUAGES.has(targetLang)) return false;
        return areLanguagesCompatible(sourceLang!, targetLang);
      });
    };

    // Declarations named `name` under their language's case rules: `Cart` is not `cart` (M3-10).
    const named = (name: string, matches: any[]): any[] => matches.filter(m => m.name === name
      || (foldsCase(this.languageOf((m.file_path || m.file) as string), m.kind) && m.name.toLowerCase() === name.toLowerCase()));

    // Use pre-built symbol index for O(1) lookup when available
    if (this.symbolIndex) {
      // The name-only part is computed once per name, source language and callableOnly in a
      // resolution phase; a call then pays only for its own file (M4-03).
      if (this.nameCandidatesFor !== this.symbolIndex) {
        this.nameCandidates.clear();
        this.nameCandidatesFor = this.symbolIndex;
      }
      const cacheKey = `${symbolName}\0${sourceLang}\0${callableOnly ? 1 : 0}`;
      let found = this.nameCandidates.get(cacheKey);
      if (found === undefined) {
        found = null;
        // The lowercased key holds every case variant of a name.
        const lookup = (name: string) => named(name, this.symbolIndex!.get(name.toLowerCase()) ?? []);
        let key = symbolName;
        let indexed = lookup(key);
        if (!indexed.length) {
          if (symbolName.includes('\\')) {
            const parts = symbolName.split('\\');
            key = parts[parts.length - 1];
            indexed = lookup(key);
          } else if (symbolName.includes('.')) {
            const parts = symbolName.split('.');
            const last = parts[parts.length - 1];
            if (!COMMON_EXTENSIONS.has(last.toLowerCase())) {
              key = last;
              indexed = lookup(key);
            }
          }
        }
        const compatible = indexed.length > 0 ? filterMatches(indexed) : [];
        if (compatible.length > 0) {
          // An exact-case declaration first, else a PHP or Pascal one in another case. Of several
          // files, the one nearest the caller, then by path: never the index order, which differs
          // between a fresh scan and a sync that re-parsed some files (M0-02-R7).
          const exact = compatible.filter(m => m.name === key);
          found = {
            compatible,
            sameFile: new Set(exact.map(m => m.file as string)),
            files: [...new Set((exact.length ? exact : compatible).map(m => m.file as string))].sort(),
          };
        }
        this.nameCandidates.set(cacheKey, found);
      }
      if (!found) return null; // O(1) short-circuit: if not in symbolIndex, it's a third-party/external symbol not in this workspace.
      // A namespaced name (App\Models\Role) is the class declared in that namespace or nothing:
      // never another namespace's Role, nor an app file for an Illuminate\… name (M0-04-R1, M0-04-R2).
      // Of several (two apps in one repo), the one nearest the caller (review 2026-10-31). Computed
      // per call from the memoised candidates.
      if (sourceLang === 'php' && symbolName.includes('\\')) {
        const shortName = symbolName.split('\\').pop()!;
        const namespace = symbolName.replace(/^\\/, '').split('\\').slice(0, -1).join('\\').toLowerCase();
        const declared = [...new Set(found.compatible.filter(m => m.name.toLowerCase() === shortName.toLowerCase()
          && (TYPE_KINDS.has(m.kind ?? '') || m.kind === 'function')
          && this.phpNamespaces.get(m.file)?.toLowerCase() === namespace).map(m => m.file as string))].sort();
        if (!declared.length) return null;
        return declared.includes(sourcePath ?? '') ? sourcePath! : closest(declared, sourcePath ?? '');
      }
      if (sourcePath && found.sameFile.has(sourcePath)) return sourcePath;
      if (found.files.length <= 16) return closest(found.files, sourcePath ?? '');
      return (found.nearest ??= nearestIndex(found.files))(sourcePath ?? '');
    }

    // The store's search is a case-insensitive substring match: keep only declarations of the name.
    let matches = named(symbolName, filterMatches(this.store.searchSymbols(symbolName)));
    if (matches.length > 0) {
      // Prefer a definition in the same file as the caller to avoid false cross-file edges
      if (sourcePath) {
        const sameFileMatch = matches.find(m => m.file_path === sourcePath && m.name === symbolName);
        if (sameFileMatch) return sameFileMatch.file_path as string;
      }
      const exactMatch = matches.find(m => m.name === symbolName);
      if (exactMatch) return exactMatch.file_path as string;
    }

    if (symbolName.includes('\\')) {
      const parts = symbolName.split('\\');
      const shortName = parts[parts.length - 1];
      matches = named(shortName, filterMatches(this.store.searchSymbols(shortName)));
      if (matches.length > 0) {
        if (sourcePath) {
          const sameFileMatch = matches.find(m => m.file_path === sourcePath && m.name === shortName);
          if (sameFileMatch) return sameFileMatch.file_path as string;
        }
        const exactMatch = matches.find(m => m.name === shortName);
        if (exactMatch) return exactMatch.file_path as string;
        return matches[0].file_path as string;
      }
    } else if (symbolName.includes('.')) {
      const parts = symbolName.split('.');
      const last = parts[parts.length - 1];
      if (!COMMON_EXTENSIONS.has(last.toLowerCase())) {
        const shortName = last;
        matches = named(shortName, filterMatches(this.store.searchSymbols(shortName)));
        if (matches.length > 0) {
          if (sourcePath) {
            const sameFileMatch = matches.find(m => m.file_path === sourcePath && m.name === shortName);
            if (sameFileMatch) return sameFileMatch.file_path as string;
          }
          const exactMatch = matches.find(m => m.name === shortName);
          if (exactMatch) return exactMatch.file_path as string;
          return matches[0].file_path as string;
        }
      }
    } else if (matches.length > 0) {
      // A PHP or Pascal declaration in another case: prefer the same file
      if (sourcePath) {
        const sameFile = matches.find(m => m.file_path === sourcePath);
        if (sameFile) return sameFile.file_path as string;
      }
      return matches[0].file_path as string;
    }
    return null;
  }
  /**
   * Prune a directory when the pattern names it (`**\/generated`, `packages/*\/generated`,
   * `app/Http/**`, an exact path or a bare directory name). A pattern ending in a bare `/*`
   * means the files directly in that directory: `app/Http/*` does not prune
   * app/Http/Controllers (M0-02-R1). Never match against a synthetic file name: `**\/_*`
   * must not prune every directory (review 2026-10-31).
   */
  private shouldExcludeDir(relDir: string, excludes: string[]): boolean {
    return isExcludedDir(relDir, excludes);
  }

  /**
   * Config + CLI excludes, plus Laravel's defaults for `framework: laravel` repos (F10):
   * `laravelDefaultExcludes` false declines them, a list keeps only the defaults it names (M0-02-R2).
   */
  private effectiveExcludes(repoName: string): string[] {
    return effectiveExcludesFor(this.config.settings, this.config.repos.find(r => r.name === repoName), this.cliExcludes);
  }

  /** The other repos whose files reference resolution sees for `repoName` in this scan (M0-10-R3). */
  private visibleRepos(repoName: string): string[] {
    const repos = this.workspaceFileMap.size > 0
      ? new Set(this.workspaceFileMap.values())
      : new Set(this.store.getAllFiles().map(f => f.repo as string));
    repos.delete(repoName);
    return [...repos].sort();
  }

  /**
   * True when a repo is visible now that was not when `repoName` was last parsed, as recorded in
   * `meta resolution_repos:<repo>`. Without a record (indexed before M0-10-R3), any other repo
   * counts once, provided the repo already has indexed files.
   */
  private newlyVisibleRepos(repoName: string, indexed: boolean): boolean {
    if (!indexed) return false;
    const visible = this.visibleRepos(repoName);
    const recorded = this.store.getMeta('resolution_repos:' + repoName);
    if (recorded === null || recorded === undefined) return visible.length > 0;
    try {
      const before = new Set(JSON.parse(recorded) as string[]);
      return visible.some(r => !before.has(r));
    } catch {
      return visible.length > 0;
    }
  }

  /**
   * The other repos whose symbols are in the store now, as `meta resolution_repos:<repo>` records them
   * when a repo is resolved: a repo whose files were only discovered had nothing to resolve against,
   * so it must count as newly visible once it is indexed (M0-10-R4).
   */
  private indexedRepos(repoName: string): string[] {
    return this.store.getRepoNames().filter(r => r !== repoName);
  }

  /**
   * This repo's files among `referrers`. Another repo's files are queued in `meta
   * pending_referrers:<repo>`, for that repo's next scan or sync, or the second pass of a
   * multi-repo run, to re-parse (M0-10-R4).
   */
  private ownReferrers(repoName: string, referrers: Iterable<string>): Set<string> {
    const own = new Set<string>();
    const queued = new Map<string, Set<string>>();
    for (const r of referrers) {
      const owner = this.store.getFile(r)?.repo as string | undefined;
      if (!owner || owner === repoName) own.add(r);
      else queued.set(owner, (queued.get(owner) ?? new Set()).add(r));
    }
    for (const [owner, paths] of queued) this.queueReferrers(owner, paths);
    return own;
  }

  private queueReferrers(repoName: string, paths: Iterable<string>): void {
    const key = 'pending_referrers:' + repoName;
    const before = JSON.parse(this.store.getMeta(key) ?? '[]') as string[];
    this.store.setMeta(key, JSON.stringify([...new Set([...before, ...paths])].sort()));
  }

  /** Records the files a repo parsed, while a multi-repo run is in progress. */
  private noteParsed(repoName: string, paths: string[]): void {
    if (this.parsedInRun && paths.length) this.parsedInRun.set(repoName, [...(this.parsedInRun.get(repoName) ?? []), ...paths]);
  }

  /**
   * The files a repo parsed before a later repo of the run parsed some of its own were resolved
   * against that repo's symbols from before the run: they are queued for the second pass, as one
   * repo's changed files are resolved together (M0-10-R4).
   */
  private queueEarlyParsed(reposInRun: string[]): void {
    const order = reposInRun.filter(r => this.parsedInRun?.has(r));
    order.forEach((repoName, i) => {
      if (i < order.length - 1) this.queueReferrers(repoName, this.parsedInRun!.get(repoName)!);
    });
    this.parsedInRun = null;
  }

  /** The files another repo's scan queued for this repo to re-parse; the queue is emptied. */
  private takePendingReferrers(repoName: string): string[] {
    const key = 'pending_referrers:' + repoName;
    const pending = this.store.getMeta(key);
    if (pending === null) return [];
    this.store.setMeta(key, '[]');
    try {
      return JSON.parse(pending) as string[];
    } catch {
      return [];
    }
  }

  /**
   * After every repo of a multi-repo run: a repo resolved before another one of the run was indexed,
   * or whose files another repo's changes queued, is processed once more, so the result does not
   * depend on the order of the repos (M0-10-R4).
   */
  private needsSecondPass(repoName: string): boolean {
    const pending = this.store.getMeta('pending_referrers:' + repoName);
    return this.newlyVisibleRepos(repoName, this.store.getRepoNames().includes(repoName)) || (!!pending && pending !== '[]');
  }

  /** The effective filters of a repo, as recorded in `meta scan_filters:<repo>` (M0-02-R1). */
  private filterSignature(repoName: string): string {
    const includes = [...this.config.settings.includePatterns, ...this.cliIncludes].map(normalizePattern);
    return JSON.stringify({ excludes: this.effectiveExcludes(repoName), includes });
  }

  private removedFiles(repoName: string): Record<string, string[]> {
    return this.metaRecord('removed_files:' + repoName);
  }

  /** The names the referrers of each removed file resolved into it (M0-02-R4). */
  private removedNames(repoName: string): Record<string, string[]> {
    return this.metaRecord('removed_names:' + repoName);
  }

  private metaRecord(key: string): Record<string, string[]> {
    try {
      return JSON.parse(this.store.getMeta(key) ?? '{}');
    } catch {
      return {};
    }
  }

  /**
   * Drop files from the index and remember which files had edges into them, so those edges come
   * back when a file does (a restored file, a branch switch) although its referrers did not change
   * (M0-02-R2). The names they referenced are kept too, for when the target moves to another file
   * (M0-02-R4). Call inside a transaction.
   */
  private removeFiles(repoName: string, paths: string[]): void {
    const removed = this.removedFiles(repoName);
    const names = this.removedNames(repoName);
    let changed = false;
    for (const p of paths) {
      // References parsed later in this scan must not resolve to a removed file (M0-02-R3).
      this.workspaceFileMap.delete(p);
      if (!this.store.getFile(p)) continue;
      removed[p] = [...new Set([...(removed[p] ?? []), ...this.store.getReferrers(p)])];
      // The trailing identifier of each target symbol: `App\Services\UserService` is declared as
      // `UserService` wherever the class moves.
      const referenced = this.store.getReverseEdges(p)
        .filter(e => e.source_file !== p && typeof e.target_symbol === 'string')
        .map(e => /[A-Za-z_$][\w$]*$/.exec(e.target_symbol as string)?.[0])
        .filter((n): n is string => !!n);
      if (referenced.length > 0) names[p] = [...new Set([...(names[p] ?? []), ...referenced])];
      changed = true;
      this.store.deleteFile(p);
    }
    if (changed) {
      this.store.setMeta('removed_files:' + repoName, JSON.stringify(removed));
      this.store.setMeta('removed_names:' + repoName, JSON.stringify(names));
    }
  }

  /** The recorded referrers of removed files that are indexed again; their entries are consumed. */
  private takeReferrers(repoName: string, paths: string[]): Set<string> {
    const removed = this.removedFiles(repoName);
    const names = this.removedNames(repoName);
    const referrers = new Set<string>();
    let changed = false;
    for (const p of paths) {
      if (!removed[p] && !names[p]) continue;
      for (const r of removed[p] ?? []) referrers.add(r);
      delete removed[p];
      delete names[p];
      changed = true;
    }
    if (changed) {
      this.store.setMeta('removed_files:' + repoName, JSON.stringify(removed));
      this.store.setMeta('removed_names:' + repoName, JSON.stringify(names));
    }
    for (const p of paths) referrers.delete(p);
    return referrers;
  }

  /**
   * The recorded referrers of removed files whose referenced names appear in a new or changed file:
   * the target may have moved there, and unchanged referrers would otherwise keep the reference
   * unresolved until a forced scan (M0-02-R4). Only the text is checked here, so a file that merely
   * mentions a name costs a re-parse of those referrers; `settleMovedNames` drops a name once a
   * parsed file declares it.
   */
  private movedReferrers(repoName: string, files: Array<{ path: string; content?: string }>): Set<string> {
    const referrers = new Set<string>();
    const paths = new Set(files.map(f => f.path));
    const pending = Object.entries(this.removedNames(repoName)).filter(([p]) => !paths.has(p));
    if (pending.length === 0 || files.length === 0) return referrers;
    const escape = (n: string) => n.replace(/[$]/g, '\\$');
    const all = [...new Set(pending.flatMap(([, n]) => n))];
    const pattern = new RegExp(`(?<![\\w$])(?:${all.map(escape).join('|')})(?![\\w$])`, 'g');
    const mentioned = new Set<string>();
    for (const f of files) {
      for (const m of (f.content ?? '').matchAll(pattern)) mentioned.add(m[0]);
      if (mentioned.size === all.length) break;
    }
    if (mentioned.size === 0) return referrers;
    const removed = this.removedFiles(repoName);
    for (const [p, n] of pending) {
      if (n.some(name => mentioned.has(name))) for (const r of removed[p] ?? []) referrers.add(r);
    }
    for (const p of paths) referrers.delete(p);
    return referrers;
  }

  /**
   * JS/TS/Vue/Python files below a folder whose resolution configs changed since the last scan: a
   * package.json (npm packages, app roots: M0-17-R4, M3-09-R1), tsconfig/jsconfig (with the configs
   * their relative `extends` / `references` reach) or bundler config added, removed or edited, or an
   * `__init__.py` added or removed (Python import roots, M0-12-R9). Folders up to the workspace root
   * count, as alias lookup walks that far. No scan parses those files, so the files they govern are re-parsed,
   * as `scan --force` would resolve them (M0-02-R8). Likewise Go files below a changed go.mod (the
   * module path) and PHP files below a changed composer.json (PSR-4 roots) (M0-02-R9). Signatures
   * live in `meta js_configs:<repo>`: folder keys for JS/TS/Python, NUL-prefixed `go:`/`php:` folder
   * keys for the others, and `#families`, the families the record holds.
   */
  private configReferrers(repoName: string, deleted: string[] = [], dryRun = false): Set<string> {
    const key = 'js_configs:' + repoName;
    const gone = new Set(deleted);
    const indexed = this.store.getAllFiles(repoName).map(f => f.path as string).filter(p => !gone.has(p));
    const sources = indexed.filter(p => JS_TS_FILE.test(p) || /\.(vue|svelte|py)$/.test(p));
    const families = MANIFEST_FAMILIES.map(f => ({ ...f, sources: indexed.filter(p => f.source.test(p)) }));
    if (sources.length === 0 && families.every(f => f.sources.length === 0)) return new Set();
    const workspaceRoot = this.config.getWorkspaceRoot();
    // Every folder above a source, up to the workspace root: alias lookup walks that far (review).
    const dirs = new Set<string>(['']);
    for (const p of sources) {
      for (let dir = p; dir.includes('/');) {
        dir = dir.slice(0, dir.lastIndexOf('/'));
        if (dirs.has(dir)) break;
        dirs.add(dir);
      }
    }
    const names = ['package.json', ...BUNDLER_CONFIGS];
    // A tsconfig/jsconfig and every config its relative `extends` / `references` reach, recursively
    // (`.svelte-kit/tsconfig.json`, `tsconfig.app.json`, `tsconfig.base.json`): a missing one counts.
    const tsConfigTree = (file: string, hash: ReturnType<typeof createHash>, seen: Set<string>) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf-8') : null;
      hash.update(file).update('\0').update(text ?? '<missing>');
      if (text === null) return;
      const targets = [...text.matchAll(/"(?:extends|path)"\s*:\s*("[^"]*"|\[[^\]]*\])/g)].flatMap(m => [...m[1]!.matchAll(/"([^"]+)"/g)].map(x => x[1]!));
      for (const target of targets) {
        if (!target.startsWith('.')) continue;
        let next = resolve(dirname(file), target);
        if (existsSync(next) && statSync(next).isDirectory()) next = join(next, 'tsconfig.json');
        else if (!next.endsWith('.json')) next += '.json';
        tsConfigTree(next, hash, seen);
      }
    };
    const signatures: Record<string, string> = {};
    for (const dir of dirs) {
      const hash = createHash('md5');
      let any = false;
      for (const name of names) {
        const abs = resolve(workspaceRoot, dir, name);
        if (!existsSync(abs)) continue;
        any = true;
        hash.update(name).update('\0').update(readFileSync(abs));
      }
      let entries: string[] = [];
      try { entries = readdirSync(resolve(workspaceRoot, dir)); } catch { /* gone */ }
      const seen = new Set<string>();
      for (const name of entries.filter(n => /^(?:ts|js)config(?:\.[\w-]+)?\.json$/.test(n)).sort()) {
        any = true;
        tsConfigTree(resolve(workspaceRoot, dir, name), hash, seen);
      }
      // Python: whether the folder is a package decides its import roots, not the file's content (M0-12-R9).
      if (existsSync(resolve(workspaceRoot, dir, '__init__.py'))) {
        any = true;
        hash.update('__init__.py');
      }
      if (any) signatures[dir] = hash.digest('hex');
    }
    // go.mod / composer.json in every folder above a Go / PHP file (M0-02-R9).
    for (const family of families) {
      const above = new Set<string>(['']);
      for (const p of family.sources) {
        for (let dir = p; dir.includes('/');) {
          dir = dir.slice(0, dir.lastIndexOf('/'));
          if (above.has(dir)) break;
          above.add(dir);
        }
      }
      for (const dir of above) {
        const abs = resolve(workspaceRoot, dir, family.manifest);
        let manifest: Buffer | null = null;
        try {
          manifest = statSync(abs).isFile() ? readFileSync(abs) : null;
        } catch { /* none here */ }
        if (manifest) signatures[family.prefix + dir] = createHash('md5').update(manifest).digest('hex');
      }
    }
    signatures['#families'] = MANIFEST_FAMILIES.map(f => f.prefix).join(',');
    let before: Record<string, string> | null = null;
    try { before = JSON.parse(this.store.getMeta(key) ?? 'null'); } catch { /* recorded below */ }
    if (!dryRun) this.store.setMeta(key, JSON.stringify(signatures));
    // No record yet: nothing to compare with.
    if (!before) return new Set();
    // A family the record does not hold yet (an index from before it) is only recorded: nothing to compare.
    const recorded = new Set((before['#families'] ?? '').split(','));
    const changed = [...new Set([...Object.keys(before), ...Object.keys(signatures)])]
      .filter(k => k !== '#families' && before![k] !== signatures[k]
        && (!isFamilyKey(k) || MANIFEST_FAMILIES.some(f => k.startsWith(f.prefix) && recorded.has(f.prefix))));
    if (changed.length === 0) return new Set();
    const under = (p: string, dir: string) => dir === '' || p.startsWith(`${dir}/`);
    const referrers = new Set(sources.filter(p => changed.some(dir => !isFamilyKey(dir) && under(p, dir))));
    for (const family of families) {
      const dirs = changed.filter(k => k.startsWith(family.prefix)).map(k => k.slice(family.prefix.length));
      for (const p of family.sources) if (dirs.some(dir => under(p, dir))) referrers.add(p);
    }
    return referrers;
  }

  /**
   * Unchanged files with edges to a symbol that a changed file no longer declares (renamed or
   * removed): they are re-parsed, so their references resolve as `scan --force` resolves them
   * (M0-02-R8). A name is gone when the new text no longer holds it as a word; a file's own
   * component symbol (`.vue`, `.svelte`) is named after the file and never counts. The referrers
   * are kept under the name in `meta vanished_names:<repo>`, so they are re-parsed again when a
   * changed file names it once more (a rename undone, a branch switched back).
   */
  private removedSymbolReferrers(repoName: string, files: Array<{ path: string; content?: string }>): Set<string> {
    const referrers = new Set<string>();
    const vanished = this.metaRecord('vanished_names:' + repoName);
    let changed = false;
    for (const f of files) {
      if (f.content === undefined) continue;
      const component = /\.(vue|svelte)$/.test(f.path) ? vueComponentName(f.path) : null;
      const names = [...new Set(this.store.getSymbolsForFile(f.path).map(sym => sym.name as string))].filter(n => n !== component);
      // Judged on the code: a name left only in a comment or a string is gone (M0-17-R6).
      const code = codeOnly(f.path, f.content);
      const gone = new Set(names.filter(n => !wordIn(code, n)));
      if (gone.size === 0) continue;
      for (const e of this.store.getReverseEdges(f.path)) {
        if (e.source_file === f.path || typeof e.target_symbol !== 'string') continue;
        const tail = /[A-Za-z_$][\w$]*$/.exec(e.target_symbol)?.[0];
        if (!tail || !gone.has(tail)) continue;
        referrers.add(e.source_file as string);
        // Own keys only: `toString` must not read Object.prototype's (review 2026-11-01).
        vanished[tail] = [...new Set([...(Object.hasOwn(vanished, tail) ? vanished[tail]! : []), e.source_file as string])];
        changed = true;
      }
    }
    if (changed) this.store.setMeta('vanished_names:' + repoName, JSON.stringify(vanished));
    return referrers;
  }

  /** The recorded referrers of vanished names that a new or changed file names again (M0-02-R8). */
  private vanishedNameReferrers(repoName: string, files: Array<{ path: string; content?: string }>): Set<string> {
    const referrers = new Set<string>();
    const vanished = this.metaRecord('vanished_names:' + repoName);
    // Referrers since deleted leave the record; a name left without referrers goes with them.
    let pruned = false;
    for (const name of Object.keys(vanished)) {
      const alive = vanished[name]!.filter(r => this.store.getFile(r));
      if (alive.length === vanished[name]!.length) continue;
      pruned = true;
      if (alive.length) vanished[name] = alive;
      else delete vanished[name];
    }
    if (pruned) this.store.setMeta('vanished_names:' + repoName, JSON.stringify(vanished));
    const names = Object.keys(vanished);
    if (names.length === 0) return referrers;
    for (const f of files) {
      if (f.content === undefined) continue;
      for (const name of names) if (wordIn(f.content, name)) for (const r of vanished[name]!) referrers.add(r);
    }
    for (const f of files) referrers.delete(f.path);
    return referrers;
  }

  /** Drop the vanished names a new or changed file parsed in this scan declares again (M0-02-R8). */
  private settleVanishedNames(repoName: string, results: Array<ParseResult | undefined>): void {
    const vanished = this.metaRecord('vanished_names:' + repoName);
    if (Object.keys(vanished).length === 0) return;
    let changed = false;
    for (const sym of results.flatMap(r => r?.symbols ?? [])) {
      if (Object.hasOwn(vanished, sym.name)) {
        delete vanished[sym.name];
        changed = true;
      }
    }
    if (changed) this.store.setMeta('vanished_names:' + repoName, JSON.stringify(vanished));
  }

  /**
   * Drop each recorded name of a removed file once a new or changed file parsed in this scan
   * declares it, whose text `movedReferrers` saw, so those referrers were re-parsed (M0-02-R4). The
   * other names stay: an unrelated `find()` must not end the wait for `UserService` (M0-02-R7).
   */
  private settleMovedNames(repoName: string, results: Array<ParseResult | undefined>): void {
    const names = this.removedNames(repoName);
    if (Object.keys(names).length === 0) return;
    const declared = new Set(results.flatMap(r => (r?.symbols ?? []).map(s => s.name)));
    let changed = false;
    for (const [p, n] of Object.entries(names)) {
      const pending = n.filter(name => !declared.has(name));
      if (pending.length === n.length) continue;
      if (pending.length > 0) names[p] = pending;
      else delete names[p];
      changed = true;
    }
    if (changed) this.store.setMeta('removed_names:' + repoName, JSON.stringify(names));
  }

  private async getFileInfo(absolutePath: string, relativePath: string): Promise<FileInfo | null> {
    // Same rule as the full-scan walk: extensionless files fall back to their shebang.
    const langDef = getLanguageForFile(absolutePath, this.config.getResolvedUserLanguages())
      ?? (basename(absolutePath).includes('.') ? null : shebangLanguage(absolutePath));
    if (!langDef) return null;

    try {
      const stats = await stat(absolutePath);
      const content = await readFile(absolutePath, 'utf-8');

      return {
        absolutePath,
        language: langDef.name,
        sizeBytes: stats.size,
        lines: content.split('\n').length,
      };
    } catch {
      return null;
    }
  }

  private async scanFrameworkRoutesAndHooks(repo: RepoConfig, repoRoot: string): Promise<void> {
    const workspaceRoot = this.config.getWorkspaceRoot();
    const files = await this.store.getAllFiles(repo.name);
    const filePaths = files.map(f => f.path as string);

    const frameworksPath = join(workspaceRoot, '.mapx', 'frameworks.json');
    // frameworks.json is also an explicit override: frameworks listed there stay active even
    // when detection misses them, and detection only ever adds to the list.
    let listed: string[] = [];
    if (existsSync(frameworksPath)) {
      try {
        const parsed = JSON.parse(readFileSync(frameworksPath, 'utf-8'));
        if (Array.isArray(parsed)) listed = parsed.filter((n): n is string => typeof n === 'string');
      } catch {}
    }
    const detected = await this.getActiveDetectors(repoRoot, filePaths);
    const missing = listed.filter(name => !detected.some(d => d.name === name));
    const activeDetectors = missing.length
      ? [...detected, ...FrameworkRegistry.getInstance().getDetectors().filter(d => missing.includes(d.name))]
      : detected;
    if (activeDetectors.length === 0) return;

    // Save active frameworks
    const activeNames = [...new Set([...listed, ...activeDetectors.map(d => d.name)])];
    await writeFile(frameworksPath, JSON.stringify(activeNames, null, 2), 'utf-8');

    // Clear all existing framework edges for this repo in the DB and Graph
    this.store.deleteFrameworkEdgesForRepo(repo.name);
    this.graph.dropFrameworkEdgesForRepo(repo.name);

    const routeRegistry = new RouteRegistry();
    await routeRegistry.load(workspaceRoot);
    routeRegistry.clearRepo(repo.name, new Set(filePaths));

    // Context for symbol resolution
    const ctx: ScanContext = {
      workspaceRoot,
      repoName: repo.name,
      // Without a source path, name resolution fails closed (M2-01); route middleware classes pass
      // the route file, which this used to drop, so they never resolved (M0-04-R3).
      resolveSymbolToFile: (symName: string, sourcePath?: string) => {
        return this.resolveSymbolToFile(symName, this.workspaceFileMap, sourcePath);
      }
    };

    const edgesToInsert: any[] = [];
    // Middleware names (Kernel aliases such as `auth`, or class names) → the class that handles
    // them, from the middleware hooks; route middlewares are resolved through it (M0-05-R2).
    // Keyed by the app root a hook declares (`metadata.appRoot`, a Laravel Kernel's app) and name: a
    // route uses only its own app's entries, so one app's aliases never link another's routes (M0-04-R6).
    const middlewareTargets = new Map<string, { file: string; symbol: string | null }>();
    const middlewareKey = (appRoot: unknown, name: string) => `${typeof appRoot === 'string' ? appRoot : '\0'}\0${name}`;

    for (const detector of activeDetectors) {
      detector.beginScan?.(workspaceRoot);
      // Routes are collected per detector so it can resolve cross-file rules (e.g. Laravel's
      // last-registration-wins) before any edge is built.
      const detectorRoutes: RouteBinding[] = [];
      // Find files that match the detector's pattern (e.g. routes/api.php)
      // A detector activated by a sub-folder manifest extracts only under that folder (M3-07).
      const scopes = this.frameworkScopes(repoRoot).get(detector.name);
      const matchingPaths = filePaths.filter(p => detector.filePattern.test(p) && (!scopes || isInScopes(p, scopes)));
      for (const relPath of matchingPaths) {
        try {
          const absPath = resolve(workspaceRoot, relPath);
          const content = await readFile(absPath, 'utf-8');

          const localCtx: ScanContext = {
            ...ctx,
            // Default the source to the file being extracted so name resolution stays within
            // its language family (a PHP route must not resolve to a JS class, M2-01).
            resolveSymbolToFile: (symName: string, sourcePath: string = relPath) =>
              this.resolveSymbolToFile(symName, this.workspaceFileMap, sourcePath),
            // Aliases (`@/views/X.vue`) resolve through the shared resolver in resolveImportPath (M3-09, M3-12).
            resolveImport: (specifier, fromFile) => this.resolveImportPath(specifier, fromFile, this.workspaceFileMap),
          };

          const routes = await detector.extractRoutes(relPath, content, localCtx);
          for (const route of routes) {
            let conf = 1.0;
            const routeConf = route.metadata?.confidence ?? (route as any).confidence;
            if (typeof routeConf === 'number') {
              conf = routeConf;
            } else if (typeof routeConf === 'string') {
              if (routeConf === 'declared') conf = 1.0;
              else if (routeConf === 'inferred') conf = 0.8;
              else if (routeConf === 'low') conf = 0.3;
            }

            if (conf < 0.5) {
              console.warn(`[mapx] Suppressing route edge due to low confidence (${conf}): ${route.method} ${route.path} -> ${route.handlerFile}`);
              continue;
            }

            if (!route.metadata) route.metadata = {};
            route.metadata.repo = repo.name;
            route.metadata.sourceFile = relPath;
            detectorRoutes.push(route);
          }

          if (detector.extractHooks) {
            const hooks = await detector.extractHooks(relPath, content, localCtx);
            for (const hook of hooks) {
              let conf = 1.0;
              const hookConf = hook.metadata?.confidence ?? (hook as any).confidence;
              if (typeof hookConf === 'number') {
                conf = hookConf;
              } else if (typeof hookConf === 'string') {
                if (hookConf === 'declared') conf = 1.0;
                else if (hookConf === 'inferred') conf = 0.8;
                else if (hookConf === 'low') conf = 0.3;
              }

              if (conf < 0.5) {
                console.warn(`[mapx] Suppressing hook edge due to low confidence (${conf}): ${hook.hookName} -> ${hook.handlerFile}`);
                continue;
              }

              if (!hook.metadata) hook.metadata = {};
              hook.metadata.repo = repo.name;
              hook.metadata.sourceFile = relPath;

              routeRegistry.addHook(hook);
              // A middleware the detector could not resolve (Illuminate\…) falls back to the file
              // registering it; a route using it gets no edge to that file (M0-04-R2).
              if (hook.hookType === 'middleware' && hook.handlerFile && hook.handlerFile !== relPath) {
                middlewareTargets.set(middlewareKey(hook.metadata?.appRoot, hook.hookName), { file: hook.handlerFile, symbol: hook.handlerSymbol || null });
              }

              const edgeType = (['graphql_resolver', 'message_handler', 'websocket_handler', 'middleware'].includes(hook.hookType)
                ? hook.hookType
                : 'hook') as any;
              // An interface hook (OnModuleInit, CanActivate, …) handled in its own file would be a
              // file-to-itself edge carrying nothing; handler hooks keep theirs for the metadata.
              const handlerHook = ['graphql_resolver', 'message_handler', 'websocket_handler'].includes(hook.hookType);
              if (hook.handlerFile === relPath && !handlerHook) continue;
              const hookMeta = {
                ...(hook.metadata ?? {}),
                hookName: hook.hookName,
                hookType: hook.hookType,
                confidence: hook.metadata?.confidence || 'inferred',
              };
              // As for routes: a hook the detector declares (a Kernel alias → class constant) is
              // resolved by the language, not guessed (F01, M0-05-R3).
              const hookVerifiability = hookMeta.confidence === 'declared' ? 'verified' : 'inferred';

              edgesToInsert.push({
                sourceFile: relPath,
                targetFile: hook.handlerFile,
                sourceSymbol: null,
                targetSymbol: hook.handlerSymbol || null,
                edgeType,
                repo: repo.name,
                weight: 1.0,
                verifiability: hookVerifiability,
                metadata: hookMeta
              });
              this.graph.addDependencyEdge({
                sourceFile: relPath,
                targetFile: hook.handlerFile,
                sourceSymbol: null,
                targetSymbol: hook.handlerSymbol || null,
                edgeType,
                repo: repo.name,
                weight: 1.0,
                verifiability: hookVerifiability,
                metadata: hookMeta
              });
            }
          }
        } catch (err) {
          console.error(`Failed to extract routes/hooks for ${relPath}:`, err);
        }
      }

      try {
        detector.finalizeRoutes?.(detectorRoutes);
      } catch (err) {
        console.error(`Failed to finalize ${detector.name} routes:`, err);
      }
      for (const route of detectorRoutes) {
        routeRegistry.addRoute(route);
        const meta = route.metadata ?? {};
        const edge: GraphEdge = {
          sourceFile: meta.sourceFile,
          targetFile: route.handlerFile,
          sourceSymbol: null,
          targetSymbol: route.handlerSymbol || null,
          edgeType: 'route',
          repo: repo.name,
          weight: 1.0,
          // A handler named by class constant is resolved by the language, not guessed.
          verifiability: meta.confidence === 'declared' ? 'verified' : 'inferred',
          metadata: {
            httpVerb: route.method,
            uri: route.path,
            // Detectors put middlewares either on the route or in its metadata.
            middlewares: route.middlewares ?? meta.middlewares ?? [],
            confidence: meta.confidence || 'inferred',
            ...(route.line !== undefined ? { line: route.line } : {}),
            ...(meta.name ? { name: meta.name } : {}),
            ...(meta.resourceType ? { resourceType: meta.resourceType } : {}),
            ...(meta.reachable === false ? { reachable: false } : {}),
            ...(meta.reachability === 'unknown' ? { reachability: 'unknown' } : {}),
            ...(meta.overridden ? { overridden: true, overriddenBy: meta.overriddenBy } : {}),
            ...(meta.conditional ? { conditional: true } : {}),
            ...(meta.dynamic ? { dynamic: true } : {}),
            ...(meta.domain ? { domain: meta.domain } : {}),
            ...(meta.mountedBy ? { mountedBy: meta.mountedBy } : {}),
          },
        };
        edgesToInsert.push(edge);
        this.graph.addDependencyEdge(edge);
      }

      // Route file → middleware class for every `->middleware('auth')` (F09, M0-05-R2): one edge
      // per route file and middleware, listing the routes it guards.
      const guarded = new Map<string, { source: string; name: string; target: { file: string; symbol: string | null }; uris: string[] }>();
      // A middleware class belongs to the app that holds it: the longest app root over its path.
      const appRoots = [...new Set(detectorRoutes.map(r => r.metadata?.appRoot).filter((r): r is string => typeof r === 'string'))];
      const appOf = (file: string) => appRoots.filter(r => r === '' || file.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
      for (const route of detectorRoutes) {
        const meta = route.metadata ?? {};
        const source = meta.sourceFile as string | undefined;
        if (!source) continue;
        for (const raw of (route.middlewares ?? meta.middlewares ?? []) as string[]) {
          const name = String(raw).split(':')[0]!.trim();
          let target = middlewareTargets.get(middlewareKey(meta.appRoot, name));
          // A class name resolves namespace-strictly from the route file. A PHP name without a
          // namespace separator is no Kernel alias or group of the route's app, so it names a global
          // class (`\X`, already qualified), never a class found by its short name (M0-04-R6).
          if (!target && (name.includes('\\') || (this.languageOf(source) !== 'php' && /^[A-Z]/.test(name)))) {
            const file = ctx.resolveSymbolToFile(name, source);
            // Never another Laravel app's class (two apps in one repo, review 2026-10-31).
            if (file && (typeof meta.appRoot !== 'string' || appOf(file) === meta.appRoot)) target = { file, symbol: name };
          }
          if (!target) continue;
          const key = `${source}\0${target.file}\0${name}`;
          const entry = guarded.get(key) ?? { source, name, target, uris: [] };
          entry.uris.push(`${route.method} ${route.path}`);
          guarded.set(key, entry);
        }
      }
      for (const g of guarded.values()) {
        const edge: GraphEdge = {
          sourceFile: g.source,
          targetFile: g.target.file,
          sourceSymbol: null,
          targetSymbol: g.target.symbol,
          edgeType: 'middleware',
          repo: repo.name,
          weight: 1.0,
          verifiability: 'verified',
          metadata: { middleware: g.name, middlewareType: 'route', routeCount: g.uris.length, routes: g.uris },
        };
        edgesToInsert.push(edge);
        this.graph.addDependencyEdge(edge);
      }
    }

    if (edgesToInsert.length > 0) {
      this.store.inTransaction(() => {
        for (const edge of edgesToInsert) {
          this.store.insertEdge(edge);
        }
      });
    }

    await routeRegistry.save(workspaceRoot);
  }

  /**
   * Cached framework detection. Avoids calling FrameworkRegistry.detectActiveFrameworks
   * multiple times per scan (discovery, parsing, post-scan) for the same repo root.
   */
  private async getActiveDetectors(repoRoot: string, filePaths: string[]): Promise<any[]> {
    if (this.cachedActiveDetectors.has(repoRoot)) {
      return this.cachedActiveDetectors.get(repoRoot)!;
    }
    const registry = FrameworkRegistry.getInstance();
    const scopes = new Map<string, string[]>();
    const detectors = await registry.detectActiveFrameworks(repoRoot, filePaths, { workspaceRoot: this.config.getWorkspaceRoot(), scopes });
    this.cachedActiveDetectors.set(repoRoot, detectors);
    this.cachedFrameworkScopes.set(repoRoot, scopes);
    return detectors;
  }

  /** Folders of the detectors a sub-folder manifest activated (M3-07); others cover the repo. */
  private frameworkScopes(repoRoot: string): Map<string, string[]> {
    return this.cachedFrameworkScopes.get(repoRoot) ?? new Map();
  }

  /**
   * Build an in-memory symbol index for O(1) lookups during reference resolution.
   * Maps lowercased symbol names (every case variant) and exact names to their file locations;
   * resolveSymbolToFile applies each language's case rules (M3-10).
   */
  private buildSymbolIndex(
    repoName: string,
    parsedPaths?: string[],
    results?: ParseResult[]
  ): Map<string, SymbolIndexEntry[]> {
    // A new symbol index starts a resolution phase: the file set, go.mod texts and languages
    // may have changed since the last one (long-lived scanners: watch, MCP).
    this.importFiles = null;
    this.importTextCache.clear();
    this.importBindingsCache.clear();
    this.exportCache.clear();
    this.lineCache.clear();
    this.languageCache.clear();
    this.phpNamespaces.clear();
    this.vueGlobals.clear();
    this.vueRoutes.clear();
    this.vueScopes.clear();
    this.vueImporters.clear();
    this.npmWorkspaceNames = null;
    const index = new Map<string, SymbolIndexEntry[]>();
    const excludeSet = new Set(parsedPaths || []);

    const addEntry = (name: string, file: string, scope: string | null, kind?: string) => {
      const entry = { name, file, scope, kind };
      const key = name.toLowerCase();
      const existing = index.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        index.set(key, [entry]);
      }
      // Also index by exact name for case-sensitive match
      if (key !== name) {
        const exactExisting = index.get(name);
        if (exactExisting) {
          exactExisting.push(entry);
        } else {
          index.set(name, [entry]);
        }
      }
    };

    // Load all symbols across all repositories in the workspace to support cross-repository resolution
    const symbols = this.store.getAllSymbols();
    for (const sym of symbols) {
      const filePath = sym.file_path as string;
      const symRepo = sym.repo as string;
      if (symRepo === repoName && excludeSet.has(filePath)) continue;
      addEntry(sym.name as string, filePath, (sym.scope as string) || null, sym.kind as string);
    }

    // PHP namespaces: stored ones, replaced by this phase's parse results.
    const files = this.store.getAllFiles();
    for (const f of files) {
      if (f.language === 'php') this.phpNamespaces.set(f.path as string, (f.namespace as string | null) ?? '');
    }
    this.vuexFiles = collectVuexFiles(files, parsedPaths, results);

    if (parsedPaths && results) {
      for (let i = 0; i < parsedPaths.length; i++) {
        const filePath = parsedPaths[i];
        const res = results[i];
        if (!res) continue;
        for (const sym of res.symbols) {
          addEntry(sym.name, filePath, sym.scope, sym.kind);
        }
        if (this.languageOf(filePath) === 'php') this.phpNamespaces.set(filePath, res.fileMetadata?.namespace ?? '');
      }
    }

    return index;
  }

  /**
   * Shared post-scan analysis pipeline. Runs framework detection, profiling,
   * classification, clustering, metrics, and smell detection.
   * Eliminates ~85 lines of duplicated code between full and incremental scans.
   */
  /**
   * Extracts frontend HTTP call sites (axios, fetch, clients and configured receivers) from the
   * repo's JS/TS/Vue files and replaces the repo's records in .mapx/http-calls.json (D008).
   */
  private async scanHttpCalls(repo: RepoConfig): Promise<void> {
    const workspaceRoot = this.config.getWorkspaceRoot();
    const paths = this.store.getAllFiles(repo.name).map(f => f.path as string);
    const sources = paths.filter(p => HTTP_SOURCE.test(p) && !isHttpSkipped(p));
    this.store.setMeta('http_inputs:' + repo.name, this.httpInputsFingerprint(resolve(workspaceRoot, repo.path)));
    const registry = new HttpCallRegistry();
    await registry.load(workspaceRoot);
    const files: { path: string; content: string }[] = [];
    for (const path of sources) {
      try {
        files.push({ path, content: await readFile(resolve(workspaceRoot, path), 'utf-8') });
      } catch {}
    }
    // Imports follow the shared alias resolver, which reads tsconfig / vite.config & co. (M3-12).
    const readText = (path: string) => this.readWorkspaceText(path);
    const providers = collectProviders(files, readText);
    const fileSet = new Set(sources);
    const clients = (this.config.settings.http?.clients ?? []) as HttpClientConfig[];
    const calls = files.flatMap(f => extractHttpCalls(f.path, f.content, { providers, files: fileSet, clients, readText }));

    // Resolve each URL: constants and templates (M2-04), then the client's base URL (M2-05).
    // Constants are looked up in the call's scope (M2-04-R2).
    const constantIndex = collectConstants(files);
    const contentOf = new Map(files.map(f => [f.path, f.content]));
    const imported = new Map<string, Map<string, string>>();
    // With no offset (a client's baseURL), names the whole file agrees on also count.
    const constantsFor = (file: string, offset?: number) => {
      if (!imported.has(file)) imported.set(file, importedConstants(file, contentOf.get(file) ?? '', constantIndex, fileSet, readText));
      const bindings = constantIndex.bindings.get(file) ?? [];
      return offset === undefined ? constantsAnywhere(bindings, imported.get(file)) : constantsAt(bindings, offset, imported.get(file));
    };
    const dotenv = new Map<string, Map<string, string> | null>();
    const repoRoot = repo.path === '.' ? '' : repo.path.replace(/^\.\//, '');
    const rawEnv = (file: string) => (key: string) => {
      for (const candidate of envCandidates(file, repoRoot)) {
        if (!dotenv.has(candidate)) {
          const abs = resolve(workspaceRoot, candidate);
          dotenv.set(candidate, existsSync(abs) ? parseDotenv(readFileSync(abs, 'utf-8')) : null);
        }
        const value = dotenv.get(candidate)?.get(key);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    // Values expand ${VAR} references across the env files, as Vite does.
    const envFor = (file: string) => (key: string) => {
      const value = rawEnv(file)(key);
      return value === undefined ? undefined : expandDotenv(value, rawEnv(file), key);
    };
    const records: HttpCallRecord[] = calls.map(({ offset, client: { baseURLAt, ...client }, ...rest }) => {
      const call = { ...rest, client };
      const path = evaluate(call.rawUrl, constantsFor(call.file, offset), envFor(call.file));
      if (!path.known) return call;
      // A path that starts with something unknown (an undefined env value, a runtime prefix) is
      // relative to that prefix: keep the rest and let pairing match it as a suffix.
      if (path.value.startsWith('{}')) return { ...call, url: path.value.slice(2) || '/', baseURLUnresolved: true };
      const baseFile = call.client.definedIn ?? call.file;
      // The constants in scope where the client is created: a function-local BASE, not the top-level one (M2-04-R3).
      const base = call.client.baseURL !== undefined ? evaluate(call.client.baseURL, constantsFor(baseFile, baseURLAt), envFor(baseFile)) : null;
      const usable = base?.known && !base.value.includes('{}');
      return {
        ...call,
        url: joinURL(usable ? base!.value : undefined, path.value),
        ...(base && !usable ? { baseURLUnresolved: true } : {}),
      };
    });
    if (!records.length && !registry.getRecords().length) return;
    // Replace this repo's records, and drop records of files the store no longer has (deleted
    // since the last scan): `paths` no longer lists those, so they would otherwise linger.
    const known = new Set(this.store.getAllFiles().map(f => f.path as string));
    registry.dropMissing(known);
    registry.replaceFiles(new Set(paths), records);
    await registry.save(workspaceRoot);
  }

  /**
   * Fingerprint of the HTTP inputs that live outside indexed source: settings.http and every
   * .env* file of the repo (path + mtime). Changing either must refresh http-calls.json even when
   * no source file changed (M2-07).
   */
  /**
   * What the post-scan analysis reads besides the index: the settings (roles, architecture
   * overrides, graph excludes), the framework override file and the analysis version. A sync that
   * parses nothing still runs the analysis when this changed since the last run (M4-04).
   */
  private analysisInputsFingerprint(): string {
    const frameworksPath = join(this.config.getWorkspaceRoot(), '.mapx', 'frameworks.json');
    const frameworks = existsSync(frameworksPath) ? readFileSync(frameworksPath, 'utf-8') : null;
    return createHash('md5').update(JSON.stringify([ANALYSIS_VERSION, this.config.settings, frameworks])).digest('hex');
  }

  private analysisInputsChanged(repoName: string): boolean {
    return this.store.getMeta('analysis_inputs:' + repoName) !== this.analysisInputsFingerprint();
  }

  private httpInputsFingerprint(repoRoot: string): string {
    const envFiles: string[] = [];
    for (const full of this.envFiles(repoRoot)) {
      try {
        envFiles.push(`${full}@${statSync(full).mtimeMs}`);
      } catch {}
    }
    return createHash('md5').update(JSON.stringify([this.config.settings.http ?? null, envFiles.sort()])).digest('hex');
  }

  /** Every .env* file of a repo (up to four directories deep, outside dependencies and builds). */
  private envFiles(repoRoot: string): string[] {
    const envFiles: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!['node_modules', 'vendor', '.git', '.mapx', 'dist', 'storage'].includes(e.name)) walk(full, depth + 1);
        } else if (/^\.env(\.|$)/.test(e.name)) envFiles.push(full);
      }
    };
    walk(repoRoot, 0);
    return envFiles;
  }

  /**
   * The workspace's own hosts (M2-06-R1): those named by settings.http (`hosts`, configured client
   * base URLs) or by a URL in any .env* value of a registered repo. Absolute request URLs on any
   * other non-local host are calls to third-party services and never pair with a workspace route.
   */
  private workspaceHosts(): Set<string> {
    const http = this.config.settings.http ?? {};
    const hosts = new Set<string>((http.hosts ?? []).map(h => h.toLowerCase()));
    const add = (value: string | undefined) => {
      for (const m of (value ?? '').matchAll(/[a-z][a-z\d+.-]*:\/\/[^\s'"`]+/gi)) {
        const host = urlHost(m[0]);
        if (host) hosts.add(host);
      }
    };
    for (const client of http.clients ?? []) add(client.baseURL);
    const workspaceRoot = this.config.getWorkspaceRoot();
    for (const repo of this.config.repos)
      for (const file of this.envFiles(resolve(workspaceRoot, repo.path))) {
        try {
          for (const value of parseDotenv(readFileSync(file, 'utf-8')).values()) add(value);
        } catch {}
      }
    return hosts;
  }

  private async refreshHttpIfInputsChanged(repo: RepoConfig, repoRoot: string): Promise<void> {
    const fingerprint = this.httpInputsFingerprint(repoRoot);
    if (this.store.getMeta('http_inputs:' + repo.name) === fingerprint) return;
    await this.scanHttpCalls(repo);
    await this.pairHttpCalls();
  }

  /**
   * Pairs every recorded HTTP call with the live route it reaches (M2-06) and rebuilds all
   * `http` edges: calling file → route handler, owned by the calling file's repo.
   */
  private async pairHttpCalls(): Promise<void> {
    const workspaceRoot = this.config.getWorkspaceRoot();
    const registry = new HttpCallRegistry();
    await registry.load(workspaceRoot);
    // Clear before the early return: when the last call disappears its edges must go too.
    this.store.deleteEdgesByType('http');
    this.graph.dropEdgesByType('http');
    if (!registry.getRecords().length) return;
    const routeRegistry = new RouteRegistry();
    await routeRegistry.load(workspaceRoot);
    const routes = routeRegistry.getRoutes();
    const repoOf = new Map(this.store.getAllFiles().map(f => [f.path as string, f.repo as string]));

    const hosts = this.workspaceHosts();
    const records = registry.getRecords().map(r => ({ ...r, route: pairCall(r, routes, { hosts }) }));
    registry.setRecords(records);
    await registry.save(workspaceRoot);

    const edges: GraphEdge[] = records
      .filter(r => r.route && repoOf.has(r.file))
      .map(r => ({
        sourceFile: r.file,
        targetFile: r.route!.handlerFile,
        sourceSymbol: null,
        targetSymbol: r.route!.handlerSymbol ?? null,
        edgeType: 'http',
        repo: repoOf.get(r.file)!,
        weight: 1.0,
        verifiability: 'inferred',
        metadata: { httpVerb: r.method, uri: r.url, route: r.route!.path, line: r.line, confidence: r.route!.confidence },
      }));
    this.store.inTransaction(() => {
      for (const edge of edges) this.store.insertEdge(edge);
    });
    for (const edge of edges) this.graph.addDependencyEdge(edge);
  }

  private async runPostScanAnalysis(repo: RepoConfig, repoRoot: string): Promise<void> {
    const workspaceRoot = this.config.getWorkspaceRoot();

    // 1. Scan Framework Routes and Hooks
    await this.scanFrameworkRoutesAndHooks(repo, repoRoot);

    // 1b. Frontend HTTP call sites (.mapx/http-calls.json), then pair every call in the
    // workspace with the routes known now, so repo scan order does not matter.
    await this.scanHttpCalls(repo);
    await this.pairHttpCalls();

    // 2. Profile Codebase
    const frameworksPath = join(workspaceRoot, '.mapx', 'frameworks.json');
    let activeFrameworks: string[] = [];
    if (existsSync(frameworksPath)) {
      try {
        activeFrameworks = JSON.parse(readFileSync(frameworksPath, 'utf-8'));
      } catch {}
    }
    const profiler = new CodebaseProfiler(this.store);
    const profile = profiler.profile(repo.name, activeFrameworks, this.config.settings.graphExcludePatterns);
    this.store.setMeta('codebase_profile:' + repo.name, JSON.stringify(profile));

    // 3. Classify all files
    const routeRegistry = new RouteRegistry();
    await routeRegistry.load(workspaceRoot);
    const routes = routeRegistry.getRoutes();
    const hooks = routeRegistry.getHooks();

    const classifier = new RoleClassifier(this.store, this.config);
    const files = this.store.getAllFiles(repo.name);
    
    this.store.inTransaction(() => {
      for (const f of files) {
        const filePath = f.path as string;
        this.store.deleteClassificationSignalsForFile(filePath);
        const result = classifier.classify(filePath, repo.name, profile, routes, hooks);
        this.store.updateFileRole(filePath, result.role, result.confidence);
        for (const sig of result.signals) {
          this.store.insertClassificationSignal({
            filePath,
            repo: repo.name,
            source: sig.source,
            role: sig.role,
            confidence: sig.confidence,
            reason: sig.reason,
          });
        }
      }
    });

    // 4. Detect clusters & run communities
    this.onProgress?.({ phase: 'cluster', current: 0, total: 0 });
    const clusterEngine = new ClusterEngine(this.store);
    clusterEngine.detect(repo.name);

    // 5. Calculate and persist cluster metrics
    const metricsList = calculateClusterMetrics(this.store, repo.name);
    this.store.inTransaction(() => {
      this.store.raw.prepare('DELETE FROM cluster_metrics WHERE repo = ?').run(repo.name);
      for (const m of metricsList) {
        this.store.insertClusterMetrics({
          clusterName: m.clusterName,
          repo: repo.name,
          fileCount: m.fileCount,
          afferentCoupling: m.afferentCoupling,
          efferentCoupling: m.efferentCoupling,
          instability: m.instability,
          internalEdges: m.internalEdges,
          externalEdges: m.externalEdges,
          cohesionRatio: m.cohesionRatio,
          abstractness: m.abstractness,
          distanceFromMainSeq: m.distanceFromMainSeq,
        });
      }
    });

    // 6. Run Architectural Smell Detection and persist smells
    const analyzer = new ArchitectureAnalyzer(this.store);
    const smellsList = analyzer.analyze(repo.name, profile);
    this.store.inTransaction(() => {
      this.store.raw.prepare('DELETE FROM arch_smells WHERE repo = ?').run(repo.name);
      for (const smell of smellsList) {
        this.store.insertArchSmell({
          repo: repo.name,
          type: smell.type,
          severity: smell.severity,
          description: smell.description,
          involvedFiles: smell.involvedFiles,
          involvedClusters: smell.involvedClusters,
          suggestion: smell.suggestion,
        });
      }
    });

    // 7. Calculate files-only PageRank and persist to files table
    try {
      const dbFiles = this.store.getAllFiles(repo.name);
      const dbEdges = this.store.raw.prepare('SELECT source_file, target_file, edge_type, weight, verifiability, target_repo, metadata FROM edges WHERE repo = ?').all(repo.name) as any[];

      const filesGraph = new MapxGraph(repo.name);
      for (const f of dbFiles) {
        filesGraph.addFileNode(f.path as string, (f.language as string) || 'unknown', (f.size_bytes as number) || 0, (f.lines as number) || 0);
      }
      for (const edge of dbEdges) {
        filesGraph.addDependencyEdge({
          sourceFile: edge.source_file,
          targetFile: edge.target_file,
          sourceSymbol: null,
          targetSymbol: null,
          edgeType: edge.edge_type,
          weight: edge.weight,
          verifiability: edge.verifiability,
          repo: repo.name,
          targetRepo: edge.target_repo,
          metadata: typeof edge.metadata === 'string' ? JSON.parse(edge.metadata) : (edge.metadata || {}),
        });
      }

      const excludePatterns = this.config.settings.graphExcludePatterns || [];
      const rankedFiles = filesGraph.getRankedFiles(excludePatterns);

      this.store.inTransaction(() => {
        for (const rf of rankedFiles) {
          if (typeof this.store.updateFilePageRank === 'function') {
            this.store.updateFilePageRank(rf.path, rf.pagerank);
          }
        }
      });
    } catch (err) {
      console.warn('[mapx] Failed to calculate and save files-only PageRank:', err);
    }

    // Clear framework detection cache after post-scan analysis
    this.cachedActiveDetectors.clear();
    this.cachedFrameworkScopes.clear();
    // Recorded last, after the analysis wrote frameworks.json (its detections): an analysis that threw
    // runs again on the next sync, and so does one whose inputs a user edits afterwards (M4-04).
    this.store.setMeta('analysis_inputs:' + repo.name, this.analysisInputsFingerprint());
  }

  /**
   * Content-hash based incremental scan for non-git projects.
   * Compares stored content hashes with current file hashes to detect changes,
   * rather than falling back to a full scan.
   */
  private async _scanIncrementalByHash(repo: RepoConfig): Promise<ScanResult> {
    const startTime = Date.now();
    this.aborted = false;
    const workspaceRoot = this.config.getWorkspaceRoot();
    const repoRoot = resolve(workspaceRoot, repo.path);

    const discovered = await this.discoverFiles(repoRoot, repo.name);

    // Compare stored hashes to discover changed/new/deleted files
    const trackedHashes = new Map<string, string>();
    for (const f of this.store.getAllFiles(repo.name)) {
      trackedHashes.set(f.path as string, (f.content_hash as string) || '');
    }

    const toRemove: string[] = [];
    const toReindex: DiscoveredFile[] = [];

    for (const f of discovered) {
      if (f.isNew || f.contentChanged) {
        toReindex.push(f);
      }
    }
    const changed = [...toReindex];

    // Detect deleted files; they leave the index first, so their referrers are recorded (M0-02-R4).
    const currentPaths = new Set(discovered.map(f => f.relativePath));
    for (const [path] of trackedHashes) {
      if (!currentPaths.has(path)) toRemove.push(path);
    }
    if (toRemove.length > 0) this.store.inTransaction(() => this.removeFiles(repo.name, toRemove));

    // Unchanged files that had edges into a removed file now back (M0-02-R2), or into a removed file
    // whose referenced names a new or changed file now holds (M0-02-R4), or that use a Vue tag whose
    // global registration changed (M3-08).
    const changedTexts = changed.map(f => ({ path: f.relativePath, content: f.content }));
    const referrers = new Set([
      ...this.takePendingReferrers(repo.name),
      ...this.ownReferrers(repo.name, [
        ...this.takeReferrers(repo.name, discovered.filter(f => f.isNew).map(f => f.relativePath)),
        ...this.importerReferrers(changedTexts.map(t => t.path)),
        ...this.movedReferrers(repo.name, changedTexts),
        ...this.removedSymbolReferrers(repo.name, changedTexts),
        ...this.vanishedNameReferrers(repo.name, changedTexts),
        ...this.configReferrers(repo.name, toRemove),
        ...this.vueRegistryReferrers(repo.name, changedTexts, toRemove),
      ]),
    ]);
    for (const f of discovered) {
      if (!f.isNew && !f.contentChanged && referrers.has(f.relativePath)) toReindex.push(f);
    }

    if (toRemove.length === 0 && toReindex.length === 0) {
      await this.refreshHttpIfInputsChanged(repo, repoRoot);
      return {
        filesScanned: 0,
        symbolsFound: 0,
        edgesFound: 0,
        durationMs: Date.now() - startTime,
        languageBreakdown: {},
      };
    }

    this.store.inTransaction(() => {
      for (const f of toReindex) {
        this.store.deleteSymbolsForFile(f.relativePath);
        this.store.deleteEdgesForFile(f.relativePath);
        this.store.upsertFile({
          path: f.relativePath,
          repo: repo.name,
          language: f.language,
          gitBlobHash: null,
          // Set once the parse result is written (M0-02-R10): until then the file reads as new,
          // and as never scanned, so `mapx status` lists it.
          contentHash: null,
          lastScanned: UNSCANNED,
          sizeBytes: f.sizeBytes,
          lines: f.lines,
        });

        this.graph.addFileNode(f.relativePath, f.language, f.sizeBytes, f.lines);
      }
    });

    // Detect active frameworks
    const filePaths = discovered.map(f => f.relativePath);
    const activeDetectors = await this.getActiveDetectors(repoRoot, filePaths);
    const activeFrameworks = activeDetectors.map(d => d.name);
    const ignoredSymbols = buildScopedIgnoredSymbols(activeFrameworks, this.frameworkScopes(repoRoot));

    // Build pre-scan symbol index
    this.symbolIndex = this.buildSymbolIndex(repo.name);

    this.discoverDartPackages(workspaceRoot);

    let parsedFilesCount = 0;
    this.noteParsed(repo.name, toReindex.map(f => f.relativePath));
    const parseResults = await this.parseFilesParallel(
      toReindex,
      workspaceRoot,
      ignoredSymbols,
      (relPath) => {
        parsedFilesCount++;
        this.onProgress?.({
          phase: 'parse',
          current: parsedFilesCount,
          total: toReindex.length,
          file: relPath,
        });
      }
    );

    // Rebuild the symbol index to include the newly parsed symbols before reference resolution
    this.symbolIndex = this.buildSymbolIndex(
      repo.name,
      toReindex.map(f => f.relativePath),
      parseResults
    );

    let totalSymbols = 0;
    let totalEdges = 0;
    const langBreakdown: Record<string, number> = {};

    this.onProgress?.({ phase: 'resolve', current: 0, total: toReindex.length });

    this.store.inTransaction(() => {
      for (let i = 0; i < toReindex.length && !this.aborted; i++) {
        const f = toReindex[i];
        const result = parseResults[i];

        this.writeParseResult(f.relativePath, result, repo.name);
        this.store.setFileHashes(f.relativePath, f.contentHash, null);

        totalSymbols += result.symbols.length;
        totalEdges += result.references.length;
        langBreakdown[f.language] = (langBreakdown[f.language] || 0) + 1;

        this.onProgress?.({
          phase: 'resolve',
          current: i + 1,
          total: toReindex.length,
          file: f.relativePath,
        });
      }
    });

    // Release content and index
    for (const f of discovered) { (f as any).content = undefined; }

    if (!this.aborted) {
      this.settleMovedNames(repo.name, parseResults.slice(0, changed.length));
      this.settleVanishedNames(repo.name, parseResults.slice(0, changed.length));
      this.settleVueRegistry(repo.name);
      this.store.setMeta('last_scan_time:' + repo.name, new Date().toISOString());
      try {
        await this.runPostScanAnalysis(repo, repoRoot);
      } finally {
        this.releaseSymbolIndex();
      }
    } else {
      this.releaseSymbolIndex();
    }

    return {
      filesScanned: toReindex.length,
      symbolsFound: totalSymbols,
      edgesFound: totalEdges,
      durationMs: Date.now() - startTime,
      languageBreakdown: langBreakdown,
    };
  }
}
