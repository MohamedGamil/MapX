import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve, relative, extname, join } from 'node:path';
import { cpus } from 'node:os';
import { Store } from './store.js';
import { CodeGraph } from './graph.js';
import { Config } from './config.js';
import { getParserForFile } from '../parsers/parser-registry.js';
import { getLanguageForFile } from '../languages/registry.js';
import { getGitBlobHashes, getChangedFiles, getCurrentCommitSha, isGitRepo } from './git-tracker.js';
import type { ScanResult, GraphEdge, ParseResult, ExtractedReference, ExtractedSymbol, ProgressCallback } from '../types.js';

const DEFAULT_CONCURRENCY = Math.min(cpus().length || 4, 16);

const DEFAULT_IGNORE = new Set([
  'node_modules', 'vendor', '.git', 'dist', '.codegraph', '__pycache__',
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

export class Scanner {
  private store: Store;
  private config: Config;
  private graph: CodeGraph;
  private onProgress?: ProgressCallback;
  private concurrency: number;
  private aborted = false;

  constructor(store: Store, config: Config, graph: CodeGraph, onProgress?: ProgressCallback) {
    this.store = store;
    this.config = config;
    this.graph = graph;
    this.onProgress = onProgress;
    this.concurrency = DEFAULT_CONCURRENCY;
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

  async scanFull(): Promise<ScanResult> {
    const startTime = Date.now();
    this.aborted = false;
    const workspaceRoot = this.config.getWorkspaceRoot();
    const repo = this.config.repo;
    const repoRoot = resolve(workspaceRoot, repo.path);

    const allFiles = await this.walkDirectory(repoRoot, repo.path);
    this.onProgress?.({ phase: 'discover', current: allFiles.length, total: allFiles.length });

    this.indexAllFiles(allFiles, workspaceRoot, repo, repoRoot);

    const resumeState = this.loadResumeState();
    const completed = new Set(resumeState?.completedFiles || []);
    let totalSymbols = resumeState?.totalSymbols || 0;
    let totalEdges = resumeState?.totalEdges || 0;

    const filesToParse = completed.size > 0
      ? allFiles.filter(f => !completed.has(relative(workspaceRoot, f.absolutePath).replace(/\\/g, '/')))
      : allFiles;

    this.onProgress?.({ phase: 'parse', current: completed.size, total: allFiles.length });

    const parseResults = await this.parseFilesConcurrent(filesToParse, workspaceRoot);

    for (let i = 0; i < filesToParse.length && !this.aborted; i++) {
      const relPath = relative(workspaceRoot, filesToParse[i].absolutePath).replace(/\\/g, '/');
      const result = parseResults[i];

      this.writeParseResult(relPath, result, repo.name);

      totalSymbols += result.symbols.length;
      totalEdges += result.references.length;
      completed.add(relPath);

      this.saveResumeState({
        totalFiles: allFiles.length,
        completedFiles: [...completed],
        totalSymbols,
        totalEdges,
      });

      this.onProgress?.({
        phase: 'parse',
        current: completed.size,
        total: allFiles.length,
        file: relPath,
      });
    }

    const langBreakdown: Record<string, number> = {};
    for (const f of allFiles) {
      langBreakdown[f.language] = (langBreakdown[f.language] || 0) + 1;
    }

    if (!this.aborted) {
      const commitSha = isGitRepo(repoRoot) ? getCurrentCommitSha(repoRoot) : null;
      if (commitSha) this.store.setMeta('last_scan_commit', commitSha);
      this.store.setMeta('last_scan_time', new Date().toISOString());
      this.clearResumeState();
    }

    return {
      filesScanned: completed.size,
      symbolsFound: totalSymbols,
      edgesFound: totalEdges,
      durationMs: Date.now() - startTime,
      languageBreakdown: langBreakdown,
      interrupted: this.aborted,
      totalFiles: allFiles.length,
    };
  }

  async scanIncremental(): Promise<ScanResult> {
    const startTime = Date.now();
    this.aborted = false;
    const workspaceRoot = this.config.getWorkspaceRoot();
    const repo = this.config.repo;
    const repoRoot = resolve(workspaceRoot, repo.path);

    if (!isGitRepo(repoRoot)) {
      return this.scanFull();
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

    const toRemove: string[] = [];
    const toReindex: Array<{ path: string; fileInfo: FileInfo }> = [];

    for (const change of changes) {
      const relativePath = change.path.replace(/\\/g, '/');
      if (change.status === 'removed') {
        toRemove.push(relativePath);
        continue;
      }
      const absolutePath = resolve(workspaceRoot, relativePath);
      const fileInfo = await this.getFileInfo(absolutePath, relativePath);
      if (fileInfo) {
        toReindex.push({ path: relativePath, fileInfo });
      }
    }

    this.store.inTransaction(() => {
      for (const p of toRemove) {
        this.store.deleteFile(p);
      }
      for (const { path: p, fileInfo } of toReindex) {
        this.store.deleteSymbolsForFile(p);
        this.store.deleteEdgesForFile(p);
        this.store.upsertFile({
          path: p,
          repo: repo.name,
          language: fileInfo.language,
          gitBlobHash: null,
          lastScanned: new Date().toISOString(),
          sizeBytes: fileInfo.sizeBytes,
          lines: fileInfo.lines,
        });
      }
    });

    const parseResults = await this.parseFilesConcurrent(
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

  private async parseFilesConcurrent(files: FileInfo[], workspaceRoot: string): Promise<ParseResult[]> {
    const results: ParseResult[] = new Array(files.length);

    const sources = await Promise.all(
      files.map(async (f) => {
        try {
          return await readFile(f.absolutePath, 'utf-8');
        } catch {
          return null;
        }
      }),
    );

    for (let i = 0; i < files.length && !this.aborted; i++) {
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

    return results;
  }

  private indexAllFiles(files: FileInfo[], workspaceRoot: string, repo: { name: string; path: string }, repoRoot: string): void {
    this.onProgress?.({ phase: 'index', current: 0, total: files.length });

    const gitHashes = isGitRepo(repoRoot) ? getGitBlobHashes(repoRoot) : new Map<string, string>();

    this.store.inTransaction(() => {
      for (let i = 0; i < files.length; i++) {
        const fileInfo = files[i];
        const relativePath = relative(workspaceRoot, fileInfo.absolutePath).replace(/\\/g, '/');
        const blobHash = gitHashes.get(relativePath) || null;

        this.store.upsertFile({
          path: relativePath,
          repo: repo.name,
          language: fileInfo.language,
          gitBlobHash: blobHash,
          lastScanned: new Date().toISOString(),
          sizeBytes: fileInfo.sizeBytes,
          lines: fileInfo.lines,
        });

        this.graph.addFileNode(relativePath, fileInfo.language, fileInfo.sizeBytes, fileInfo.lines);

        this.onProgress?.({ phase: 'index', current: i + 1, total: files.length, file: relativePath });
      }
    });
  }

  private writeParseResult(relativePath: string, result: ParseResult, repoName: string): void {
    this.store.inTransaction(() => {
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

      const resolvedRefs = this.resolveReferences(result.references, relativePath, repoName);
      for (const edge of resolvedRefs) {
        this.graph.addDependencyEdge(edge);
        this.store.insertEdge(edge);
      }
    });
  }

  private resolveReferences(refs: ExtractedReference[], sourcePath: string, repoName: string): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const allFiles = this.store.getAllFiles(repoName);
    const fileMap = new Map<string, string>();
    for (const f of allFiles) {
      fileMap.set(f.path as string, f.path as string);
    }

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
    const candidates = [
      target.replace(/^\.\//, ''),
      target + '/index.js',
      target + '/index.ts',
      target + '.js',
      target + '.ts',
    ];

    for (const candidate of candidates) {
      if (fileMap.has(candidate)) return candidate;
    }
    return null;
  }

  private resolveSymbolToFile(symbolName: string, fileMap: Map<string, string>): string | null {
    const matches = this.store.searchSymbols(symbolName);
    if (matches.length > 0) {
      return matches[0].file_path as string;
    }
    return null;
  }

  private async walkDirectory(dir: string, repoPath: string): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    const workspaceRoot = this.config.getWorkspaceRoot();
    const excludePatterns = this.config.settings.excludePatterns;

    this.onProgress?.({ phase: 'discover', current: 0, total: 0 });

    const walk = async (currentDir: string) => {
      const entries = await readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (DEFAULT_IGNORE.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.codegraph') continue;

        const fullPath = join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const relPath = relative(workspaceRoot, fullPath).replace(/\\/g, '/');
          if (this.shouldExclude(relPath, excludePatterns)) continue;

          const langDef = getLanguageForFile(fullPath, this.config.getResolvedUserLanguages());
          if (!langDef) continue;

          try {
            const stats = await stat(fullPath);
            const content = await readFile(fullPath, 'utf-8');
            const lines = content.split('\n').length;

            files.push({
              absolutePath: fullPath,
              language: langDef.name,
              sizeBytes: stats.size,
              lines,
            });

            this.onProgress?.({ phase: 'discover', current: files.length, total: 0, file: relPath });
          } catch {
            // skip unreadable files
          }
        }
      }
    };

    await walk(dir);
    return files;
  }

  private shouldExclude(path: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
        if (regex.test(path)) return true;
      } else {
        if (path.includes(pattern)) return true;
      }
    }
    return false;
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
