import { Store } from './store.js';
import { ReferenceType } from '../types.js';

export type TraceDirection = 'down' | 'up' | 'both';

export interface TraceOptions {
  startSymbol?: string;
  startFile?: string;
  direction: TraceDirection;
  maxDepth: number;
  edgeTypes?: ReferenceType[];
  includeStructural: boolean;
  repo?: string;
}

export interface TraceNode {
  file: string;
  symbol: string | null;
  depth: number;
  incomingEdgeType: ReferenceType | 'start';
}

export interface TracePath {
  nodes: TraceNode[];
  cycles: CyclicEdge[];
}

export interface CyclicEdge {
  fromFile: string;
  fromSymbol: string | null;
  toFile: string;
  toSymbol: string | null;
  edgeType: ReferenceType;
  cycleLength: number;
}

export interface TraceResult {
  start: { file: string; symbol: string | null };
  direction: TraceDirection;
  paths: TracePath[];
  sources: TraceNode[];
  sinks: TraceNode[];
  cycles: CyclicEdge[];
  nodeCount: number;
  edgeCount: number;
  maxDepthReached: boolean;
}

const DATA_BEARING_EDGES: string[] = [
  'call',
  'instantiation',
  'param_type',
  'return_type',
  'relation',
  'dispatch',
  'notify',
  'route'
];

const STRUCTURAL_EDGES: string[] = [
  'import',
  'require',
  'extends',
  'implements',
  'binding',
  'middleware'
];

function matchesSymbol(nodeSymbol: string | null, edgeSymbol: string | null): boolean {
  if (!nodeSymbol) return true;
  if (!edgeSymbol) return true;
  if (nodeSymbol === edgeSymbol) return true;
  if (nodeSymbol.includes('::')) {
    const [, name] = nodeSymbol.split('::');
    if (edgeSymbol === name) return true;
  }
  return false;
}

export class FlowTracer {
  constructor(private store: Store) {}

