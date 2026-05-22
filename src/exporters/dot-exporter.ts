import { Store } from '../core/store.js';
import { MapxGraph } from '../core/graph.js';

export class DotExporter {
  private store: Store;
  private graph: MapxGraph;

  constructor(store: Store, graph: MapxGraph) {
    this.store = store;
    this.graph = graph;
  }

  export(repo?: string, filesFilter?: string[]): string {
    let files = this.store.getAllFiles(repo);
    let edges = this.store.getAllEdges(repo);
    let rankedFiles = this.graph.getRankedFiles();

    if (filesFilter) {
      const allowed = new Set(filesFilter);
      files = files.filter(f => allowed.has(f.path as string));
      edges = edges.filter(e => allowed.has(e.source_file as string) && allowed.has(e.target_file as string));
      rankedFiles = rankedFiles.filter(f => allowed.has(f.path));
    }

    const lines: string[] = [];
    lines.push('digraph Mapx {');
    lines.push('  rankdir=LR;');
    lines.push('  node [shape=box, style=filled];');
    lines.push('');

    const langColors: Record<string, string> = {
      php: '#8892BF',
      javascript: '#F7DF1E',
      typescript: '#3178C6',
      python: '#3776AB',
      go: '#00ADD8',
      rust: '#DEA584',
      java: '#ED8B00',
    };

    const rankMap = new Map(rankedFiles.map(f => [f.path, f.pagerank]));

    for (const file of files) {
      const path = file.path as string;
      const lang = file.language as string;
      const color = langColors[lang] || '#CCCCCC';
      const label = path.split('/').pop() || path;
      lines.push(`  "${path}" [label="${label}", fillcolor="${color}", fontcolor="white"];`);
    }

    lines.push('');

    const edgeStyles: Record<string, string> = {
      import: 'solid',
      require: 'solid',
      extends: 'bold',
      implements: 'dashed',
      call: 'dotted',
      instantiation: 'dotted',
    };

    const seen = new Set<string>();
    for (const edge of edges) {
      const src = edge.source_file as string;
      const tgt = edge.target_file as string;
      const type = edge.edge_type as string;
      const key = `${src}->${tgt}:${type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let style = edgeStyles[type] || 'solid';
      if (edge.verifiability === 'inferred') {
        style = 'dashed';
      }
      lines.push(`  "${src}" -> "${tgt}" [label="${type}", style=${style}];`);
    }

    lines.push('}');
    return lines.join('\n');
  }
}
