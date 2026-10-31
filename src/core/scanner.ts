import { readFile, writeFile, unlink, stat, readdir, open } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, extname, join, basename } from 'node:path';
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
import { getGitBlobHashes, getChangedFiles, getCurrentCommitSha, gitBlobId, isGitRepo } from './git-tracker.js';
import type { ScanResult, GraphEdge, ParseResult, ExtractedReference, ExtractedSymbol, ProgressCallback, RepoConfig, ScanContext, RouteBinding, HookBinding } from '../types.js';
import { FrameworkRegistry } from '../frameworks/framework-registry.js';
import { canonicalPath } from './workspace-manager.js';
import { DEFAULT_IGNORE, buildMatcher, effectiveExcludesFor, isExcludedDir, normalizePattern, shebangLanguage } from './file-rules.js';
import { collectProviders, extractHttpCalls, HTTP_SOURCE, isHttpSkipped, type HttpClientConfig } from '../frameworks/http/client-calls.js';
import { HttpCallRegistry, type HttpCallRecord } from '../frameworks/http/http-registry.js';
import { pairCall, urlHost } from '../frameworks/http/pairing.js';
import { importResolverFor, type ImportHit } from './import-resolvers.js';
import { collectConstants, constantsAnywhere, constantsAt, envCandidates, evaluate, expandDotenv, importedConstants, joinURL, parseDotenv } from '../frameworks/http/url-resolver.js';
import { RouteRegistry } from '../frameworks/route-registry.js';
import { buildIgnoredSymbols } from '../parsers/ignored-symbols.js';
import { BUILTIN_GLOBALS } from '../parsers/common-methods.js';

/** Languages whose `constant` and `variable` symbols are values: function-valued declarations are `function` symbols (M0-17-R2). */
const VALUE_SYMBOL_LANGUAGES = new Set(['javascript', 'typescript', 'python']);

/** Symbol index entry: a declaration by name, with its file, scope and kind. */
type SymbolIndexEntry = { name: string; file: string; scope: string | null; kind?: string };
const NAMESPACE_KINDS = new Set(['namespace']);
const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'enum', 'record', 'trait']);

const DEFAULT_CONCURRENCY = Math.min(cpus().length || 4, 8);

