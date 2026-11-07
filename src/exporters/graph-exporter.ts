import { Store } from '../core/store.js';
import { MapxGraph } from '../core/graph.js';
import { filterClustersToFiles } from './cluster-filter.js';

/** Records a parse keeps for sync (M2-08-R8), large and of no use to a reader of the export. */
const SYNC_RECORDS = ['jvmDecl', 'jvmImports', 'pyImports'];

function publicMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const metadata = JSON.parse(raw as string) as Record<string, unknown>;
  for (const key of SYNC_RECORDS) delete metadata[key];
  return metadata;
}

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

    // A filtered export lists only memberships of exported files and the clusters still holding
    // one (or ancestors of one), as the LLM and TOON exports do (M0-02-R2).
    const allowedFiles = filesFilter ? new Set(filesFilter) : null;
    let memberships = this.store.getClusterMemberships(repo);
    const clusters = filterClustersToFiles(this.store.getClusters(repo), memberships, allowedFiles);
    if (allowedFiles) memberships = memberships.filter(m => allowedFiles.has(m.file_path as string));

    return {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      repo: repo || 'all',
      summary: {
        totalFiles: files.length,
        totalSymbols: symbols.length,
        totalEdges: edges.length,
        languages: this.store.getLanguageBreakdown(repo),
        totalClusters: clusters.length,
      },
      files: files.map(f => ({
        path: f.path,
        language: f.language,
        sizeBytes: f.size_bytes,
        lines: f.lines,
        lastScanned: f.last_scanned,
        metadata: publicMetadata(f.metadata),
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
        metadata: e.metadata ? JSON.parse(e.metadata as string) : undefined,
      })),
      clusters: clusters.map(c => ({
        name: c.name,
        label: c.label,
        source: c.source,
        parentName: c.parent_name || undefined,
        depth: c.depth,
        fileCount: c.file_count,
      })),
      memberships: memberships.map(m => ({
        filePath: m.file_path,
        clusterName: m.cluster_name,
        isPrimary: m.is_primary === 1,
      })),
      graph: graphData,
    };
  }

  exportAsJSONString(repo?: string, filesFilter?: string[]): string {
    return JSON.stringify(this.exportAsJSON(repo, filesFilter), null, 2);
  }
}
