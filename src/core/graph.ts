import Graph from 'graphology';
import pagerank from 'graphology-metrics/centrality/pagerank';
import type { GraphEdge, SymbolKind } from '../types.js';

export class MapxGraph {
  private graph: Graph;
  private repo: string;

  constructor(repo: string) {
    this.repo = repo;
    this.graph = new Graph({ type: 'directed', multi: true });
  }

  addFileNode(filePath: string, language: string, sizeBytes: number, lines: number): void {
    const nodeId = this.fileNodeId(filePath);
    if (!this.graph.hasNode(nodeId)) {
      this.graph.addNode(nodeId, { type: 'file', path: filePath, language, sizeBytes, lines });
    } else {
      this.graph.mergeNodeAttributes(nodeId, { language, sizeBytes, lines });
    }
  }

  addSymbolNode(symbolId: string, filePath: string, name: string, kind: SymbolKind, startLine: number, endLine: number, scope: string | null): void {
    const nodeId = this.symbolNodeId(filePath, symbolId);
    if (!this.graph.hasNode(nodeId)) {
      this.graph.addNode(nodeId, { type: 'symbol', name, kind, filePath, startLine, endLine, scope });
    } else {
      this.graph.mergeNodeAttributes(nodeId, { kind, startLine, endLine, scope });
    }

    const fileNodeId = this.fileNodeId(filePath);
    if (this.graph.hasNode(fileNodeId) && !this.graph.hasEdge(fileNodeId, nodeId)) {
      this.graph.addDirectedEdge(fileNodeId, nodeId, { type: 'contains' });
    }

    if (scope) {
      const parentNodeId = this.symbolNodeId(filePath, scope);
      if (this.graph.hasNode(parentNodeId) && parentNodeId !== nodeId && !this.graph.hasEdge(parentNodeId, nodeId)) {
        this.graph.addDirectedEdge(parentNodeId, nodeId, { type: 'contains' });
      }
    }
  }

  addDependencyEdge(edge: GraphEdge): void {
    const sourceId = this.fileNodeId(edge.sourceFile);
    const targetId = this.fileNodeId(edge.targetFile);

    if (this.graph.hasNode(sourceId) && this.graph.hasNode(targetId)) {
      const edgeKey = `${sourceId}->${targetId}:${edge.edgeType}:${edge.sourceSymbol || ''}`;
      if (!this.graph.hasEdge(edgeKey)) {
        try {
          this.graph.addDirectedEdgeWithKey(edgeKey, sourceId, targetId, {
            type: edge.edgeType,
            sourceSymbol: edge.sourceSymbol,
            targetSymbol: edge.targetSymbol,
            weight: edge.weight,
            verifiability: edge.verifiability || 'verified',
          });
        } catch {
          // edge already exists from different source
        }
      }
    }
  }

  computePageRank(): Map<string, number> {
    try {
      const scores = pagerank(this.graph, { alpha: 0.85 } as any);
      for (const [node, score] of Object.entries(scores)) {
        if (this.graph.hasNode(node)) {
          this.graph.mergeNodeAttributes(node, { pagerank: score });
        }
      }
      return new Map(Object.entries(scores));
    } catch {
      return new Map();
    }
  }

  getRankedFiles(): Array<{ path: string; pagerank: number; language: string }> {
    const scores = this.computePageRank();
    const files: Array<{ path: string; pagerank: number; language: string }> = [];

    for (const [nodeId, score] of scores) {
      const attrs = this.graph.getNodeAttributes(nodeId);
      if (attrs.type === 'file') {
        files.push({ path: attrs.path, pagerank: score, language: attrs.language });
      }
    }

    files.sort((a, b) => b.pagerank - a.pagerank);
    return files;
  }

  getRankedSymbols(): Array<{ name: string; kind: SymbolKind; filePath: string; startLine: number; pagerank: number; scope: string | null }> {
    const fileRank = this.computePageRank();
    const symbols: Array<{ name: string; kind: SymbolKind; filePath: string; startLine: number; pagerank: number; scope: string | null }> = [];

    for (const node of this.graph.nodes()) {
      const attrs = this.graph.getNodeAttributes(node);
      if (attrs.type === 'symbol') {
        const parentFileRank = fileRank.get(this.fileNodeId(attrs.filePath)) || 0;
        const inDegree = this.graph.inDegree(node);
        const symbolRank = parentFileRank * (1 + inDegree * 0.1);
        symbols.push({
          name: attrs.name,
          kind: attrs.kind,
          filePath: attrs.filePath,
          startLine: attrs.startLine,
          pagerank: symbolRank,
          scope: attrs.scope,
        });
      }
    }

    symbols.sort((a, b) => b.pagerank - a.pagerank);
    return symbols;
  }

  getDependencies(filePath: string): Array<{ target: string; type: string }> {
    const nodeId = this.fileNodeId(filePath);
    if (!this.graph.hasNode(nodeId)) return [];

    const deps: Array<{ target: string; type: string }> = [];
    for (const edge of this.graph.outEdges(nodeId)) {
      const attrs = this.graph.getEdgeAttributes(edge);
      if (attrs.type !== 'contains') {
        const target = this.graph.getNodeAttributes(this.graph.target(edge));
        if (target.type === 'file') {
          deps.push({ target: target.path, type: attrs.type });
        }
      }
    }
    return deps;
  }

  getReverseDependencies(filePath: string): Array<{ source: string; type: string }> {
    const nodeId = this.fileNodeId(filePath);
    if (!this.graph.hasNode(nodeId)) return [];

    const rdeps: Array<{ source: string; type: string }> = [];
    for (const edge of this.graph.inEdges(nodeId)) {
      const attrs = this.graph.getEdgeAttributes(edge);
      if (attrs.type !== 'contains') {
        const source = this.graph.getNodeAttributes(this.graph.source(edge));
        if (source.type === 'file') {
          rdeps.push({ source: source.path, type: attrs.type });
        }
      }
    }
    return rdeps;
  }

  getFileCount(): number {
    let count = 0;
    for (const node of this.graph.nodes()) {
      if (this.graph.getNodeAttribute(node, 'type') === 'file') count++;
    }
    return count;
  }

  getSymbolCount(): number {
    let count = 0;
    for (const node of this.graph.nodes()) {
      if (this.graph.getNodeAttribute(node, 'type') === 'symbol') count++;
    }
    return count;
  }

  getEdgeCount(): number {
    let count = 0;
    for (const edge of this.graph.edges()) {
      const attrs = this.graph.getEdgeAttributes(edge);
      if (attrs.type !== 'contains') count++;
    }
    return count;
  }

  toJSON(): object {
    return this.graph.toJSON();
  }

  static fromJSON(data: object, repo: string): MapxGraph {
    const cg = new MapxGraph(repo);
    cg.graph.import(data as any);
    return cg;
  }

  private fileNodeId(filePath: string): string {
    return `file://${filePath}`;
  }

  private symbolNodeId(filePath: string, symbolName: string): string {
    return `symbol://${filePath}::${symbolName}`;
  }
}