  trace(options: TraceOptions): TraceResult {
    const repo = options.repo;
    const direction = options.direction;
    const maxDepth = options.maxDepth ?? 6;

    let startFile = options.startFile;
    let startSymbol = options.startSymbol;

    if (!startFile && startSymbol) {
      const resolved = this.resolveStart(startSymbol, repo);
      if (resolved) {
        startFile = resolved.file;
        startSymbol = resolved.symbol ?? undefined;
      }
    } else if (startFile && !startSymbol) {
      const resolved = this.resolveStart(startFile, repo);
      if (resolved) {
        startFile = resolved.file;
        startSymbol = resolved.symbol ?? undefined;
      }
    }

    if (!startFile) {
      throw new Error(`Could not resolve starting file or symbol: ${options.startFile || options.startSymbol}`);
    }

    const startNode: TraceNode = {
      file: startFile,
      symbol: startSymbol || null,
      depth: 0,
      incomingEdgeType: 'start',
    };

    if (direction === 'both') {
      const downRes = this.trace({ ...options, direction: 'down', startFile, startSymbol });
      const upRes = this.trace({ ...options, direction: 'up', startFile, startSymbol });

      const uniqueNodesMap = new Map<string, TraceNode>();
      const addNode = (n: TraceNode) => {
        const key = `${n.file}::${n.symbol || ''}`;
        if (!uniqueNodesMap.has(key) || uniqueNodesMap.get(key)!.depth > n.depth) {
          uniqueNodesMap.set(key, n);
        }
      };

      for (const p of [...downRes.paths, ...upRes.paths]) {
        for (const n of p.nodes) addNode(n);
      }

      const mergedCycles = [...downRes.cycles, ...upRes.cycles];
      const mergedSources = [...downRes.sources, ...upRes.sources];
      const mergedSinks = [...downRes.sinks, ...upRes.sinks];

      return {
        start: { file: startFile, symbol: startSymbol || null },
        direction: 'both',
        paths: [...downRes.paths, ...upRes.paths],
        sources: Array.from(new Map(mergedSources.map(n => [`${n.file}::${n.symbol || ''}`, n])).values()),
        sinks: Array.from(new Map(mergedSinks.map(n => [`${n.file}::${n.symbol || ''}`, n])).values()),
        cycles: Array.from(new Map(mergedCycles.map(c => [`${c.fromFile}->${c.toFile}`, c])).values()),
        nodeCount: uniqueNodesMap.size,
        edgeCount: downRes.edgeCount + upRes.edgeCount,
        maxDepthReached: downRes.maxDepthReached || upRes.maxDepthReached,
      };
    }

    const allPaths: TracePath[] = [];
    const detectedCycles: CyclicEdge[] = [];
    const stack: TraceNode[] = [startNode];
    const stackKeys = new Set<string>([`${startFile}::${startSymbol || ''}`]);
    const uniqueVisited = new Set<string>([`${startFile}::${startSymbol || ''}`]);
    let maxDepthReached = false;

    const getPathKey = (file: string, symbol: string | null) => `${file}::${symbol || ''}`;

    const dfs = (current: TraceNode) => {
      const edges = this.getEdgesForNode(current, direction, options.includeStructural, repo);
      let hasValidSteps = false;
      const validNextEdges = [];

      for (const edge of edges) {
        const nextFile = direction === 'up' ? edge.source_file as string : edge.target_file as string;
        const nextSymbolName = direction === 'up' ? edge.source_symbol as string : edge.target_symbol as string;
        const nextSymbol = this.getScopedSymbolName(nextFile, nextSymbolName, repo);
        const nextKey = getPathKey(nextFile, nextSymbol);

        if (stackKeys.has(nextKey)) {
          const ancestorIndex = stack.findIndex(n => getPathKey(n.file, n.symbol) === nextKey);
          const cycleLength = stack.length - ancestorIndex;
          detectedCycles.push({
            fromFile: current.file,
            fromSymbol: current.symbol,
            toFile: nextFile,
            toSymbol: nextSymbol,
            edgeType: edge.edge_type as any,
            cycleLength,
          });
        } else {
          hasValidSteps = true;
          validNextEdges.push({ edge, nextFile, nextSymbol, nextKey });
        }
      }

      if (!hasValidSteps || current.depth >= maxDepth) {
        allPaths.push({
          nodes: [...stack],
          cycles: [],
        });
        if (current.depth >= maxDepth && hasValidSteps) {
          maxDepthReached = true;
        }
        return;
      }

      for (const next of validNextEdges) {
        if (uniqueVisited.has(next.nextKey)) {
          continue;
        }

        const nextNode: TraceNode = {
          file: next.nextFile,
          symbol: next.nextSymbol,
          depth: current.depth + 1,
          incomingEdgeType: next.edge.edge_type as any,
        };

        stack.push(nextNode);
        stackKeys.add(next.nextKey);
        uniqueVisited.add(next.nextKey);

        dfs(nextNode);

        stack.pop();
        stackKeys.delete(next.nextKey);
      }
    };

    dfs(startNode);

    // Compute unique trace nodes and edges for statistics
    const uniqueNodes = new Set<string>();
    const traceEdges = new Set<string>();
    for (const p of allPaths) {
      for (let i = 0; i < p.nodes.length; i++) {
        uniqueNodes.add(`${p.nodes[i].file}::${p.nodes[i].symbol || ''}`);
        if (i > 0) {
          const from = direction === 'up' ? p.nodes[i].file : p.nodes[i - 1].file;
          const to = direction === 'up' ? p.nodes[i - 1].file : p.nodes[i].file;
          traceEdges.add(`${from}->${to}`);
        }
      }
    }

    // Identify sources and sinks within the traced nodes
    const traceSources: TraceNode[] = [];
    const traceSinks: TraceNode[] = [];

    for (const key of uniqueNodes) {
      const [file, symbol] = key.split('::');
      const nodeSym = symbol || null;
      const node: TraceNode = { file, symbol: nodeSym, depth: 0, incomingEdgeType: 'start' };

      const outEdges = this.getEdgesForNode(node, 'down', options.includeStructural, repo);
      const inEdges = this.getEdgesForNode(node, 'up', options.includeStructural, repo);

      if (inEdges.length === 0) {
        traceSources.push(node);
      }
      if (outEdges.length === 0) {
        traceSinks.push(node);
      }
    }

    return {
      start: { file: startFile, symbol: startSymbol || null },
      direction,
      paths: allPaths,
      sources: traceSources,
      sinks: traceSinks,
      cycles: detectedCycles,
      nodeCount: uniqueNodes.size,
      edgeCount: traceEdges.size,
      maxDepthReached,
    };
  }

  resolveStart(input: string, repo?: string): { file: string; symbol: string | null } | null {
    const allFiles = this.store.getAllFiles(repo);
    const matchedFile = allFiles.find(f => f.path === input || (f.path as string).endsWith(input));
    if (matchedFile) {
      return { file: matchedFile.path as string, symbol: null };
    }

    let scope: string | null = null;
    let name = input;
    if (input.includes('::')) {
      const parts = input.split('::');
      scope = parts[0];
      name = parts[1];
    }

    const allSymbols = this.store.getAllSymbols(repo);
    let matchedSymbol: any = null;
    if (scope) {
      matchedSymbol = allSymbols.find(s => s.name === name && s.scope === scope);
    } else {
      matchedSymbol = allSymbols.find(s => s.name === name || s.scope === name);
    }

    if (matchedSymbol) {
      return {
        file: matchedSymbol.file_path as string,
        symbol: matchedSymbol.scope ? `${matchedSymbol.scope}::${matchedSymbol.name}` : matchedSymbol.name as string,
      };
    }

    return null;
  }

