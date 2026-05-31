import { readFile, writeFile, unlink, stat, readdir, open } from 'node:fs/promises';
import { existsSync, readFileSync, closeSync } from 'node:fs';
import { resolve, relative, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { Store } from './store.js';
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
import { getGitBlobHashes, getChangedFiles, getCurrentCommitSha, isGitRepo } from './git-tracker.js';
import picomatch from 'picomatch';
import type { ScanResult, GraphEdge, ParseResult, ExtractedReference, ExtractedSymbol, ProgressCallback, RepoConfig, ScanContext, RouteBinding, HookBinding } from '../types.js';
import { FrameworkRegistry } from '../frameworks/framework-registry.js';
import { RouteRegistry } from '../frameworks/route-registry.js';
import { buildIgnoredSymbols } from '../parsers/ignored-symbols.js';
import { BUILTIN_GLOBALS } from '../parsers/common-methods.js';

const DEFAULT_CONCURRENCY = Math.min(cpus().length || 4, 8);

const DEFAULT_IGNORE = new Set([
  'node_modules', 'vendor', '.git', 'dist', '.mapx', '__pycache__',
  '.next', '.nuxt', 'coverage', '.cache', '.turbo', 'target', 'build',
  '.gradle', '.idea', '.vscode', '.vs',
]);

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

interface DiscoveredFile extends FileInfo {
  relativePath: string;
  contentHash: string;
  isNew: boolean;
  contentChanged: boolean;
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

  constructor(
    store: Store,
    config: Config,
    graph: MapxGraph,
    onProgress?: ProgressCallback,
    options?: { excludes?: string[]; includes?: string[] }
  ) {
    this.store = store;
    this.config = config;
    this.graph = graph;
    this.onProgress = onProgress;
    this.concurrency = DEFAULT_CONCURRENCY;
    this.cliExcludes = options?.excludes ?? [];
    this.cliIncludes = options?.includes ?? [];
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

    const filesWithSymbols = new Set<string>();
    for (const sym of this.store.getAllSymbols(repo.name)) {
      filesWithSymbols.add(sym.file_path as string);
    }

    const newFiles = discovered.filter(f => f.isNew);
    const changedFiles = discovered.filter(f => !f.isNew && f.contentChanged);
    const incompleteFiles = discovered.filter(f => !f.isNew && !f.contentChanged && !filesWithSymbols.has(f.relativePath));
    const unchangedFiles = force ? [] : discovered.filter(f => !f.isNew && !f.contentChanged && filesWithSymbols.has(f.relativePath));
    const filesToParse = force ? discovered : [...newFiles, ...changedFiles, ...incompleteFiles];

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

      const gitHashes = isGitRepo(repoRoot) ? getGitBlobHashes(repoRoot) : new Map<string, string>();

      this.store.inTransaction(() => {
        for (let i = 0; i < toParse.length; i++) {
          const f = toParse[i];
          const blobHash = gitHashes.get(f.relativePath) || null;

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
      const registry = FrameworkRegistry.getInstance();
      const filePaths = discovered.map(f => f.relativePath);
      const activeDetectors = await registry.detectActiveFrameworks(repoRoot, filePaths);
      const activeFrameworks = activeDetectors.map(d => d.name);
      const ignoredSymbols = buildIgnoredSymbols(activeFrameworks);

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



        this.saveResumeState(repo.name, {
          totalFiles: discovered.length,
          completedFiles: [...completed],
          totalSymbols,
          totalEdges,
        });
      }
    } else if (unchangedFiles.length > 0) {
      this.onProgress?.({ phase: 'parse', current: unchangedFiles.length, total: discovered.length });
    }

    const deletedPaths = this.detectDeletedFiles(discovered, repo.name);
    if (deletedPaths.length > 0) {
      this.store.inTransaction(() => {
        for (const p of deletedPaths) {
          this.store.deleteFile(p);
        }
      });
    }

    const langBreakdown: Record<string, number> = {};
    for (const f of discovered) {
      langBreakdown[f.language] = (langBreakdown[f.language] || 0) + 1;
    }

    if (!this.aborted) {
      const commitSha = isGitRepo(repoRoot) ? getCurrentCommitSha(repoRoot) : null;
      if (commitSha) this.store.setMeta('last_scan_commit:' + repo.name, commitSha);
      this.store.setMeta('last_scan_time:' + repo.name, new Date().toISOString());
      this.clearResumeState(repo.name);

      // 1. Scan Framework Routes and Hooks
      await this.scanFrameworkRoutesAndHooks(repo, repoRoot);

      // 2. Profile Codebase
      const frameworksPath = join(workspaceRoot, '.mapx', 'frameworks.json');
      let activeFrameworks: string[] = [];
      if (existsSync(frameworksPath)) {
        try {
          activeFrameworks = JSON.parse(readFileSync(frameworksPath, 'utf-8'));
        } catch {}
      }
      const profiler = new CodebaseProfiler(this.store);
      const profile = profiler.profile(repo.name, activeFrameworks);
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
    }

    const totalParsed = unchangedFiles.length + (toParse.length > 0 ? toParse.length : 0);
    return {
      filesScanned: totalParsed,
      symbolsFound: totalSymbols,
      edgesFound: totalEdges,
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

    if (!isGitRepo(repoRoot)) {
      return this._scanFullForRepo(repo);
    }

    const lastCommit = this.store.getMeta('last_scan_commit:' + repo.name);
    this.onProgress?.({ phase: 'detect', current: 0, total: 0 });
    const changes = getChangedFiles(repoRoot, lastCommit || undefined);

    if (changes.length === 0) {
      return {
        filesScanned: 0,
        symbolsFound: 0,
        edgesFound: 0,
        durationMs: Date.now() - startTime,
        languageBreakdown: {},
      };
    }

    const excludes = [
      ...this.config.settings.excludePatterns,
      ...this.cliExcludes,
    ];
    const includes = [
      ...this.config.settings.includePatterns,
      ...this.cliIncludes,
    ];
    const matcher = buildMatcher(excludes, includes);

    const toRemove: string[] = [];
    const toReindex: Array<{ path: string; fileInfo: FileInfo; contentHash: string }> = [];

    for (const change of changes) {
      const absolutePath = resolve(repoRoot, change.path);
      const relativePath = relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
      if (!matcher(relativePath)) {
        toRemove.push(relativePath);
        continue;
      }
      if (change.status === 'removed') {
        toRemove.push(relativePath);
        continue;
      }
      const fileInfo = await this.getFileInfo(absolutePath, relativePath);
      if (fileInfo) {
        const content = await readFile(absolutePath, 'utf-8');
        const contentHash = createHash('md5').update(content).digest('hex');
        toReindex.push({ path: relativePath, fileInfo, contentHash });
      }
    }

    this.store.inTransaction(() => {
      for (const p of toRemove) {
        this.store.deleteFile(p);
      }
      for (const { path: p, fileInfo, contentHash } of toReindex) {
        this.store.deleteSymbolsForFile(p);
        this.store.deleteEdgesForFile(p);
        this.store.upsertFile({
          path: p,
          repo: repo.name,
          language: fileInfo.language,
          gitBlobHash: null,
          contentHash,
          lastScanned: new Date().toISOString(),
          sizeBytes: fileInfo.sizeBytes,
          lines: fileInfo.lines,
        });
      }
    });

    // Detect active frameworks early so we can build ignored symbols for parsing
    const registry = FrameworkRegistry.getInstance();
    const allFilePaths = this.store.getAllFiles(repo.name).map(f => f.path as string);
    const activeDetectors = await registry.detectActiveFrameworks(repoRoot, allFilePaths);
    const activeFrameworks = activeDetectors.map(d => d.name);
    const ignoredSymbols = buildIgnoredSymbols(activeFrameworks);

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

    let totalSymbols = 0;
    let totalEdges = 0;
    const langBreakdown: Record<string, number> = {};

    for (let i = 0; i < toReindex.length && !this.aborted; i++) {
      const { path: relPath, fileInfo } = toReindex[i];
      const result = parseResults[i];

      this.writeParseResult(relPath, result, repo.name);

      totalSymbols += result.symbols.length;
      totalEdges += result.references.length;
      langBreakdown[fileInfo.language] = (langBreakdown[fileInfo.language] || 0) + 1;


    }

    if (!this.aborted) {
      const commitSha = getCurrentCommitSha(repoRoot);
      if (commitSha) this.store.setMeta('last_scan_commit:' + repo.name, commitSha);
      this.store.setMeta('last_scan_time:' + repo.name, new Date().toISOString());

      // 1. Scan Framework Routes and Hooks
      await this.scanFrameworkRoutesAndHooks(repo, repoRoot);

      // 2. Profile Codebase
      const frameworksPath = join(workspaceRoot, '.mapx', 'frameworks.json');
      let activeFrameworks: string[] = [];
      if (existsSync(frameworksPath)) {
        try {
          activeFrameworks = JSON.parse(readFileSync(frameworksPath, 'utf-8'));
        } catch {}
      }
      const profiler = new CodebaseProfiler(this.store);
      const profile = profiler.profile(repo.name, activeFrameworks);
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
    const excludes = [
      ...this.config.settings.excludePatterns,
      ...this.cliExcludes,
    ];
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

    const walk = async (currentDir: string) => {
      const entries = await readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (this.aborted) return;
        if (DEFAULT_IGNORE.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.mapx') continue;

        const fullPath = join(currentDir, entry.name);

        if (entry.isDirectory()) {
          const relDir = relative(workspaceRoot, fullPath).replace(/\\/g, '/');
          if (this.shouldExcludeDir(relDir, excludes)) continue;

          // Check if this directory contains a .git entry (file or directory)
          // and is NOT the root or any registered repository path.
          const gitPath = join(fullPath, '.git');
          if (existsSync(gitPath)) {
            const registeredAbsPaths = this.config.repos.map(r => resolve(workspaceRoot, r.path));
            if (!registeredAbsPaths.map(p => resolve(p)).includes(resolve(fullPath))) {
              console.warn(`\n⚠️ Warning: Found unregistered nested git repository at ${fullPath}. Skipping walk inside this directory.`);
              continue;
            }
          }

          await walk(fullPath);
        } else if (entry.isFile()) {
          const relPath = relative(workspaceRoot, fullPath).replace(/\\/g, '/');
          if (!matcher(relPath)) continue;

          const langDef = getLanguageForFile(fullPath, this.config.getResolvedUserLanguages());
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

    await walk(repoRoot);
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
    return this.parseOnMainThread(files, workspaceRoot, ignoredSymbols, onFileParsed);
  }

  private async parseWithWorkers(
    files: FileInfo[],
    workspaceRoot: string,
    ignoredSymbols?: Set<string>,
    onFileParsed?: (relPath: string) => void
  ): Promise<ParseResult[]> {
    return this.parseOnMainThread(files, workspaceRoot, ignoredSymbols, onFileParsed);
  }

  private async parseOnMainThread(
    files: FileInfo[],
    workspaceRoot: string,
    ignoredSymbols?: Set<string>,
    onFileParsed?: (relPath: string) => void
  ): Promise<ParseResult[]> {
    const results: ParseResult[] = new Array(files.length);

    // Read all files concurrently first (I/O bound, cheap to parallelize)
    const sources = await Promise.all(
      files.map(async (f) => {
        try {
          return await readFile(f.absolutePath, 'utf-8');
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
          const parser = getParserForFile(relPath, this.config.getResolvedUserLanguages());
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

    for (const ref of refs) {
      if (!ref.targetName || typeof ref.targetName !== 'string') continue;
      const isJsOrTs = /\.(js|ts|jsx|tsx|vue)$/.test(sourcePath);
      if (isJsOrTs && BUILTIN_GLOBALS.has(ref.targetName)) continue;
      let targetFile: string | null = null;

      if (ref.referenceType === 'require') {
        targetFile = this.resolveRequirePath(ref.targetName, sourcePath, fileMap);
      } else if (ref.referenceType === 'import') {
        targetFile = this.resolveImportPath(ref.targetName, sourcePath, fileMap);
      } else {
        targetFile = this.resolveSymbolToFile(ref.targetName, fileMap, sourcePath);
      }

      if (targetFile) {
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

        edges.push({
          sourceFile: sourcePath,
          targetFile,
          sourceSymbol,
          targetSymbol: ref.targetName,
          edgeType: ref.referenceType,
          repo: repoName,
          weight: 1.0,
          verifiability: ref.verifiability ?? 'verified',
          targetRepo: (targetRepoName && targetRepoName !== repoName) ? targetRepoName : undefined,
          metadata: { startLine: ref.startLine },
        });
      }
    }

    return edges;
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

  private resolveImportPath(target: string, sourcePath: string, fileMap: Map<string, string>): string | null {
    if (!target || typeof target !== 'string') return null;
    let resolvedTarget = target;
    if (sourcePath.endsWith('.vue') && target.startsWith('@/')) {
      resolvedTarget = 'src/' + target.substring(2);
    } else {
      const dir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
      resolvedTarget = target.startsWith('.') ? join(dir, target) : target;
    }
    const normalizedTarget = resolvedTarget.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');

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

  private resolveSymbolToFile(symbolName: string, fileMap: Map<string, string>, sourcePath?: string): string | null {
    if (!symbolName || typeof symbolName !== 'string') return null;

    let sourceLang: string | null = null;
    if (sourcePath) {
      const langDef = getLanguageForFile(sourcePath, this.config.getResolvedUserLanguages());
      if (langDef) {
        sourceLang = langDef.name;
      }
    }

    const filterMatches = (matches: Record<string, unknown>[]): Record<string, unknown>[] => {
      if (!sourceLang) return matches;
      return matches.filter(m => {
        const targetPath = m.file_path as string;
        const targetLangDef = getLanguageForFile(targetPath, this.config.getResolvedUserLanguages());
        const targetLang = targetLangDef ? targetLangDef.name : '';
        return areLanguagesCompatible(sourceLang!, targetLang);
      });
    };

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
  private shouldExcludeDir(relDir: string, excludes: string[]): boolean {
    return excludes.some(p => {
      if (picomatch.isMatch(relDir, p, { dot: true })) return true;
      if (picomatch.isMatch(relDir + '/**', p, { dot: true })) return true;
      const segments = relDir.split('/');
      if (segments.some(seg => seg === p)) return true;
      return false;
    });
  }

  private async getFileInfo(absolutePath: string, relativePath: string): Promise<FileInfo | null> {
    const langDef = getLanguageForFile(absolutePath, this.config.getResolvedUserLanguages());
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

    const registry = FrameworkRegistry.getInstance();
    const activeDetectors = await registry.detectActiveFrameworks(repoRoot, filePaths);
    if (activeDetectors.length === 0) return;

    // Save active frameworks
    const frameworksPath = join(workspaceRoot, '.mapx', 'frameworks.json');
    const activeNames = activeDetectors.map(d => d.name);
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

    for (const detector of activeDetectors) {
      // Find files that match the detector's pattern (e.g. routes/api.php)
      const matchingPaths = filePaths.filter(p => detector.filePattern.test(p));
      for (const relPath of matchingPaths) {
        try {
          const absPath = resolve(workspaceRoot, relPath);
          const content = await readFile(absPath, 'utf-8');

          const localCtx: ScanContext = {
            ...ctx,
            resolveSymbolToFile: (symName: string, sourcePath?: string) => {
              return sourcePath
                ? this.resolveSymbolToFile(symName, this.workspaceFileMap, sourcePath)
                : ctx.resolveSymbolToFile(symName);
            }
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

            routeRegistry.addRoute(route);

            // Add as an edge in the db/graph
            this.store.insertEdge({
              sourceFile: relPath,
              targetFile: route.handlerFile,
              sourceSymbol: null,
              targetSymbol: route.handlerSymbol || null,
              edgeType: 'route',
              repo: repo.name,
              weight: 1.0,
              verifiability: 'inferred',
              metadata: {
                httpVerb: route.method,
                uri: route.path,
                middlewares: route.middlewares,
                confidence: route.metadata?.confidence || 'inferred',
              }
            });
            this.graph.addDependencyEdge({
              sourceFile: relPath,
              targetFile: route.handlerFile,
              sourceSymbol: null,
              targetSymbol: route.handlerSymbol || null,
              edgeType: 'route',
              repo: repo.name,
              weight: 1.0,
              verifiability: 'inferred',
              metadata: {
                httpVerb: route.method,
                uri: route.path,
                middlewares: route.middlewares,
                confidence: route.metadata?.confidence || 'inferred',
              }
            });
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

              const edgeType = (['graphql_resolver', 'message_handler', 'websocket_handler', 'middleware'].includes(hook.hookType)
                ? hook.hookType
                : 'hook') as any;

              this.store.insertEdge({
                sourceFile: relPath,
                targetFile: hook.handlerFile,
                sourceSymbol: null,
                targetSymbol: hook.handlerSymbol || null,
                edgeType,
                repo: repo.name,
                weight: 1.0,
                verifiability: 'inferred',
                metadata: {
                  hookName: hook.hookName,
                  hookType: hook.hookType,
                  confidence: hook.metadata?.confidence || 'inferred',
                }
              });
              this.graph.addDependencyEdge({
                sourceFile: relPath,
                targetFile: hook.handlerFile,
                sourceSymbol: null,
                targetSymbol: hook.handlerSymbol || null,
                edgeType,
                repo: repo.name,
                weight: 1.0,
                verifiability: 'inferred',
                metadata: {
                  hookName: hook.hookName,
                  hookType: hook.hookType,
                  confidence: hook.metadata?.confidence || 'inferred',
                }
              });
            }
          }
        } catch (err) {
          console.error(`Failed to extract routes/hooks for ${relPath}:`, err);
        }
      }
    }

    await routeRegistry.save(workspaceRoot);
  }
}
