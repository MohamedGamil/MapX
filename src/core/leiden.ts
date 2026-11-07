export interface LeidenOptions {
  resolution?: number;       // default 1.0 — higher = more smaller communities
  minCommunitySize?: number; // default 3
  maxIterations?: number;    // default 20
}

interface Graph {
  nodes: string[];
  degrees: Map<string, number>;
  neighbors: Map<string, Map<string, number>>;
  selfLoops: Map<string, number>;
  totalWeight: number;
}

export function detectLeidenCommunities(
  nodeList: string[],
  edgeList: { source: string; target: string; weight: number }[],
  options: LeidenOptions = {}
): Record<string, string[]> {
  const resolution = options.resolution ?? 1.0;
  const minCommunitySize = options.minCommunitySize ?? 3;
  const maxIterations = options.maxIterations ?? 20;

  // 1. Build initial graph representation
  const graph: Graph = buildGraph(nodeList, edgeList);
  if (graph.totalWeight === 0) {
    // Fallback: assign each node to its own community or return empty
    const fallback: Record<string, string[]> = {};
    return fallback;
  }

  // 2. Leiden levels: local moving, refinement inside each community, aggregation of the
  // refined communities (internal weight kept as self-loops), until a level merges nothing.
  // Node order is fixed so the same graph always yields the same communities (M0-08-R1).
  let currentGraph = graph;
  let nodeToMeta = new Map<string, string>();
  for (const n of nodeList) {
    nodeToMeta.set(n, n);
  }

  for (let level = 0; level < maxIterations; level++) {
    const partition = runLocalMovement(currentGraph, resolution);
    const communityCount = new Set(Object.values(partition)).size;
    if (communityCount === currentGraph.nodes.length) break;

    let refinedPartition = runRefinement(currentGraph, partition, resolution);
    // Refinement that merges nothing would stall the aggregation: aggregate the moved partition.
    if (new Set(Object.values(refinedPartition)).size === currentGraph.nodes.length) refinedPartition = partition;

    const nextNodeToMeta = new Map<string, string>();
    for (const [origNode, metaNode] of nodeToMeta.entries()) {
      nextNodeToMeta.set(origNode, refinedPartition[metaNode]!);
    }
    nodeToMeta = nextNodeToMeta;
    currentGraph = aggregateGraph(currentGraph, refinedPartition);
  }

  // 3. Group original nodes by their final community meta-node ID
  const communities: Record<string, string[]> = {};
  for (const [origNode, finalComm] of nodeToMeta.entries()) {
    if (!communities[finalComm]) {
      communities[finalComm] = [];
    }
    communities[finalComm].push(origNode);
  }

  // 4. Filter communities by minimum size
  const filteredCommunities: Record<string, string[]> = {};
  let index = 1;
  for (const [commId, members] of Object.entries(communities)) {
    if (members.length >= minCommunitySize) {
      filteredCommunities[`c${index++}`] = members;
    }
  }

  return filteredCommunities;
}

function buildGraph(nodes: string[], edges: { source: string; target: string; weight: number }[]): Graph {
  const degrees = new Map<string, number>();
  const neighbors = new Map<string, Map<string, number>>();
  const selfLoops = new Map<string, number>();
  let totalWeight = 0;

  for (const n of nodes) {
    degrees.set(n, 0);
    neighbors.set(n, new Map());
  }

  for (const e of edges) {
    const u = e.source;
    const v = e.target;
    const w = e.weight;

    if (!degrees.has(u) || !degrees.has(v)) continue;

    // A self-loop is an aggregated community's internal weight: it counts twice in the degree.
    if (u === v) {
      selfLoops.set(u, (selfLoops.get(u) || 0) + w);
      degrees.set(u, degrees.get(u)! + 2 * w);
      totalWeight += w;
      continue;
    }

    degrees.set(u, degrees.get(u)! + w);
    degrees.set(v, degrees.get(v)! + w);

    const uNeighbors = neighbors.get(u)!;
    uNeighbors.set(v, (uNeighbors.get(v) || 0) + w);

    const vNeighbors = neighbors.get(v)!;
    vNeighbors.set(u, (vNeighbors.get(u) || 0) + w);

    totalWeight += w;
  }

  return { nodes, degrees, neighbors, selfLoops, totalWeight };
}

/** Modularity gain of putting a node (degree k, `connWeight` to the community) into a community of total degree `commWeight`. */
function gain(connWeight: number, commWeight: number, k: number, resolution: number, m: number): number {
  return connWeight - resolution * (commWeight * k) / (2 * m);
}

