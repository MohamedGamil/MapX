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

  export(options?: Partial<ExportOptions>): string {
    const opt = options || {};
    const budget = opt.tokenBudget || 8192;
    const parts: string[] = [];

    let files = this.store.getAllFiles(opt.repo);
    let symbols = this.store.getAllSymbols(opt.repo);
    let edges = this.store.getAllEdges(opt.repo);
    let rankedFiles = this.graph.getRankedFiles();
    let rankedSymbols = this.graph.getRankedSymbols();

    if (opt.files) {
      const allowed = new Set(opt.files);
      files = files.filter(f => allowed.has(f.path as string));
      symbols = symbols.filter(s => allowed.has(s.file_path as string));
      edges = edges.filter(e => allowed.has(e.source_file as string) && allowed.has(e.target_file as string));
      rankedFiles = rankedFiles.filter(f => allowed.has(f.path));
      rankedSymbols = rankedSymbols.filter(s => allowed.has(s.filePath));
    }

    const repoName = opt.repo || 'project';
    parts.push(`# Mapx: ${repoName}`);
    parts.push('');

    const structureSection = this.buildStructureSection(opt.repo);
    if (structureSection) {
      parts.push(structureSection);
    }

    const symsByFile = new Map<string, any[]>();
    for (const s of symbols) {
      const filePath = s.file_path as string;
      if (!symsByFile.has(filePath)) symsByFile.set(filePath, []);
      symsByFile.get(filePath)!.push(s);
    }

    const fileSection = this.buildFileSection(files, rankedFiles, edges, symsByFile);
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

  private buildStructureSection(repo?: string): string {
    const clusters = this.store.getClusters(repo);
    if (clusters.length === 0) return '';

    const lines: string[] = [];
    lines.push('## Structure');

    const roots: any[] = [];
    const childrenMap = new Map<string, any[]>();
    
    for (const c of clusters) {
      if (!c.parent_name) {
        roots.push(c);
      } else {
        const parentName = c.parent_name as string;
        if (!childrenMap.has(parentName)) {
          childrenMap.set(parentName, []);
        }
        childrenMap.get(parentName)!.push(c);
      }
    }

    for (const list of childrenMap.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    roots.sort((a, b) => a.name.localeCompare(b.name));

    const printTree = (node: any, indent: number) => {
      const padding = '  '.repeat(indent);
      const namePart = node.name;
      const sourcePart = `(${node.source})`;
      const filesPart = `[${node.file_count} files]`;
      
      lines.push(`${padding}${namePart} ${sourcePart} ${filesPart}`);

      const children = childrenMap.get(node.name) || [];
      for (const child of children) {
        printTree(child, indent + 1);
      }
    };

    for (const root of roots) {
      printTree(root, 0);
    }

    lines.push('');
    return lines.join('\n');
  }

  private getFileHeuristicSummary(fileSymbols: any[]): string {
    if (!fileSymbols || fileSymbols.length === 0) return 'empty file';

    const counts: Record<string, number> = {};
    for (const s of fileSymbols) {
      const kind = (s.kind as string).toLowerCase();
      counts[kind] = (counts[kind] || 0) + 1;
    }

    // Sort counts by count descending, then kind name
    const sortedKinds = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    
    // Build dominant symbol types description
    const parts: string[] = [];
    for (const [kind, count] of sortedKinds.slice(0, 3)) {
      parts.push(`${count} ${kind}${count > 1 ? (kind.endsWith('s') || kind.endsWith('ch') ? 'es' : 's') : ''}`);
    }

    const dominant = sortedKinds[0] ? sortedKinds[0][0] : '';
    const dominantStr = dominant ? `, dominant: ${dominant}` : '';

    return `contains ${parts.join(', ')}${dominantStr}`;
  }

  private buildFileSection(
    files: Record<string, unknown>[],
    rankedFiles: Array<{ path: string; pagerank: number; language: string }>,
    edges: Record<string, unknown>[],
    symsByFile: Map<string, any[]>
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
      
      const fileSyms = symsByFile.get(path) || [];
      const summary = this.getFileHeuristicSummary(fileSyms);
      
      lines.push(`- ${path} [${lang}] - ${summary}${depStr}`);
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

    const routeGroups = new Map<string, {
      source: string;
      controller: string;
      routes: Array<{ verb: string; uri: string }>;
    }>();

    const otherEdges: Record<string, unknown>[] = [];

    for (const edge of edges) {
      if (edge.edge_type === 'route') {
        const src = edge.source_file as string;
        const controller = (edge.target_symbol as string) || (edge.target_file as string).split('/').pop() || 'Controller';
        const key = `${src}->${controller}`;

        let meta: any = {};
        if (edge.metadata) {
          try {
            meta = typeof edge.metadata === 'string' ? JSON.parse(edge.metadata) : edge.metadata;
          } catch {}
        }

        const verb = meta.httpVerb || 'GET';
        const uri = meta.uri || '/';

        if (!routeGroups.has(key)) {
          routeGroups.set(key, { source: src, controller, routes: [] });
        }
        routeGroups.get(key)!.routes.push({ verb, uri });
      } else {
        otherEdges.push(edge);
      }
    }

    // Output route groups
    for (const group of routeGroups.values()) {
      const uriToVerbs = new Map<string, Set<string>>();
      for (const r of group.routes) {
        if (!uriToVerbs.has(r.uri)) {
          uriToVerbs.set(r.uri, new Set());
        }
        uriToVerbs.get(r.uri)!.add(r.verb);
      }
      const descParts: string[] = [];
      for (const [uri, verbs] of uriToVerbs.entries()) {
        const verbsStr = Array.from(verbs).sort().join('/');
        descParts.push(`${verbsStr} ${uri}`);
      }
      lines.push(`- ${group.source} → ${group.controller} (${group.routes.length} routes: ${descParts.join(', ')})`);
    }

    const unique = new Map<string, { source: string; target: string; type: string; verifiability?: string; targetRepo?: string }>();
    for (const edge of otherEdges) {
      const key = `${edge.source_file}->${edge.target_file}:${edge.edge_type}`;
      if (!unique.has(key)) {
        unique.set(key, {
          source: edge.source_file as string,
          target: edge.target_file as string,
          type: edge.edge_type as string,
          verifiability: edge.verifiability as string || 'verified',
          targetRepo: edge.target_repo as string | undefined,
        });
      }
    }

    for (const dep of unique.values()) {
      const infSuffix = dep.verifiability === 'inferred' ? ' [inferred]' : '';
      const targetRepoSuffix = dep.targetRepo ? ` [repo: ${dep.targetRepo}]` : '';
      lines.push(`- ${dep.source} → ${dep.target}${targetRepoSuffix} (${dep.type})${infSuffix}`);
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
