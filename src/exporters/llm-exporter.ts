import { Store } from '../core/store.js';
import { MapxGraph } from '../core/graph.js';
import type { ExportOptions } from '../types.js';

const TOKEN_CHARS_PER_LINE = 4;

export class LLMExporter {
  private store: Store;
  private graph: MapxGraph;

  constructor(store: Store, graph: MapxGraph) {
    this.store = store;
    this.graph = graph;
  }

  export(options: ExportOptions): string {
    const budget = options.tokenBudget || 8192;
    const parts: string[] = [];

    let files = this.store.getAllFiles(options.repo);
    let symbols = this.store.getAllSymbols(options.repo);
    let edges = this.store.getAllEdges(options.repo);
    let rankedFiles = this.graph.getRankedFiles();
    let rankedSymbols = this.graph.getRankedSymbols();

    if (options.files) {
      const allowed = new Set(options.files);
      files = files.filter(f => allowed.has(f.path as string));
      symbols = symbols.filter(s => allowed.has(s.file_path as string));
      edges = edges.filter(e => allowed.has(e.source_file as string) && allowed.has(e.target_file as string));
      rankedFiles = rankedFiles.filter(f => allowed.has(f.path));
      rankedSymbols = rankedSymbols.filter(s => allowed.has(s.filePath));
    }

    const repoName = options.repo || 'project';
    parts.push(`# Mapx: ${repoName}`);
    parts.push('');

    const fileSection = this.buildFileSection(files, rankedFiles, edges);
    parts.push(fileSection);

    const symbolSection = this.buildSymbolSection(rankedSymbols, budget);
    parts.push(symbolSection);

    if (edges.length > 0) {
      const depSection = this.buildDependencySection(edges);
      parts.push(depSection);
    }

    let result = parts.join('\n');

    const estimatedTokens = Math.ceil(result.length / TOKEN_CHARS_PER_LINE);
    if (estimatedTokens > budget) {
      result = this.truncateToFit(result, budget);
    }

    return result;
  }

  private buildFileSection(
    files: Record<string, unknown>[],
    rankedFiles: Array<{ path: string; pagerank: number; language: string }>,
    edges: Record<string, unknown>[]
  ): string {
    const lines: string[] = [];
    lines.push(`## Files (${files.length})`);

    const rankMap = new Map(rankedFiles.map(f => [f.path, f.pagerank]));
    const depMap = new Map<string, string[]>();
    for (const edge of edges) {
      const src = edge.source_file as string;
      const tgt = edge.target_file as string;
      const type = edge.edge_type as string;
      if (!depMap.has(src)) depMap.set(src, []);
      const infSuffix = edge.verifiability === 'inferred' ? ' [inferred]' : '';
      depMap.get(src)!.push(`${tgt} (${type})${infSuffix}`);
    }

    const sorted = [...files].sort((a, b) => {
      const ra = rankMap.get(a.path as string) || 0;
      const rb = rankMap.get(b.path as string) || 0;
      return rb - ra;
    });

    for (const file of sorted) {
      const path = file.path as string;
      const lang = file.language as string;
      const deps = depMap.get(path);
      const depStr = deps ? ` → ${deps.join(', ')}` : '';
      lines.push(`- ${path} [${lang}]${depStr}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  private buildSymbolSection(
    rankedSymbols: Array<{
      name: string;
      kind: string;
      filePath: string;
      startLine: number;
      pagerank: number;
      scope: string | null;
    }>,
    budget: number
  ): string {
    const lines: string[] = [];
    lines.push(`## Symbols (${rankedSymbols.length})`);

    const byFile = new Map<string, typeof rankedSymbols>();
    for (const sym of rankedSymbols) {
      if (!byFile.has(sym.filePath)) byFile.set(sym.filePath, []);
      byFile.get(sym.filePath)!.push(sym);
    }

    const dbSymbols = this.store.getAllSymbols();
    const sigMap = new Map<string, string>();
    for (const s of dbSymbols) {
      const key = `${s.file_path}::${s.name}`;
      sigMap.set(key, s.signature as string);
    }

    const maxLines = Math.floor(budget * TOKEN_CHARS_PER_LINE / 40);
    let lineCount = 0;

    for (const [filePath, syms] of byFile) {
      if (lineCount > maxLines) break;

      const topLevel = syms.filter(s => !s.scope);
      for (const sym of topLevel) {
        if (lineCount > maxLines) break;

        const sig = sigMap.get(`${sym.filePath}::${sym.name}`) || sym.name;
        lines.push(`- ${sym.kind} ${sig} @ ${sym.filePath}:${sym.startLine}`);

        const children = syms.filter(s => s.scope === sym.name);
        for (const child of children) {
          if (lineCount > maxLines) break;
          const childSig = sigMap.get(`${child.filePath}::${child.name}`) || child.name;
          lines.push(`  - ${child.kind} ${childSig} @ :${child.startLine}`);
          lineCount++;
        }

        lineCount++;
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  private buildDependencySection(edges: Record<string, unknown>[]): string {
    const lines: string[] = [];
    lines.push('## Dependencies');

    const unique = new Map<string, { source: string; target: string; type: string; verifiability?: string }>();
    for (const edge of edges) {
      const key = `${edge.source_file}->${edge.target_file}:${edge.edge_type}`;
      if (!unique.has(key)) {
        unique.set(key, {
          source: edge.source_file as string,
          target: edge.target_file as string,
          type: edge.edge_type as string,
          verifiability: edge.verifiability as string || 'verified',
        });
      }
    }

    for (const dep of unique.values()) {
      const infSuffix = dep.verifiability === 'inferred' ? ' [inferred]' : '';
      lines.push(`- ${dep.source} → ${dep.target} (${dep.type})${infSuffix}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  private truncateToFit(output: string, budget: number): string {
    const maxChars = budget * TOKEN_CHARS_PER_LINE;
    if (output.length <= maxChars) return output;

    const truncated = output.substring(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    return truncated.substring(0, lastNewline) + '\n\n[... truncated to fit token budget]\n';
  }
}
