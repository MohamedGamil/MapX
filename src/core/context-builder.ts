import type { MapxGraph } from './graph.js';
import type { Store } from './store.js';

export interface ContextOptions {
  task: string;
  seeds?: string[]; // specific symbols or file paths to anchor
  tokens?: number;  // token budget, default 8192
  depth?: number;   // search depth for graph expansion, default 2
  repo?: string;
}

export interface ContextResult {
  includedFiles: Array<{
    path: string;
    language: string;
    lineCount: number;
    sizeBytes: number;
    symbols: Array<{
      name: string;
      kind: string;
      scope: string | null;
      startLine: number;
      endLine: number;
    }>;
  }>;
  excludedFiles: string[];
  edges: Array<{
    sourceFile: string;
    targetFile: string;
    sourceSymbol: string | null;
    targetSymbol: string | null;
    edgeType: string;
  }>;
  estimatedTokens: number;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'test', 'task', 'implement',
  'add', 'fix', 'bug', 'issue', 'update', 'delete', 'remove', 'create', 'make',
  'get', 'set', 'run', 'code', 'file', 'project', 'class', 'function', 'method',
  'interface', 'type', 'import', 'export', 'require', 'include', 'exclude'
]);

const SUFFIXES = new Set(['controller', 'service', 'repository', 'manager', 'handler', 'helper', 'provider', 'model']);

export class ContextBuilder {
  private store: Store;
  private graph: MapxGraph;

  constructor(store: Store, graph: MapxGraph) {
    this.store = store;
    this.graph = graph;
  }

  static extractKeywords(text: string): string[] {
    const withSpaces = text.replace(/([a-z])([A-Z])/g, '$1 $2');
    const words = withSpaces.toLowerCase().split(/[^a-z0-9]+/);

    const keywords: string[] = [];
    for (const word of words) {
      if (word.length >= 3 && !STOP_WORDS.has(word)) {
        keywords.push(word);
        for (const suffix of SUFFIXES) {
          if (word.endsWith(suffix) && word.length > suffix.length) {
            keywords.push(word.slice(0, -suffix.length));
          }
        }
      }
    }
    return Array.from(new Set(keywords));
  }

  async buildContext(options: ContextOptions): Promise<ContextResult> {
    const budget = options.tokens ?? 8192;
    const maxDepth = options.depth ?? 2;
    const repo = options.repo;

    // 1. Initial matching (keywords + seeds)
    const seedFiles = new Set<string>();

    // Process explicit seeds
    if (options.seeds) {
      for (const seed of options.seeds) {
        if (seed.includes('.') || seed.includes('/')) {
          // Likely a file path
          if (this.store.getFile(seed)) {
            seedFiles.add(seed);
          }
        } else {
          // Likely a symbol name
          const sym = this.store.getSymbolByName(seed, repo);
          if (sym) {
            seedFiles.add(sym.file_path as string);
          }
        }
      }
    }

    // Process task keywords
    const keywords = ContextBuilder.extractKeywords(options.task);
    for (const kw of keywords) {
      const syms = this.store.searchSymbolsFiltered({ term: kw, repo, limit: 10 });
      for (const sym of syms) {
        seedFiles.add(sym.file_path as string);
      }
    }

    // 2. Graph Expansion (BFS)
    const visited = new Set<string>(seedFiles);
    const queue: Array<{ file: string; depth: number }> = Array.from(seedFiles).map(f => ({ file: f, depth: 0 }));

    while (queue.length > 0) {
      const { file, depth: currentDepth } = queue.shift()!;
      if (currentDepth >= maxDepth) continue;

      const neighbors = [
        ...this.graph.getDependencies(file).map(d => d.target),
        ...this.graph.getReverseDependencies(file).map(r => r.source)
      ];

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ file: neighbor, depth: currentDepth + 1 });
        }
      }
    }

    // 3. Rank Candidates by PageRank
    const rankedAll = this.graph.getRankedFiles();
    const rankedCandidates = rankedAll.filter(f => visited.has(f.path));
    
    // Add visited candidates not present in PageRank results
    for (const path of visited) {
      if (!rankedCandidates.some(rc => rc.path === path)) {
        const dbFile = this.store.getFile(path);
        if (dbFile) {
          rankedCandidates.push({
            path,
            pagerank: 0,
            language: dbFile.language as string
          });
        }
      }
    }

    // 4. Token-constrained Packaging
    const includedFiles: ContextResult['includedFiles'] = [];
    const excludedFiles: string[] = [];
    let currentTokens = 0;

    for (const cand of rankedCandidates) {
      const dbFile = this.store.getFile(cand.path);
      if (!dbFile) continue;

      const syms = this.store.getSymbolsForFile(cand.path);
      const symbolCount = syms.length;

      // Estimate tokens
      let fileTokens = 150;
      if (symbolCount > 3) {
        fileTokens += (symbolCount - 3) * 20;
      }

      if (currentTokens + fileTokens <= budget) {
        includedFiles.push({
          path: cand.path,
          language: cand.language,
          lineCount: (dbFile.lines as number) || 0,
          sizeBytes: (dbFile.size_bytes as number) || 0,
          symbols: syms.map(s => ({
            name: s.name as string,
            kind: s.kind as string,
            scope: s.scope as string | null,
            startLine: s.start_line as number,
            endLine: s.end_line as number
          }))
        });
        currentTokens += fileTokens;
      } else {
        excludedFiles.push(cand.path);
      }
    }

    // 5. Cross-file edges within included files
    const includedPaths = new Set(includedFiles.map(f => f.path));
    const edges: ContextResult['edges'] = [];

    for (const path of includedPaths) {
      const fileEdges = this.store.getEdgesForFile(path);
      for (const edge of fileEdges) {
        if (includedPaths.has(edge.target_file as string)) {
          edges.push({
            sourceFile: edge.source_file as string,
            targetFile: edge.target_file as string,
            sourceSymbol: edge.source_symbol as string | null,
            targetSymbol: edge.target_symbol as string | null,
            edgeType: edge.edge_type as string
          });
        }
      }
    }

    return {
      includedFiles,
      excludedFiles,
      edges,
      estimatedTokens: currentTokens
    };
  }
}
