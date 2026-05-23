import { Store } from '../core/store.js';
import { MapxGraph } from '../core/graph.js';
import type { ExportOptions } from '../types.js';

export function toonQuote(value: string, activeDelimiter: ',' | '\t' | '|' = ','): string {
  const needsQuoting =
    value === '' ||
    /^\s|\s$/.test(value) ||
    value === 'true' || value === 'false' || value === 'null' ||
    /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
    /[:"\\\[\]{}\u0000-\u001F\u007F-\u009F]/.test(value) ||
    value === '-' || /^-\S/.test(value) ||
    value.includes(activeDelimiter);

  if (!needsQuoting) return value;

  return '"' + value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '"';
}

export function formatNumber(n: number): string {
  if (Object.is(n, -0)) return '0';
  if (isNaN(n) || !isFinite(n)) return 'null';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e-6 && abs < 1e21) {
    let s = n.toString();
    if (s.includes('e') || s.includes('E')) {
      s = n.toFixed(20).replace(/\.?0+$/, '');
    }
    return s;
  } else {
    return n.toString().toLowerCase();
  }
}

export class ToonExporter {
  private store: Store;
  private graph: MapxGraph;

  constructor(store: Store, graph: MapxGraph) {
    this.store = store;
    this.graph = graph;
  }

