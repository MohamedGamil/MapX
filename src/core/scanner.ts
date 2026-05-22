import { readFile, writeFile, unlink, stat, readdir, open } from 'node:fs/promises';
import { existsSync, readFileSync, closeSync } from 'node:fs';
import { resolve, relative, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { Store } from './store.js';
import { MapxGraph } from './graph.js';
import { Config } from './config.js';
import { getParserForFile } from '../parsers/parser-registry.js';
import { getLanguageForFile } from '../languages/registry.js';
import { getBuiltinLanguages } from '../languages/registry.js';
import { getGitBlobHashes, getChangedFiles, getCurrentCommitSha, isGitRepo } from './git-tracker.js';
import { minimatch } from 'minimatch';
import type { ScanResult, GraphEdge, ParseResult, ExtractedReference, ExtractedSymbol, ProgressCallback } from '../types.js';

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
      if (minimatch(rel, p, { dot: true })) return true;
      const segments = rel.split('/');
      if (segments.some(seg => seg === p)) return true;
      return false;
    })) {
      return false;
    }
    if (includes.length > 0) {
      const matched = includes.some(p => {
        if (minimatch(rel, p, { dot: true })) return true;
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

  private loadResumeState(): ScanResumeState | null {
    const data = this.store.getMeta('scan_resume_state');
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private saveResumeState(state: ScanResumeState): void {
    this.store.setMeta('scan_resume_state', JSON.stringify(state));
  }

  private clearResumeState(): void {
    this.store.setMeta('scan_resume_state', '');
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

  async scanFull(): Promise<ScanResult> {
    const acquired = await this.acquireScanLock();
    if (!acquired) {
      const lockPath = this.getLockPath();
      const pid = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8').trim() : '?';
      throw new Error(`Another scan is already running on this project (PID ${pid}). Wait for it to finish or delete ${lockPath} if it is stale.`);
    }
    try {
      return await this._scanFull();
    } finally {
      await this.releaseScanLock();
    }
  }

  private async _scanFull(): Promise<ScanResult> {
    const startTime = Date.now();
    this.aborted = false;
    const workspaceRoot = this.config.getWorkspaceRoot();
    const repo = this.config.repo;
    const repoRoot = resolve(workspaceRoot, repo.path);

    const discovered = await this.discoverFiles(repoRoot);
    this.onProgress?.({ phase: 'discover', current: discovered.length, total: discovered.length });

    const filesWithSymbols = new Set<string>();
    for (const sym of this.store.getAllSymbols(repo.name)) {
      filesWithSymbols.add(sym.file_path as string);
    }

    const newFiles = discovered.filter(f => f.isNew);
    const changedFiles = discovered.filter(f => !f.isNew && f.contentChanged);
    const incompleteFiles = discovered.filter(f => !f.isNew && !f.contentChanged && !filesWithSymbols.has(f.relativePath));
    const unchangedFiles = discovered.filter(f => !f.isNew && !f.contentChanged && filesWithSymbols.has(f.relativePath));
    const filesToParse = [...newFiles, ...changedFiles, ...incompleteFiles];

    const resumeState = this.loadResumeState();
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

      this.saveResumeState({
        totalFiles: discovered.length,
        completedFiles: [...completed],
        totalSymbols,
        totalEdges,
      });

      const parseResults = await this.parseFilesParallel(toParse, workspaceRoot);

      // Pre-build file map once — avoids O(n²) getAllFiles calls inside resolveReferences
      const allTrackedFiles = this.store.getAllFiles(repo.name);
      const fileMap = new Map<string, string>();
      for (const f of allTrackedFiles) fileMap.set(f.path as string, f.path as string);
      for (const f of toParse) fileMap.set(f.relativePath, f.relativePath);

      // Write in batches to keep each SQLite transaction small (avoids large WAL / fsync stalls)
      const BATCH_SIZE = 100;
      for (let batchStart = 0; batchStart < toParse.length && !this.aborted; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, toParse.length);

        this.store.inTransaction(() => {
          for (let i = batchStart; i < batchEnd; i++) {
            this.writeParseResultWithMap(toParse[i].relativePath, parseResults[i], repo.name, fileMap);
          }
        });

        // Progress and resume state updated AFTER the transaction commits
        for (let i = batchStart; i < batchEnd; i++) {
          totalSymbols += parseResults[i].symbols.length;
          totalEdges += parseResults[i].references.length;
          completed.add(toParse[i].relativePath);
        }

        this.onProgress?.({
          phase: 'parse',
          current: completed.size,
          total: discovered.length,
          file: toParse[batchEnd - 1].relativePath,
        });

        this.saveResumeState({
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
      if (commitSha) this.store.setMeta('last_scan_commit', commitSha);
      this.store.setMeta('last_scan_time', new Date().toISOString());
      this.clearResumeState();
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

  async scanIncremental(): Promise<ScanResult> {
    const acquired = await this.acquireScanLock();
    if (!acquired) {
      const lockPath = this.getLockPath();
      const pid = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8').trim() : '?';
      throw new Error(`Another scan is already running on this project (PID ${pid}). Wait for it to finish or delete ${lockPath} if it is stale.`);
    }
    try {
      return await this._scanIncremental();
    } finally {
      await this.releaseScanLock();
    }
  }

  private async _scanIncremental(): Promise<ScanResult> {
    const startTime = Date.now();
    this.aborted = false;
    const workspaceRoot = this.config.getWorkspaceRoot();
    const repo = this.config.repo;
    const repoRoot = resolve(workspaceRoot, repo.path);

    if (!isGitRepo(repoRoot)) {
      return this._scanFull();
    }

    const lastCommit = this.store.getMeta('last_scan_commit');
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
      const relativePath = change.path.replace(/\\/g, '/');
      if (!matcher(relativePath)) {
        toRemove.push(relativePath);
        continue;
      }
      if (change.status === 'removed') {
        toRemove.push(relativePath);
        continue;
      }
      const absolutePath = resolve(workspaceRoot, relativePath);
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

    const parseResults = await this.parseFilesParallel(
      toReindex.map(r => r.fileInfo),
      workspaceRoot,
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

      this.onProgress?.({
        phase: 'parse',
        current: i + 1,
        total: changes.length,
        file: relPath,
      });
    }

    if (!this.aborted) {
      const commitSha = getCurrentCommitSha(repoRoot);
      if (commitSha) this.store.setMeta('last_scan_commit', commitSha);
      this.store.setMeta('last_scan_time', new Date().toISOString());
    }

    return {
      filesScanned: changes.length,
      symbolsFound: totalSymbols,
      edgesFound: totalEdges,
      durationMs: Date.now() - startTime,
      languageBreakdown: langBreakdown,
    };
  }

  private async discoverFiles(repoRoot: string): Promise<DiscoveredFile[]> {
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
    const allTracked = this.store.getAllFiles(this.config.repo.name);
    for (const f of allTracked) {
      if (f.content_hash) trackedHashes.set(f.path as string, f.content_hash as string);
    }

    this.onProgress?.({ phase: 'discover', current: 0, total: 0 });

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

            this.onProgress?.({ phase: 'discover', current: files.length, total: 0, file: relPath });
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

  private async parseFilesParallel(files: FileInfo[], workspaceRoot: string): Promise<ParseResult[]> {
    if (files.length === 0) return [];
    return this.parseOnMainThread(files, workspaceRoot);
  }

  private async parseWithWorkers(files: FileInfo[], workspaceRoot: string): Promise<ParseResult[]> {
    return this.parseOnMainThread(files, workspaceRoot);
  }

  private async parseOnMainThread(files: FileInfo[], workspaceRoot: string): Promise<ParseResult[]> {
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
          continue;
        }

        try {
          const parser = getParserForFile(relPath, this.config.getResolvedUserLanguages());
          results[i] = await parser.parse(relPath, sources[i]!);
        } catch {
          results[i] = { symbols: [], references: [], errors: [{ message: `Failed to parse ${relPath}` }] };
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, runWorker));

    return results;
  }

  private writeParseResult(relativePath: string, result: ParseResult, repoName: string): void {
    const allFiles = this.store.getAllFiles(repoName);
    const fileMap = new Map<string, string>();
    for (const f of allFiles) fileMap.set(f.path as string, f.path as string);
    this.store.inTransaction(() => {
      this.writeParseResultWithMap(relativePath, result, repoName, fileMap);
    });
  }

  private writeParseResultWithMap(
    relativePath: string,
    result: ParseResult,
    repoName: string,
    fileMap: Map<string, string>,
  ): void {
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

    const resolvedRefs = this.resolveReferencesWithMap(result.references, relativePath, repoName, fileMap);
    for (const edge of resolvedRefs) {
      this.graph.addDependencyEdge(edge);
      this.store.insertEdge(edge);
    }
  }

  private resolveReferences(refs: ExtractedReference[], sourcePath: string, repoName: string): GraphEdge[] {
    const allFiles = this.store.getAllFiles(repoName);
    const fileMap = new Map<string, string>();
    for (const f of allFiles) fileMap.set(f.path as string, f.path as string);
    return this.resolveReferencesWithMap(refs, sourcePath, repoName, fileMap);
  }

  private resolveReferencesWithMap(
    refs: ExtractedReference[],
    sourcePath: string,
    repoName: string,
    fileMap: Map<string, string>,
  ): GraphEdge[] {
    const edges: GraphEdge[] = [];

    for (const ref of refs) {
      let targetFile: string | null = null;

      if (ref.referenceType === 'require') {
        targetFile = this.resolveRequirePath(ref.targetName, sourcePath, fileMap);
      } else if (ref.referenceType === 'import') {
        targetFile = this.resolveImportPath(ref.targetName, sourcePath, fileMap);
      } else {
        targetFile = this.resolveSymbolToFile(ref.targetName, fileMap);
      }

      if (targetFile) {
        edges.push({
          sourceFile: sourcePath,
          targetFile,
          sourceSymbol: ref.sourceSymbol,
          targetSymbol: ref.targetName,
          edgeType: ref.referenceType,
          repo: repoName,
          weight: 1.0,
          verifiability: ref.verifiability ?? 'verified',
        });
      }
    }

    return edges;
  }

  private resolveRequirePath(target: string, sourcePath: string, fileMap: Map<string, string>): string | null {
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
    const dir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
    const resolvedTarget = target.startsWith('.') ? join(dir, target) : target;
    const normalizedTarget = resolvedTarget.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');

    const candidates = [
      normalizedTarget,
      normalizedTarget + '/index.js',
      normalizedTarget + '/index.ts',
      normalizedTarget + '.js',
      normalizedTarget + '.ts',
    ];

    for (const candidate of candidates) {
      if (fileMap.has(candidate)) return candidate;
    }
    return null;
  }

  private resolveSymbolToFile(symbolName: string, fileMap: Map<string, string>): string | null {
    let matches = this.store.searchSymbols(symbolName);
    if (matches.length > 0) {
      const exactMatch = matches.find(m => m.name === symbolName);
      if (exactMatch) return exactMatch.file_path as string;
    }

    if (symbolName.includes('\\')) {
      const parts = symbolName.split('\\');
      const shortName = parts[parts.length - 1];
      matches = this.store.searchSymbols(shortName);
      if (matches.length > 0) {
        const exactMatch = matches.find(m => m.name === shortName);
        if (exactMatch) return exactMatch.file_path as string;
        return matches[0].file_path as string;
      }
    } else if (matches.length > 0) {
      return matches[0].file_path as string;
    }
    return null;
  }
  private shouldExcludeDir(relDir: string, excludes: string[]): boolean {
    return excludes.some(p => {
      if (minimatch(relDir, p, { dot: true })) return true;
      if (minimatch(relDir + '/**', p, { dot: true })) return true;
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
}
