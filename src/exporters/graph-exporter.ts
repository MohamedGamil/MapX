import { Store } from '../core/store.js';
import { MapxGraph } from '../core/graph.js';

export class GraphExporter {
  private store: Store;
  private graph: MapxGraph;

  constructor(store: Store, graph: MapxGraph) {
    this.store = store;
    this.graph = graph;
  }

  exportAsJSON(repo?: string, filesFilter?: string[]): object {
    let files = this.store.getAllFiles(repo);
    let symbols = this.store.getAllSymbols(repo);
    let edges = this.store.getAllEdges(repo);

    if (filesFilter) {
      const allowed = new Set(filesFilter);
      files = files.filter(f => allowed.has(f.path as string));
      symbols = symbols.filter(s => allowed.has(s.file_path as string));
      edges = edges.filter(e => allowed.has(e.source_file as string) && allowed.has(e.target_file as string));
    }

    // Filter the graph object in memory or just filter its nodes/edges before serializing
    const graphData = this.graph.toJSON() as any;
    if (filesFilter) {
      const allowed = new Set(filesFilter);
      graphData.nodes = graphData.nodes.filter((n: any) => allowed.has(n.key));
      graphData.edges = graphData.edges.filter((e: any) => allowed.has(e.source) && allowed.has(e.target));
    }

    return {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      repo: repo || 'all',
      summary: {
        totalFiles: files.length,
        totalSymbols: symbols.length,
        totalEdges: edges.length,
        languages: this.store.getLanguageBreakdown(repo),
      },
      files: files.map(f => ({
        path: f.path,
        language: f.language,
        sizeBytes: f.size_bytes,
        lines: f.lines,
        lastScanned: f.last_scanned,
      })),
      symbols: symbols.map(s => ({
        name: s.name,
        kind: s.kind,
        scope: s.scope || undefined,
        signature: s.signature,
        file: s.file_path,
        line: s.start_line,
        endLine: s.end_line,
      })),
      edges: edges.map(e => ({
        source: e.source_file,
        target: e.target_file,
        type: e.edge_type,
        sourceSymbol: e.source_symbol || undefined,
        targetSymbol: e.target_symbol || undefined,
        verifiability: e.verifiability || 'verified',
      })),
      graph: graphData,
    };
  }

  exportAsJSONString(repo?: string, filesFilter?: string[]): string {
    return JSON.stringify(this.exportAsJSON(repo, filesFilter), null, 2);
  }
}
