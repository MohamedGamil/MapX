import { Store } from '../core/store.js';
import { MapxGraph } from '../core/graph.js';

export class DotExporter {
  private store: Store;
  private graph: MapxGraph;

  constructor(store: Store, graph: MapxGraph) {
    this.store = store;
    this.graph = graph;
  }

  export(repo?: string, filesFilter?: string[], opts?: { cluster?: 'none' | 'auto'; depth?: number }): string {
    const clusterMode = opts?.cluster ?? 'none';
    const maxClusterDepth = opts?.depth ?? Infinity;
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
    lines.push('  newrank=true;');
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

    const clusters = this.store.getClusters(repo);
    const memberships = this.store.getClusterMemberships(repo);
    const primaryMemberships = new Map<string, string>();
    for (const m of memberships) {
      if (m.is_primary === 1) {
        primaryMemberships.set(m.file_path as string, m.cluster_name as string);
      }
    }

    const roots: any[] = [];
    const childrenMap = new Map<string, any[]>();
    const clusterFilesMap = new Map<string, string[]>();

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

    for (const file of files) {
      const path = file.path as string;
      const clusterName = primaryMemberships.get(path);
      if (clusterName) {
        if (!clusterFilesMap.has(clusterName)) {
          clusterFilesMap.set(clusterName, []);
        }
        clusterFilesMap.get(clusterName)!.push(path);
      }
    }

    const outputCluster = (node: any, indent: number, currentDepth: number): string[] => {
      const pad = '  '.repeat(indent);
      const subLines: string[] = [];
      const safeId = 'cluster_' + node.name.replace(/[^a-zA-Z0-9]/g, '_');
      subLines.push(`${pad}subgraph "${safeId}" {`);
      subLines.push(`${pad}  label="${node.label}";`);
      subLines.push(`${pad}  color=gray;`);
      subLines.push(`${pad}  style=dashed;`);

      const fList = clusterFilesMap.get(node.name) || [];
      for (const f of fList) {
        const lang = files.find(file => file.path === f)?.language as string;
        const color = langColors[lang] || '#CCCCCC';
        const label = f.split('/').pop() || f;
        subLines.push(`${pad}  "${f}" [label="${label}", fillcolor="${color}", fontcolor="white"];`);
      }

      const children = childrenMap.get(node.name) || [];
      if (currentDepth < maxClusterDepth) {
        for (const child of children) {
          subLines.push(...outputCluster(child, indent + 1, currentDepth + 1));
        }
      } else {
        // Flatten children files into this cluster when max depth reached
        const flattenFiles = (c: any) => {
          const fList2 = clusterFilesMap.get(c.name) || [];
          for (const f2 of fList2) {
            const lang2 = files.find(file => file.path === f2)?.language as string;
            const color2 = langColors[lang2] || '#CCCCCC';
            const label2 = f2.split('/').pop() || f2;
            subLines.push(`${pad}  "${f2}" [label="${label2}", fillcolor="${color2}", fontcolor="white"];`);
          }
          for (const gc of (childrenMap.get(c.name) || [])) {
            flattenFiles(gc);
          }
        };
        for (const child of children) {
          flattenFiles(child);
        }
      }

      subLines.push(`${pad}}`);
      return subLines;
    };

    if (clusterMode === 'none') {
      // Flat rendering — all files as top-level nodes
      for (const file of files) {
        const path = file.path as string;
        const lang = file.language as string;
        const color = langColors[lang] || '#CCCCCC';
        const label = path.split('/').pop() || path;
        lines.push(`  "${path}" [label="${label}", fillcolor="${color}", fontcolor="white"];`);
      }
    } else {
      // Clustered rendering
      for (const file of files) {
        const path = file.path as string;
        if (!primaryMemberships.has(path)) {
          const lang = file.language as string;
          const color = langColors[lang] || '#CCCCCC';
          const label = path.split('/').pop() || path;
          lines.push(`  "${path}" [label="${label}", fillcolor="${color}", fontcolor="white"];`);
        }
      }

      for (const root of roots) {
        lines.push(...outputCluster(root, 1, 1));
      }
    }

    lines.push('');

    const edgeStyles: Record<string, string> = {
      import: 'solid',
      require: 'solid',
      extends: 'bold',
      implements: 'dashed',
      call: 'dotted',
      instantiation: 'dotted',
      relation: 'bold',
      route: 'solid',
      binding: 'dashed',
      middleware: 'dotted',
      dispatch: 'dashed',
      notify: 'dotted',
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
      let colorAttr = '';
      if (type === 'relation') {
        colorAttr = ', color="blue"';
      } else if (type === 'route') {
        colorAttr = ', color="green"';
      } else if (type === 'binding') {
        colorAttr = ', color="purple"';
      } else if (type === 'middleware') {
        colorAttr = ', color="orange"';
      } else if (type === 'dispatch') {
        colorAttr = ', color="magenta"';
      } else if (type === 'notify') {
        colorAttr = ', color="pink"';
      }
      lines.push(`  "${src}" -> "${tgt}" [label="${type}", style=${style}${colorAttr}];`);
    }

    lines.push('}');
    return lines.join('\n');
  }
}