  export(options?: Partial<ExportOptions>): string {
    const opt = options || {};
    const budget = opt.tokenBudget || 8192;
    const delimiterName = opt.delimiter || 'comma';
    const delimiterMap = { comma: ',', tab: '\t', pipe: '|' };
    const delim = delimiterMap[delimiterName] as ',' | '\t' | '|';

    // Get raw data
    let files = this.store.getAllFiles(opt.repo);
    let symbols = this.store.getAllSymbols(opt.repo);
    let edges = this.store.getAllEdges(opt.repo);
    const clusters = this.store.getClusters(opt.repo);

    let rankedFiles = this.graph.getRankedFiles();
    let rankedSymbols = this.graph.getRankedSymbols();

    // Filter by allowed files if specified
    if (opt.files) {
      const allowed = new Set(opt.files);
      files = files.filter(f => allowed.has(f.path as string));
      symbols = symbols.filter(s => allowed.has(s.file_path as string));
      edges = edges.filter(e => allowed.has(e.source_file as string) && allowed.has(e.target_file as string));
      rankedFiles = rankedFiles.filter(f => allowed.has(f.path));
      rankedSymbols = rankedSymbols.filter(s => allowed.has(s.filePath));
    }

    // Binary search over symbols and edges to fit token budget
    let low = 0;
    let high = symbols.length;
    let bestOutput = '';
    
    // Sort symbols by PageRank descending
    const sortedSymbols = [...symbols].sort((a, b) => {
      const rankA = rankedSymbols.find(rs => rs.name === a.name && rs.filePath === a.file_path)?.pagerank || 0;
      const rankB = rankedSymbols.find(rs => rs.name === b.name && rs.filePath === b.file_path)?.pagerank || 0;
      return rankB - rankA;
    });

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const output = this.generateDocument({
        opt,
        delim,
        files,
        rankedFiles,
        symbols: sortedSymbols.slice(0, mid),
        rankedSymbols,
        edges,
        clusters,
        isTruncated: mid < symbols.length,
        truncatedCount: symbols.length - mid,
        originalSymbolsCount: symbols.length,
      });

      const estimatedTokens = Math.ceil(Buffer.byteLength(output, 'utf8') / 4);
      if (estimatedTokens <= budget) {
        bestOutput = output;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    // If even 0 symbols exceeds budget, try truncating edges as well
    if (!bestOutput || Math.ceil(Buffer.byteLength(bestOutput, 'utf8') / 4) > budget) {
      let lowEdge = 0;
      let highEdge = edges.length;
      let bestEdgeOutput = '';

      while (lowEdge <= highEdge) {
        const midEdge = Math.floor((lowEdge + highEdge) / 2);
        const output = this.generateDocument({
          opt,
          delim,
          files,
          rankedFiles,
          symbols: [],
          rankedSymbols,
          edges: edges.slice(0, midEdge),
          clusters,
          isTruncated: true,
          truncatedCount: symbols.length,
          originalSymbolsCount: symbols.length,
          isEdgesTruncated: midEdge < edges.length,
          edgesTruncatedCount: edges.length - midEdge,
        });

        const estimatedTokens = Math.ceil(Buffer.byteLength(output, 'utf8') / 4);
        if (estimatedTokens <= budget) {
          bestEdgeOutput = output;
          lowEdge = midEdge + 1;
        } else {
          highEdge = midEdge - 1;
        }
      }

      if (bestEdgeOutput) {
        bestOutput = bestEdgeOutput;
      } else {
        // Fallback: just return the minimum possible document (0 files, 0 symbols, 0 edges)
        bestOutput = this.generateDocument({
          opt,
          delim,
          files: [],
          rankedFiles: [],
          symbols: [],
          rankedSymbols: [],
          edges: [],
          clusters: [],
          isTruncated: true,
          truncatedCount: symbols.length,
          originalSymbolsCount: symbols.length,
        });
      }
    }

    // Enforce no trailing newline at the document level
    return bestOutput.endsWith('\n') ? bestOutput.slice(0, -1) : bestOutput;
  }

  private generateDocument(params: {
    opt: Partial<ExportOptions>;
    delim: ',' | '\t' | '|';
    files: Record<string, unknown>[];
    rankedFiles: Array<{ path: string; pagerank: number; language: string }>;
    symbols: Record<string, unknown>[];
    rankedSymbols: Array<{ name: string; filePath: string; pagerank: number }>;
    edges: Record<string, unknown>[];
    clusters: Record<string, unknown>[];
    isTruncated: boolean;
    truncatedCount: number;
    originalSymbolsCount: number;
    isEdgesTruncated?: boolean;
    edgesTruncatedCount?: number;
  }): string {
    const {
      opt,
      delim,
      files,
      rankedFiles,
      symbols,
      rankedSymbols,
      edges,
      clusters,
      isTruncated,
      truncatedCount,
      originalSymbolsCount,
      isEdgesTruncated,
      edgesTruncatedCount,
    } = params;

    const parts: string[] = [];

    // Root document properties
    parts.push('version: 1');
    parts.push(`generated: ${new Date().toISOString()}`);
    parts.push(`repo: ${opt.repo || 'all'}`);
    parts.push(`tokenBudget: ${opt.tokenBudget || 8192}`);
    parts.push('');

    // Summary block
    parts.push('summary:');
    parts.push(`  files: ${files.length}`);
    parts.push(`  symbols: ${originalSymbolsCount}`);
    parts.push(`  edges: ${edges.length}`);

    const languages = Array.from(new Set(files.map(f => f.language as string))).filter(Boolean).sort();
    if (languages.length > 0) {
      const escapedLangs = languages.map(l => toonQuote(l, delim)).join(delim);
      parts.push(`  languages[${languages.length}]: ${escapedLangs}`);
    }
    parts.push('');

    // Maps for ranking lookup
    const fileRankMap = new Map(rankedFiles.map(f => [f.path, f.pagerank]));
    const symbolRankMap = new Map(rankedSymbols.map(s => [`${s.filePath}::${s.name}`, s.pagerank]));

    // 1. files tabular array
    if (files.length > 0) {
      // Sort files by PageRank descending
      const sortedFiles = [...files].sort((a, b) => {
        const rA = fileRankMap.get(a.path as string) || 0;
        const rB = fileRankMap.get(b.path as string) || 0;
        return rB - rA;
      });

      parts.push(`files[${files.length}]{path,language,symbols,pagerank}:`);
      for (const f of sortedFiles) {
        const path = toonQuote(f.path as string, delim);
        const language = toonQuote(f.language as string, delim);
        const symbolsCount = f.lines ? this.store.getSymbolsForFile(f.path as string).length : 0;
        const rank = formatNumber(parseFloat((fileRankMap.get(f.path as string) || 0).toFixed(6)));
        parts.push(`  ${path}${delim}${language}${delim}${symbolsCount}${delim}${rank}`);
      }
      parts.push('');
    }

    // 2. symbols tabular array
    if (symbols.length > 0) {
      parts.push(`symbols[${symbols.length}]{name,kind,file,scope,pagerank}:`);
      for (const s of symbols) {
        const name = toonQuote(s.name as string, delim);
        const kind = toonQuote(s.kind as string, delim);
        const file = toonQuote(s.file_path as string, delim);
        const scope = toonQuote((s.scope as string) || '', delim);
        const rankKey = `${s.file_path}::${s.name}`;
        const rank = formatNumber(parseFloat((symbolRankMap.get(rankKey) || 0).toFixed(6)));
        parts.push(`  ${name}${delim}${kind}${delim}${file}${delim}${scope}${delim}${rank}`);
      }
      parts.push('');
    }

    // 3. edges tabular array
    // Filter edges so they only refer to kept symbols (or files)
    const keptSymbolsSet = new Set(symbols.map(s => `${s.file_path}::${s.name}`));
    const filteredEdges = edges.filter(e => {
      if (e.source_symbol) {
        const srcKey = `${e.source_file}::${e.source_symbol}`;
        if (!keptSymbolsSet.has(srcKey)) return false;
      }
      if (e.target_symbol) {
        const tgtKey = `${e.target_file}::${e.target_symbol}`;
        if (!keptSymbolsSet.has(tgtKey)) return false;
      }
      return true;
    });

    if (filteredEdges.length > 0) {
      parts.push(`edges[${filteredEdges.length}]{sourceFile,targetFile,edgeType,sourceSymbol,targetSymbol,weight}:`);
      for (const e of filteredEdges) {
        const sourceFile = toonQuote(e.source_file as string, delim);
        const targetFile = toonQuote((e.target_file as string) || '', delim);
        const edgeType = toonQuote(e.edge_type as string, delim);
        const sourceSymbol = toonQuote((e.source_symbol as string) || '', delim);
        const targetSymbol = toonQuote((e.target_symbol as string) || '', delim);
        const weight = formatNumber(e.weight as number || 1);
        parts.push(`  ${sourceFile}${delim}${targetFile}${delim}${edgeType}${delim}${sourceSymbol}${delim}${targetSymbol}${delim}${weight}`);
      }
      parts.push('');
    }

    // 4. clusters tabular array
    if (clusters.length > 0) {
      parts.push(`clusters[${clusters.length}]{name,source,parentName,depth,fileCount}:`);
      for (const c of clusters) {
        const name = toonQuote(c.name as string, delim);
        const source = toonQuote(c.source as string, delim);
        const parentName = toonQuote((c.parent_name as string) || '', delim);
        const depth = formatNumber(c.depth as number || 0);
        const fileCount = formatNumber(c.file_count as number || 0);
        parts.push(`  ${name}${delim}${source}${delim}${parentName}${delim}${depth}${delim}${fileCount}`);
      }
      parts.push('');
    }

    // Truncation footer block
    if (isTruncated) {
      parts.push('truncated: true');
      parts.push('truncatedAt: symbols');
      parts.push(`includedSymbols: ${symbols.length}`);
      parts.push(`totalSymbols: ${originalSymbolsCount}`);
      if (isEdgesTruncated) {
        parts.push('edgesTruncated: true');
        parts.push(`includedEdges: ${filteredEdges.length}`);
        parts.push(`totalEdges: ${edges.length}`);
      }
    }

    return parts.join('\n');
  }
}