  findSources(repo?: string): TraceNode[] {
    const files = this.store.getAllFiles(repo);
    const edges = this.store.getAllEdges(repo);
    const filePaths = new Set<string>(files.map(f => f.path as string));
    for (const e of edges) {
      filePaths.add(e.source_file as string);
      filePaths.add(e.target_file as string);
    }

    const dataEdges = edges.filter(e => DATA_BEARING_EDGES.includes(e.edge_type as string));

    const incomingCount = new Map<string, number>();
    const outgoingCount = new Map<string, number>();

    for (const p of filePaths) {
      incomingCount.set(p, 0);
      outgoingCount.set(p, 0);
    }

    for (const e of dataEdges) {
      const src = e.source_file as string;
      const tgt = e.target_file as string;
      outgoingCount.set(src, (outgoingCount.get(src) || 0) + 1);
      incomingCount.set(tgt, (incomingCount.get(tgt) || 0) + 1);
    }

    const sources: TraceNode[] = [];
    for (const p of filePaths) {
      const inc = incomingCount.get(p) || 0;
      const out = outgoingCount.get(p) || 0;
      if (inc === 0 && out > 0) {
        sources.push({
          file: p,
          symbol: null,
          depth: 0,
          incomingEdgeType: 'start',
        });
      }
    }
    return sources;
  }

  findSinks(repo?: string): TraceNode[] {
    const files = this.store.getAllFiles(repo);
    const edges = this.store.getAllEdges(repo);
    const filePaths = new Set<string>(files.map(f => f.path as string));
    for (const e of edges) {
      filePaths.add(e.source_file as string);
      filePaths.add(e.target_file as string);
    }

    const dataEdges = edges.filter(e => DATA_BEARING_EDGES.includes(e.edge_type as string));

    const incomingCount = new Map<string, number>();
    const outgoingCount = new Map<string, number>();

    for (const p of filePaths) {
      incomingCount.set(p, 0);
      outgoingCount.set(p, 0);
    }

    for (const e of dataEdges) {
      const src = e.source_file as string;
      const tgt = e.target_file as string;
      outgoingCount.set(src, (outgoingCount.get(src) || 0) + 1);
      incomingCount.set(tgt, (incomingCount.get(tgt) || 0) + 1);
    }

    const sinks: TraceNode[] = [];
    for (const p of filePaths) {
      const inc = incomingCount.get(p) || 0;
      const out = outgoingCount.get(p) || 0;
      if (out === 0 && inc > 0) {
        sinks.push({
          file: p,
          symbol: null,
          depth: 0,
          incomingEdgeType: 'start',
        });
      }
    }
    return sinks;
  }

  findCriticalPath(from: string, to: string, repo?: string): TracePath | null {
    const startNode = this.resolveStart(from, repo);
    if (!startNode) return null;

    const targetNode = this.resolveStart(to, repo);
    if (!targetNode) return null;

    const getPathKey = (file: string, symbol: string | null) => `${file}::${symbol || ''}`;
    const targetKey = getPathKey(targetNode.file, targetNode.symbol);

    const queue: Array<{ node: TraceNode; path: TraceNode[] }> = [
      { node: { file: startNode.file, symbol: startNode.symbol, depth: 0, incomingEdgeType: 'start' }, path: [{ file: startNode.file, symbol: startNode.symbol, depth: 0, incomingEdgeType: 'start' }] }
    ];
    const visited = new Set<string>([getPathKey(startNode.file, startNode.symbol)]);

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;
      const currentKey = getPathKey(node.file, node.symbol);

      if (currentKey === targetKey) {
        return {
          nodes: path,
          cycles: [],
        };
      }

      const edges = this.getEdgesForNode(node, 'down', false, repo);
      for (const edge of edges) {
        const nextFile = edge.target_file as string;
        const nextSymbolName = edge.target_symbol as string;
        const nextSymbol = this.getScopedSymbolName(nextFile, nextSymbolName, repo);
        const nextKey = getPathKey(nextFile, nextSymbol);

        if (!visited.has(nextKey)) {
          visited.add(nextKey);
          const nextNode: TraceNode = {
            file: nextFile,
            symbol: nextSymbol,
            depth: node.depth + 1,
            incomingEdgeType: edge.edge_type as any,
          };
          queue.push({
            node: nextNode,
            path: [...path, nextNode],
          });
        }
      }
    }

    return null;
  }

  private getEdgesForNode(node: TraceNode, direction: TraceDirection, includeStructural: boolean, repo?: string): any[] {
    const edges = direction === 'up'
      ? this.store.getReverseEdges(node.file)
      : this.store.getEdgesForFile(node.file);

    let filtered = edges;
    if (repo) {
      filtered = filtered.filter(e => e.repo === repo);
    }

    const isDataBearing = (type: string) => DATA_BEARING_EDGES.includes(type);
    const isStructural = (type: string) => STRUCTURAL_EDGES.includes(type);

    filtered = filtered.filter(e => {
      const type = e.edge_type as string;
      if (includeStructural) {
        return isDataBearing(type) || isStructural(type);
      }
      return isDataBearing(type);
    });

    filtered = filtered.filter(e => {
      const edgeSym = direction === 'up' ? e.target_symbol : e.source_symbol;
      return matchesSymbol(node.symbol, edgeSym as string | null);
    });

    return filtered;
  }

  private getScopedSymbolName(file: string, name: string | null, repo?: string): string | null {
    if (!name) return null;
    const symbols = this.store.getSymbolsForFile(file);
    const found = symbols.find(s => s.name === name);
    if (found && found.scope) {
      return `${found.scope}::${name}`;
    }
    return name;
  }
}
