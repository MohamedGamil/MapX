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
  matchedSymbols?: Array<{
    name: string;
    kind: string;
    filePath: string;
  }>;
  files?: Array<{
    path: string;
    language: string;
    lineCount: number;
    sizeBytes: number;
  }>;
  symbols?: Array<{
    name: string;
    kind: string;
    filePath: string;
  }>;
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

    const matchedSymbols: Array<{ name: string; kind: string; filePath: string }> = [];
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
            matchedSymbols.push({
              name: sym.name as string,
              kind: sym.kind as string,
              filePath: sym.file_path as string,
            });
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
        if (!matchedSymbols.some(s => s.name === sym.name && s.filePath === sym.file_path)) {
          matchedSymbols.push({
            name: sym.name as string,
            kind: sym.kind as string,
            filePath: sym.file_path as string,
          });
        }
      }
    }

    // Query files matching the keywords in their paths (realistic addition!)
    const allFiles = this.store.getAllFiles(repo);
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      for (const f of allFiles) {
        if ((f.path as string).toLowerCase().includes(kwLower)) {
          seedFiles.add(f.path as string);
        }
      }
    }

    // Fallback: if no seeds were matched, seed with top 5 PageRank files to provide general codebase entry context
    if (seedFiles.size === 0) {
      const topFiles = this.graph.getRankedFiles().slice(0, 5);
      for (const tf of topFiles) {
        seedFiles.add(tf.path);
      }
    }

    // 2. Graph Expansion (BFS tracking exact shortest path distance)
    const distances = new Map<string, number>();
    for (const sf of seedFiles) {
      distances.set(sf, 0);
    }

    const queue: string[] = Array.from(seedFiles);
    let head = 0;

    while (head < queue.length) {
      const file = queue[head++];
      const currentDepth = distances.get(file)!;
      if (currentDepth >= maxDepth) continue;

      const neighbors = [
        ...this.graph.getDependencies(file).map(d => d.target),
        ...this.graph.getReverseDependencies(file).map(r => r.source)
      ];

      for (const neighbor of neighbors) {
        if (!distances.has(neighbor)) {
          distances.set(neighbor, currentDepth + 1);
          queue.push(neighbor);
        }
      }
    }

    // 3. Rank Candidates by relevance score
    const rankedAll = this.graph.getRankedFiles();
    const rankedMap = new Map<string, number>();
    for (const f of rankedAll) {
      rankedMap.set(f.path, f.pagerank);
    }

    const candidates = Array.from(distances.keys());
    const candidateScores = candidates.map(path => {
      const depth = distances.get(path)!;
      const dbFile = this.store.getFile(path);
      const language = dbFile ? (dbFile.language as string) : 'unknown';

      // Base score on depth (exact path distance from seeds)
      let score = 0;
      if (depth === 0) {
        score += 1000;
      } else if (depth === 1) {
        score += 100;
      } else if (depth === 2) {
        score += 10;
      } else {
        score += 1;
      }

      // Keyword match boost in path
      const pathLower = path.toLowerCase();
      let keywordPathMatches = 0;
      for (const kw of keywords) {
        if (pathLower.includes(kw.toLowerCase())) {
          keywordPathMatches++;
        }
      }
      score += keywordPathMatches * 200;

      // Keyword match boost in symbols
      const fileSyms = this.store.getSymbolsForFile(path);
      let keywordSymbolMatches = 0;
      for (const sym of fileSyms) {
        const symNameLower = (sym.name as string).toLowerCase();
        for (const kw of keywords) {
          if (symNameLower.includes(kw.toLowerCase())) {
            keywordSymbolMatches++;
          }
        }
      }
      score += keywordSymbolMatches * 50;

      // PageRank tie-breaker
      const pr = rankedMap.get(path) || 0;
      score += pr * 20;

      return {
        path,
        language,
        score,
        depth
      };
    });

    // Sort candidates by score descending
    candidateScores.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    // 4. Token-constrained Packaging
    const includedFiles: ContextResult['includedFiles'] = [];
    const excludedFiles: string[] = [];
    let currentTokens = 0;

    for (const cand of candidateScores) {
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

    const simpleFiles = includedFiles.map(f => ({
      path: f.path,
      language: f.language,
      lineCount: f.lineCount,
      sizeBytes: f.sizeBytes
    }));

    return {
      includedFiles,
      excludedFiles,
      edges,
      estimatedTokens: currentTokens,
      matchedSymbols,
      files: simpleFiles,
      symbols: matchedSymbols
    };
  }
}