interface ScanResumeState {
  totalFiles: number;
  completedFiles: string[];
  totalSymbols: number;
  totalEdges: number;
}

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
  private symbolIndex: Map<string, SymbolIndexEntry[]> | null = null;
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
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private saveResumeState(repoName: string, state: ScanResumeState): void {
    this.store.setMeta(`scan_resume_state:${repoName}`, JSON.stringify(state));
  }

  private clearResumeState(repoName: string): void {
    this.store.setMeta(`scan_resume_state:${repoName}`, '');
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
        const discovered = await this.discoverFiles(repoRoot, repo.name, true);
        for (const f of discovered) {
          this.workspaceFileMap.set(f.relativePath, repo.name);
        }
      }

      let filesScanned = 0;
      let symbolsFound = 0;
      let edgesFound = 0;
      const combinedLangBreakdown: Record<string, number> = {};
      const startTime = Date.now();

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

    // Deleted files leave the index before anything is parsed: a file moved within this scan then
    // records its referrers and their names, and re-parsed references cannot resolve to the old path
    // through the file map or the symbol index (M0-02-R4).
    if (!this.aborted) {
      const deletedPaths = this.detectDeletedFiles(discovered, repo.name);
      if (deletedPaths.length > 0) this.store.inTransaction(() => this.removeFiles(repo.name, deletedPaths));
    }

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
    this.store.setMeta('resolution_repos:' + repo.name, JSON.stringify(this.visibleRepos(repo.name)));
    const reparseAll = force || newlyVisible || (previousFilters !== null && previousFilters !== undefined && previousFilters !== filters);
    this.store.setMeta(filterKey, filters);
    // Unchanged files that had edges into a removed file now back (M0-02-R2), or into a removed file
    // whose referenced names a new or changed file now holds (M0-02-R4): re-parse them.
    const candidates = [...newFiles, ...changedFiles, ...incompleteFiles];
    const referrers = new Set([
      ...this.takeReferrers(repo.name, newFiles.map(f => f.relativePath)),
      ...this.movedReferrers(repo.name, candidates.map(f => ({ path: f.relativePath, content: f.content }))),
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
      const ignoredSymbols = buildIgnoredSymbols(activeFrameworks);

      // Build pre-scan symbol index for O(1) lookups during reference resolution
      this.symbolIndex = this.buildSymbolIndex(repo.name);

      // Discover Dart packages for accurate package: URI resolution
      this.discoverDartPackages(workspaceRoot);

      let parsedFilesCount = 0;
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

      const fileMap = this.workspaceFileMap.size > 0 ? this.workspaceFileMap : (() => {
        const allTrackedFiles = this.store.getAllFiles();
        const map = new Map<string, string>();
        for (const f of allTrackedFiles) map.set(f.path as string, f.repo as string);
        for (const f of toParse) map.set(f.relativePath, repo.name);
        return map;
      })();

      const BATCH_SIZE = 100;
      for (let batchStart = 0; batchStart < toParse.length && !this.aborted; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, toParse.length);

        this.store.inTransaction(() => {
          for (let i = batchStart; i < batchEnd; i++) {
            this.writeParseResultWithMap(toParse[i].relativePath, parseResults[i], repo.name, fileMap);
          }
        });

        for (let i = batchStart; i < batchEnd; i++) {
          totalSymbols += parseResults[i].symbols.length;
          totalEdges += parseResults[i].references.length;
          completed.add(toParse[i].relativePath);
        }

        this.onProgress?.({
          phase: 'resolve',
          current: batchEnd,
          total: toParse.length,
          file: toParse[batchEnd - 1].relativePath,
        });

        this.saveResumeState(repo.name, {
          totalFiles: discovered.length,
          completedFiles: [...completed],
          totalSymbols,
          totalEdges,
        });
      }
      if (!this.aborted) {
        const candidatePaths = new Set(candidates.map(f => f.relativePath));
        this.settleMovedNames(repo.name, parseResults.filter((_, i) => candidatePaths.has(toParse[i].relativePath)));
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
      const commitSha = isGitRepo(repoRoot) ? getCurrentCommitSha(repoRoot) : null;
      if (commitSha) this.store.setMeta('last_scan_commit:' + repo.name, commitSha);
      this.store.setMeta('last_scan_time:' + repo.name, new Date().toISOString());
      this.clearResumeState(repo.name);

      try {
        await this.runPostScanAnalysis(repo, repoRoot);
      } finally {
        this.symbolIndex = null;
      }
    } else {
      this.symbolIndex = null;
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
        const discovered = await this.discoverFiles(repoRoot, repo.name, true);
        for (const f of discovered) {
          this.workspaceFileMap.set(f.relativePath, repo.name);
        }
      }

      let filesScanned = 0;
      let symbolsFound = 0;
      let edgesFound = 0;
      const combinedLangBreakdown: Record<string, number> = {};
      const startTime = Date.now();

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

    if (!isGitRepo(repoRoot)) {
      // Content-hash based incremental for non-git projects
      return this._scanIncrementalByHash(repo);
    }

    const excludes = this.effectiveExcludes(repo.name);
    const includes = [
      ...this.config.settings.includePatterns,
      ...this.cliIncludes,
    ];
    const matcher = buildMatcher(excludes, includes);

    const lastCommit = this.store.getMeta('last_scan_commit:' + repo.name);
    this.onProgress?.({ phase: 'detect', current: 0, total: 0 });
    const changes = getChangedFiles(repoRoot, lastCommit || undefined);

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
      if (committed.has(f.path as string) || listed.has(absolutePath) || existsSync(absolutePath)) continue;
      changes.push({ path: relative(repoRoot, absolutePath).replace(/\\/g, '/'), status: 'removed' });
    }

    if (changes.length === 0) {
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

    // A rename is listed by its new path; its old path leaves the index, and the files with edges
    // into it are re-parsed so references that now resolve to the new path find it (M0-02-R3).
    const renamedReferrers = new Set<string>();
    for (const change of changes) {
      if (!change.oldPath) continue;
      const oldPath = relative(workspaceRoot, resolve(repoRoot, change.oldPath)).replace(/\\/g, '/');
      toRemove.push(oldPath);
      for (const r of this.store.getReferrers(oldPath)) renamedReferrers.add(r);
    }

    for (const change of changes) {
      const absolutePath = resolve(repoRoot, change.path);
      const relativePath = relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
      if (!matcher(relativePath)) {
        toRemove.push(relativePath);
        continue;
      }
      // A listed file that is gone is removed too: a staged-only file deleted from the working tree
      // is still listed as added by `git diff --cached` (M0-02-R5).
      if (change.status === 'removed' || !existsSync(absolutePath)) {
        toRemove.push(relativePath);
        continue;
      }
      const fileInfo = await this.getFileInfo(absolutePath, relativePath);
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

    this.store.inTransaction(() => this.removeFiles(repo.name, toRemove));

    // Unchanged files of this repo that had edges into a removed file now back (M0-02-R2), into
    // a renamed file's old path, or into a removed file whose referenced names a listed file now
    // holds (M0-02-R4).
    const reindexed = new Set(toReindex.map(r => r.path));
    const moved = this.movedReferrers(repo.name, [...contents].map(([path, content]) => ({ path, content })));
    for (const r of new Set([...this.takeReferrers(repo.name, [...reindexed]), ...renamedReferrers, ...moved])) {
      if (reindexed.has(r) || toRemove.includes(r) || this.store.getFile(r)?.repo !== repo.name) continue;
      const absolutePath = resolve(workspaceRoot, r);
      const fileInfo = existsSync(absolutePath) ? await this.getFileInfo(absolutePath, r) : null;
      if (!fileInfo) continue;
      const bytes = await readFile(absolutePath);
      const contentHash = createHash('md5').update(bytes.toString('utf-8')).digest('hex');
      toReindex.push({ path: r, fileInfo, contentHash, blobHash: gitBlobId(bytes) });
    }

    this.store.inTransaction(() => {
      for (const { path: p, fileInfo, contentHash, blobHash } of toReindex) {
        this.store.deleteSymbolsForFile(p);
        this.store.deleteEdgesForFile(p);
        this.store.upsertFile({
          path: p,
          repo: repo.name,
          language: fileInfo.language,
          // The blob id of the indexed bytes (`git hash-object`), which the skip above compares
          // with: the next sync skips the file while its content stays the same (M0-02-R5).
          gitBlobHash: blobHash,
          contentHash,
          lastScanned: new Date().toISOString(),
          sizeBytes: fileInfo.sizeBytes,
          lines: fileInfo.lines,
        });
      }
    });

    // Detect active frameworks early so we can build ignored symbols for parsing
    const allFilePaths = this.store.getAllFiles(repo.name).map(f => f.path as string);
    const activeDetectors = await this.getActiveDetectors(repoRoot, allFilePaths);
    const activeFrameworks = activeDetectors.map(d => d.name);
    const ignoredSymbols = buildIgnoredSymbols(activeFrameworks);

    // Build pre-scan symbol index for O(1) lookups during reference resolution
    this.symbolIndex = this.buildSymbolIndex(repo.name);

    // Discover Dart packages for accurate package: URI resolution
    this.discoverDartPackages(workspaceRoot);

    let parsedFilesCount = 0;
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
        const { path: relPath, fileInfo } = toReindex[i];
        const result = parseResults[i];

        this.writeParseResult(relPath, result, repo.name);

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
      const commitSha = getCurrentCommitSha(repoRoot);
      if (commitSha) this.store.setMeta('last_scan_commit:' + repo.name, commitSha);
      this.store.setMeta('last_scan_time:' + repo.name, new Date().toISOString());

      try {
        await this.runPostScanAnalysis(repo, repoRoot);
      } finally {
        this.symbolIndex = null;
      }
    } else {
      this.symbolIndex = null;
    }

    return {
      filesScanned: changes.length,
      symbolsFound: totalSymbols,
      edgesFound: totalEdges,
      durationMs: Date.now() - startTime,
      languageBreakdown: langBreakdown,
    };
  }

  private async discoverFiles(repoRoot: string, repoName: string, silent = false): Promise<DiscoveredFile[]> {
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
              console.warn(`\n⚠️ Warning: Found unregistered nested git repository at ${fullPath}. Skipping walk inside this directory.`);
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

          try {
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

    await walk(repoRoot, ownRoot);
    return files;
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
    ignoredSymbols?: Set<string>,
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
    ignoredSymbols?: Set<string>,
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
    ignoredSymbols?: Set<string>,
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
            ignoredSymbols,
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
    if (this.workspaceFileMap.size === 0) {
      for (const f of this.store.getAllFiles()) {
        this.workspaceFileMap.set(f.path as string, f.repo as string);
      }
    }
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

  private resolveReferences(refs: ExtractedReference[], sourcePath: string, repoName: string): GraphEdge[] {
    if (this.workspaceFileMap.size === 0) {
      for (const f of this.store.getAllFiles()) {
        this.workspaceFileMap.set(f.path as string, f.repo as string);
      }
    }
    const dbSymbols = this.store.getSymbolsForFile(sourcePath);
    const symbols = dbSymbols.map((s: any) => ({
      name: s.name,
      kind: s.kind,
      scope: s.scope,
      startLine: s.start_line,
      endLine: s.end_line,
      metadata: s.metadata ? JSON.parse(s.metadata) : {}
    }));
    return this.resolveReferencesWithMap(refs, sourcePath, repoName, this.workspaceFileMap, symbols);
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
    const usedNames = () => (referencedNames ??= new Set(refs
      .filter(r => r.referenceType !== 'import' && r.referenceType !== 'require' && typeof r.targetName === 'string')
      .map(r => r.targetName.replace(/<[\s\S]*$/, '').split(/\.|::/).pop()!)));

    for (const ref of refs) {
      if (!ref.targetName || typeof ref.targetName !== 'string') continue;
      if (isJsOrTs && BUILTIN_GLOBALS.has(ref.targetName)) continue;
      // Module-style imports (Java, Rust, Go, Python, Ruby, C#, PHP): one edge per resolved file,
      // named by the module/namespace rather than the raw statement (M0-12-R4).
      let targets: { file: string; symbol: string }[];

      if (resolver && (ref.referenceType === 'import' || ref.referenceType === 'require')) {
        targets = this.resolveModuleImport(resolver, ref.targetName, sourcePath, fileMap, usedNames);
      } else {
        let targetFile: string | null = null;
        if (ref.referenceType === 'require') {
          targetFile = this.resolveRequirePath(ref.targetName, sourcePath, fileMap);
        } else if (ref.referenceType === 'import') {
          targetFile = this.resolveImportPath(ref.targetName, sourcePath, fileMap);
        } else {
          // Calls and instantiations skip value symbols (constants, variables) (M0-17-R2).
          const callable = ref.referenceType === 'call' || ref.referenceType === 'instantiation';
          targetFile = this.resolveSymbolToFile(ref.targetName, fileMap, sourcePath, callable);
        }
        targets = targetFile ? [{ file: targetFile, symbol: ref.targetName }] : [];
      }

      for (const { file: targetFile, symbol: targetSymbol } of targets) {
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

        edges.push({
          sourceFile: sourcePath,
          targetFile,
          sourceSymbol,
          targetSymbol,
          edgeType,
          repo: repoName,
          weight: 1.0,
          verifiability: ref.verifiability ?? 'verified',
          targetRepo: (targetRepoName && targetRepoName !== repoName) ? targetRepoName : undefined,
          // Keep what the parser recorded (relationship, binding, facade, dispatch details).
          metadata: { ...(ref.metadata ?? {}), startLine: ref.startLine },
        });
      }
    }

    return edges;
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
    const workspaceRoot = this.config.getWorkspaceRoot();
    // The symbol index holds every stored symbol plus this phase's parse results, so a namespace
    // declared in a file the scan does not re-parse is found too.
    const declaring = (name: string, kinds: Set<string>) => [...new Set(
      (this.symbolIndex?.get(name) ?? []).filter(e => e.name === name && kinds.has(e.kind ?? '')).map(e => e.file),
    )];
    return resolver(target, sourcePath, {
      files,
      readText: (path) => {
        if (!this.importTextCache.has(path)) {
          const abs = resolve(workspaceRoot, path);
          this.importTextCache.set(path, existsSync(abs) ? readFileSync(abs, 'utf-8') : null);
        }
        return this.importTextCache.get(path)!;
      },
      namespaceFiles: (namespace) => declaring(namespace, NAMESPACE_KINDS),
      typeFiles: (name) => declaring(name, TYPE_KINDS),
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

    if (sourcePath.endsWith('.vue') && target.startsWith('@/')) {
      resolvedTarget = 'src/' + target.substring(2);
    } else {
      const dir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
      resolvedTarget = target.startsWith('.') ? join(dir, target) : target;
    }
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

    // Use pre-built symbol index for O(1) lookup when available
    if (this.symbolIndex) {
      let indexed = this.symbolIndex.get(symbolName) || this.symbolIndex.get(symbolName.toLowerCase());
      if (!indexed) {
        if (symbolName.includes('\\')) {
          const parts = symbolName.split('\\');
          const shortName = parts[parts.length - 1];
          indexed = this.symbolIndex.get(shortName) || this.symbolIndex.get(shortName.toLowerCase());
        } else if (symbolName.includes('.')) {
          const parts = symbolName.split('.');
          const last = parts[parts.length - 1];
          const commonExtensions = new Set([
            'ts', 'js', 'cs', 'java', 'py', 'php', 'go', 'rs', 'swift', 'kt', 
            'svelte', 'vue', 'lua', 'ex', 'zig', 'sh', 'pas', 'scala', 'rb', 
            'c', 'cpp', 'h', 'hpp', 'json', 'yaml', 'yml', 'md'
          ]);
          if (!commonExtensions.has(last.toLowerCase())) {
            const shortName = last;
            indexed = this.symbolIndex.get(shortName) || this.symbolIndex.get(shortName.toLowerCase());
          }
        }
      }
      if (indexed && indexed.length > 0) {
        const compatible = filterMatches(indexed);
        if (compatible.length > 0) {
          const shortName = symbolName.includes('\\') 
            ? symbolName.split('\\').pop()! 
            : (symbolName.includes('.') ? symbolName.split('.').pop()! : symbolName);
          if (sourcePath) {
            const sameFile = compatible.find(m => m.file === sourcePath && m.name === shortName);
            if (sameFile) return sameFile.file;
          }
          // A namespaced name (App\Models\Role) prefers the homonym whose path follows its namespace
          // (…/Models/Role.php) over another namespace's Role (M0-04-R1).
          if (symbolName.includes('\\')) {
            const nsPath = symbolName.split('\\').filter(Boolean).slice(-2).join('/').toLowerCase();
            const byPath = compatible.find(m => m.name === shortName && m.file.toLowerCase().replace(/\.[^./]+$/, '').endsWith(nsPath));
            if (byPath) return byPath.file;
          }
          const exact = compatible.find(m => m.name === shortName);
          if (exact) return exact.file;
          return compatible[0].file;
        }
      }
      return null; // O(1) short-circuit: if not in symbolIndex, it's a third-party/external symbol not in this workspace.
    }

    let matches = this.store.searchSymbols(symbolName);
    matches = filterMatches(matches);
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
      matches = this.store.searchSymbols(shortName);
      matches = filterMatches(matches);
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
      const commonExtensions = new Set([
        'ts', 'js', 'cs', 'java', 'py', 'php', 'go', 'rs', 'swift', 'kt', 
        'svelte', 'vue', 'lua', 'ex', 'zig', 'sh', 'pas', 'scala', 'rb', 
        'c', 'cpp', 'h', 'hpp', 'json', 'yaml', 'yml', 'md'
      ]);
      if (!commonExtensions.has(last.toLowerCase())) {
        const shortName = last;
        matches = this.store.searchSymbols(shortName);
        matches = filterMatches(matches);
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
      // Multiple matches, none exact — prefer same-file over arbitrary first result
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
   * Drop the recorded names of removed files once one of them is declared by a new or changed file
   * parsed in this scan, whose text `movedReferrers` saw, so those referrers were re-parsed (M0-02-R4).
   */
  private settleMovedNames(repoName: string, results: Array<ParseResult | undefined>): void {
    const names = this.removedNames(repoName);
    if (Object.keys(names).length === 0) return;
    const declared = new Set(results.flatMap(r => (r?.symbols ?? []).map(s => s.name)));
    let changed = false;
    for (const [p, n] of Object.entries(names)) {
      if (!n.some(name => declared.has(name))) continue;
      delete names[p];
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
      resolveSymbolToFile: (symName: string) => {
        return this.resolveSymbolToFile(symName, this.workspaceFileMap);
      }
    };

    const edgesToInsert: any[] = [];
    // Middleware names (Kernel aliases such as `auth`, or class names) → the class that handles
    // them, from the middleware hooks; route middlewares are resolved through it (M0-05-R2).
    const middlewareTargets = new Map<string, { file: string; symbol: string | null }>();

    for (const detector of activeDetectors) {
      detector.beginScan?.(workspaceRoot);
      // Routes are collected per detector so it can resolve cross-file rules (e.g. Laravel's
      // last-registration-wins) before any edge is built.
      const detectorRoutes: RouteBinding[] = [];
      // Find files that match the detector's pattern (e.g. routes/api.php)
      const matchingPaths = filePaths.filter(p => detector.filePattern.test(p));
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
              if (hook.hookType === 'middleware' && hook.handlerFile) {
                middlewareTargets.set(hook.hookName, { file: hook.handlerFile, symbol: hook.handlerSymbol || null });
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
      for (const route of detectorRoutes) {
        const meta = route.metadata ?? {};
        const source = meta.sourceFile as string | undefined;
        if (!source) continue;
        for (const raw of (route.middlewares ?? meta.middlewares ?? []) as string[]) {
          const name = String(raw).split(':')[0]!.trim();
          let target = middlewareTargets.get(name);
          if (!target && /^[A-Z\\]/.test(name)) {
            const file = ctx.resolveSymbolToFile(name, source);
            if (file) target = { file, symbol: name };
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
    const detectors = await registry.detectActiveFrameworks(repoRoot, filePaths);
    this.cachedActiveDetectors.set(repoRoot, detectors);
    return detectors;
  }

  /**
   * Build an in-memory symbol index for O(1) lookups during reference resolution.
   * Maps symbol names (case-insensitive) to their file locations.
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
    this.languageCache.clear();
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

    if (parsedPaths && results) {
      for (let i = 0; i < parsedPaths.length; i++) {
        const filePath = parsedPaths[i];
        const res = results[i];
        if (!res) continue;
        for (const sym of res.symbols) {
          addEntry(sym.name, filePath, sym.scope, sym.kind);
        }
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
    const providers = collectProviders(files);
    const fileSet = new Set(sources);
    const clients = (this.config.settings.http?.clients ?? []) as HttpClientConfig[];
    const calls = files.flatMap(f => extractHttpCalls(f.path, f.content, { providers, files: fileSet, clients }));

    // Resolve each URL: constants and templates (M2-04), then the client's base URL (M2-05).
    // Constants are looked up in the call's scope (M2-04-R2).
    const constantIndex = collectConstants(files);
    const contentOf = new Map(files.map(f => [f.path, f.content]));
    const imported = new Map<string, Map<string, string>>();
    // With no offset (a client's baseURL), names the whole file agrees on also count.
    const constantsFor = (file: string, offset?: number) => {
      if (!imported.has(file)) imported.set(file, importedConstants(file, contentOf.get(file) ?? '', constantIndex, fileSet));
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
    const records: HttpCallRecord[] = calls.map(({ offset, ...call }) => {
      const path = evaluate(call.rawUrl, constantsFor(call.file, offset), envFor(call.file));
      if (!path.known) return call;
      // A path that starts with something unknown (an undefined env value, a runtime prefix) is
      // relative to that prefix: keep the rest and let pairing match it as a suffix.
      if (path.value.startsWith('{}')) return { ...call, url: path.value.slice(2) || '/', baseURLUnresolved: true };
      const baseFile = call.client.definedIn ?? call.file;
      const base = call.client.baseURL !== undefined ? evaluate(call.client.baseURL, constantsFor(baseFile), envFor(baseFile)) : null;
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
    // whose referenced names a new or changed file now holds (M0-02-R4).
    const referrers = new Set([
      ...this.takeReferrers(repo.name, discovered.filter(f => f.isNew).map(f => f.relativePath)),
      ...this.movedReferrers(repo.name, changed.map(f => ({ path: f.relativePath, content: f.content }))),
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
          contentHash: f.contentHash,
          lastScanned: new Date().toISOString(),
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
    const ignoredSymbols = buildIgnoredSymbols(activeFrameworks);

    // Build pre-scan symbol index
    this.symbolIndex = this.buildSymbolIndex(repo.name);

    this.discoverDartPackages(workspaceRoot);

    let parsedFilesCount = 0;
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
      this.store.setMeta('last_scan_time:' + repo.name, new Date().toISOString());
      try {
        await this.runPostScanAnalysis(repo, repoRoot);
      } finally {
        this.symbolIndex = null;
      }
    } else {
      this.symbolIndex = null;
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