function runLocalMovement(graph: Graph, resolution: number): Record<string, string> {
  const partition: Record<string, string> = {};
  const communityWeights = new Map<string, number>(); // sum of degree of nodes in community
  const m = graph.totalWeight;

  for (const n of graph.nodes) {
    partition[n] = n;
    communityWeights.set(n, graph.degrees.get(n)!);
  }

  let changed = true;
  let iterations = 0;
  const maxMoveIterations = 10;

  while (changed && iterations < maxMoveIterations) {
    changed = false;
    iterations++;

    for (const node of graph.nodes) {
      const currentComm = partition[node]!;
      const nodeWeight = graph.degrees.get(node)!;
      const nodeNeighbors = graph.neighbors.get(node)!;
      if (nodeNeighbors.size === 0) continue;

      const commConnections = new Map<string, number>();
      for (const [nbr, w] of nodeNeighbors.entries()) {
        const nbrComm = partition[nbr]!;
        commConnections.set(nbrComm, (commConnections.get(nbrComm) || 0) + w);
      }

      // Take the node out of its community, then put it back where the gain is highest;
      // staying wins ties.
      const remaining = (communityWeights.get(currentComm) || 0) - nodeWeight;
      let bestComm = currentComm;
      let bestGain = gain(commConnections.get(currentComm) || 0, remaining, nodeWeight, resolution, m);

      for (const [comm, connWeight] of commConnections.entries()) {
        if (comm === currentComm) continue;
        const g = gain(connWeight, communityWeights.get(comm) || 0, nodeWeight, resolution, m);
        if (g > bestGain + 1e-12) {
          bestGain = g;
          bestComm = comm;
        }
      }

      if (bestComm !== currentComm) {
        partition[node] = bestComm;
        communityWeights.set(currentComm, remaining);
        communityWeights.set(bestComm, (communityWeights.get(bestComm) || 0) + nodeWeight);
        changed = true;
      }
    }
  }

  return partition;
}

/**
 * Leiden refinement phase: inside each community, singletons merge only into well-connected
 * sub-communities of the same community, so every refined community is connected.
 */
function runRefinement(
  graph: Graph,
  partition: Record<string, string>,
  resolution: number
): Record<string, string> {
  const refinedPartition: Record<string, string> = {};
  const m = graph.totalWeight;

  const commToNodes = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const comm = partition[node]!;
    if (!commToNodes.has(comm)) {
      commToNodes.set(comm, []);
    }
    commToNodes.get(comm)!.push(node);
  }

  for (const nodes of commToNodes.values()) {
    const subPartition: Record<string, string> = {};
    const subCommWeights = new Map<string, number>();
    const subCommSize = new Map<string, number>();

    for (const n of nodes) {
      subPartition[n] = n;
      subCommWeights.set(n, graph.degrees.get(n)!);
      subCommSize.set(n, 1);
    }

    for (const node of nodes) {
      // Only nodes still alone in their sub-community move.
      if (subCommSize.get(subPartition[node]!) !== 1) continue;
      const nodeWeight = graph.degrees.get(node)!;

      const subCommConnections = new Map<string, number>();
      for (const [nbr, w] of graph.neighbors.get(node)!.entries()) {
        if (partition[nbr] !== partition[node]) continue;
        const nbrSubComm = subPartition[nbr]!;
        if (nbrSubComm === subPartition[node]) continue;
        subCommConnections.set(nbrSubComm, (subCommConnections.get(nbrSubComm) || 0) + w);
      }

      let bestSubComm = subPartition[node]!;
      let bestGain = 0;
      for (const [subComm, connWeight] of subCommConnections.entries()) {
        const g = gain(connWeight, subCommWeights.get(subComm) || 0, nodeWeight, resolution, m);
        if (g > bestGain + 1e-12) {
          bestGain = g;
          bestSubComm = subComm;
        }
      }

      if (bestSubComm !== subPartition[node]) {
        const currentSubComm = subPartition[node]!;
        subPartition[node] = bestSubComm;
        subCommWeights.set(currentSubComm, 0);
        subCommSize.set(currentSubComm, 0);
        subCommWeights.set(bestSubComm, (subCommWeights.get(bestSubComm) || 0) + nodeWeight);
        subCommSize.set(bestSubComm, (subCommSize.get(bestSubComm) || 0) + 1);
      }
    }

    for (const n of nodes) {
      refinedPartition[n] = subPartition[n]!;
    }
  }

  return refinedPartition;
}

/**
 * Aggregates the graph based on the refined partition, building meta-nodes and meta-edges.
 */
function aggregateGraph(graph: Graph, refinedPartition: Record<string, string>): Graph {
  const metaNodesSet = new Set<string>();
  for (const comm of Object.values(refinedPartition)) {
    metaNodesSet.add(comm);
  }
  const metaNodes = Array.from(metaNodesSet);

  const metaEdgesMap = new Map<string, Map<string, number>>();
  for (const mNode of metaNodes) {
    metaEdgesMap.set(mNode, new Map());
  }

  // Sum edge weights between communities; a node's own self-loop stays inside its community.
  // Internal edges are visited from both ends, like cross edges, so the halving below holds.
  for (const [node, w] of graph.selfLoops.entries()) {
    const comm = refinedPartition[node]!;
    const commMap = metaEdgesMap.get(comm)!;
    commMap.set(comm, (commMap.get(comm) || 0) + 2 * w);
  }
  for (const [node, nodeNeighbors] of graph.neighbors.entries()) {
    const srcComm = refinedPartition[node];
    for (const [nbr, w] of nodeNeighbors.entries()) {
      const tgtComm = refinedPartition[nbr];
      const srcCommMap = metaEdgesMap.get(srcComm)!;
      srcCommMap.set(tgtComm, (srcCommMap.get(tgtComm) || 0) + w);
    }
  }

  // Convert to flat edge list for rebuild
  const metaEdges: { source: string; target: string; weight: number }[] = [];
  for (const [src, targets] of metaEdgesMap.entries()) {
    for (const [tgt, w] of targets.entries()) {
      // Divide by 2 because undirected edges are double counted in loop
      metaEdges.push({ source: src, target: tgt, weight: w / 2 });
    }
  }

  return buildGraph(metaNodes, metaEdges);
}
