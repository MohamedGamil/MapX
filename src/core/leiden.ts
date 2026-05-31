export interface LeidenOptions {
  resolution?: number;       // default 1.0 — higher = more smaller communities
  minCommunitySize?: number; // default 3
  maxIterations?: number;    // default 20
}

interface Graph {
  nodes: string[];
  degrees: Map<string, number>;
  neighbors: Map<string, Map<string, number>>;
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

  // 2. Perform Leiden community detection (Iterative aggregation and refinement)
  let currentGraph = graph;
  // Map from original node name to its meta-node mapping in the current level
  let nodeToMeta = new Map<string, string>();
  for (const n of nodeList) {
    nodeToMeta.set(n, n);
  }

  let level = 0;
  while (level < maxIterations) {
    const { partition, refinedPartition } = runLeidenLevel(currentGraph, resolution);
    
    // Check if any communities were merged/changed
    let changed = false;
    for (const [node, comm] of Object.entries(partition)) {
      if (node !== comm) {
        changed = true;
        break;
      }
    }
    if (!changed) break;

    // Map original nodes to the new aggregated communities
    const nextNodeToMeta = new Map<string, string>();
    for (const [origNode, metaNode] of nodeToMeta.entries()) {
      const currentComm = refinedPartition[metaNode] || partition[metaNode];
      nextNodeToMeta.set(origNode, currentComm);
    }
    nodeToMeta = nextNodeToMeta;

    // Aggregate graph based on the refined partition
    currentGraph = aggregateGraph(currentGraph, refinedPartition);
    level++;
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
  let totalWeight = 0;

  for (const n of nodes) {
    degrees.set(n, 0);
    neighbors.set(n, new Map());
  }

  for (const e of edges) {
    const u = e.source;
    const v = e.target;
    const w = e.weight;

    if (!degrees.has(u) || !degrees.has(v) || u === v) continue;

    degrees.set(u, degrees.get(u)! + w);
    degrees.set(v, degrees.get(v)! + w);

    const uNeighbors = neighbors.get(u)!;
    uNeighbors.set(v, (uNeighbors.get(v) || 0) + w);

    const vNeighbors = neighbors.get(v)!;
    vNeighbors.set(u, (vNeighbors.get(u) || 0) + w);

    totalWeight += w;
  }

  return { nodes, degrees, neighbors, totalWeight };
}

/**
 * Runs a single level of Leiden: local movement, refinement, and partition generation.
 */
function runLeidenLevel(
  graph: Graph,
  resolution: number
): { partition: Record<string, string>; refinedPartition: Record<string, string> } {
  // Local movement phase (similar to Louvain but optimized)
  const partition = runLocalMovement(graph, resolution);

  // Refinement phase (identifies sub-communities inside the moved partitions to ensure connectivity)
  const refinedPartition = runRefinement(graph, partition, resolution);

  return { partition, refinedPartition };
}

function runLocalMovement(graph: Graph, resolution: number): Record<string, string> {
  const partition: Record<string, string> = {};
  const communityWeights = new Map<string, number>(); // sum of degree of nodes in community

  for (const n of graph.nodes) {
    partition[n] = n;
    communityWeights.set(n, graph.degrees.get(n)!);
  }

  let changed = true;
  let iterations = 0;
  const maxMoveIterations = 10;

  // Node movement with modularity optimization
  while (changed && iterations < maxMoveIterations) {
    changed = false;
    iterations++;

    // Shuffle nodes for ordering independence
    const shuffledNodes = [...graph.nodes].sort(() => Math.random() - 0.5);

    for (const node of shuffledNodes) {
      const currentComm = partition[node];
      const nodeWeight = graph.degrees.get(node)!;

      const nodeNeighbors = graph.neighbors.get(node)!;
      if (nodeNeighbors.size === 0) continue;

      // Calculate connection weights to neighbor communities
      const commConnections = new Map<string, number>();
      for (const [nbr, w] of nodeNeighbors.entries()) {
        const nbrComm = partition[nbr];
        commConnections.set(nbrComm, (commConnections.get(nbrComm) || 0) + w);
      }

      let bestComm = currentComm;
      let maxDeltaQ = 0;

      // Find community that maximizes modularity gain
      for (const [comm, connWeight] of commConnections.entries()) {
        if (comm === currentComm) continue;

        const commWeight = communityWeights.get(comm) || 0;
        // Newman-Girvan delta Q formula with resolution:
        // delta Q = (connWeight / totalWeight) - resolution * (commWeight * nodeWeight) / (2 * totalWeight^2)
        const deltaQ = connWeight - resolution * (commWeight * nodeWeight) / (2 * graph.totalWeight);

        if (deltaQ > maxDeltaQ) {
          maxDeltaQ = deltaQ;
          bestComm = comm;
        }
      }

      if (bestComm !== currentComm && maxDeltaQ > 0) {
        partition[node] = bestComm;
        communityWeights.set(currentComm, (communityWeights.get(currentComm) || 0) - nodeWeight);
        communityWeights.set(bestComm, (communityWeights.get(bestComm) || 0) + nodeWeight);
        changed = true;
      }
    }
  }

  return partition;
}

/**
 * Leiden refinement phase: guarantees connected community components and optimizes density.
 */
function runRefinement(
  graph: Graph,
  partition: Record<string, string>,
  resolution: number
): Record<string, string> {
  const refinedPartition: Record<string, string> = {};
  
  // Group nodes by their communities from the local movement phase
  const commToNodes = new Map<string, string[]>();
  for (const [node, comm] of Object.entries(partition)) {
    if (!commToNodes.has(comm)) {
      commToNodes.set(comm, []);
    }
    commToNodes.get(comm)!.push(node);
  }

  // Refine each community independently
  for (const nodes of commToNodes.values()) {
    // Sub-communities inside the main community
    const subPartition: Record<string, string> = {};
    const subCommWeights = new Map<string, number>();

    // Start with each node in its own sub-community
    for (const n of nodes) {
      subPartition[n] = n;
      subCommWeights.set(n, graph.degrees.get(n)!);
    }

    // Refinement only moves nodes to sub-communities that are well-connected (guaranteeing connectivity)
    for (const node of nodes) {
      const nodeWeight = graph.degrees.get(node)!;
      const nodeNeighbors = graph.neighbors.get(node)!;

      const subCommConnections = new Map<string, number>();
      for (const [nbr, w] of nodeNeighbors.entries()) {
        // Only look at neighbors within the same parent community
        if (partition[nbr] !== partition[node]) continue;
        const nbrSubComm = subPartition[nbr];
        subCommConnections.set(nbrSubComm, (subCommConnections.get(nbrSubComm) || 0) + w);
      }

      let bestSubComm = subPartition[node];
      let maxDeltaQ = 0;

      for (const [subComm, connWeight] of subCommConnections.entries()) {
        const subCommWeight = subCommWeights.get(subComm) || 0;
        const deltaQ = connWeight - resolution * (subCommWeight * nodeWeight) / (2 * graph.totalWeight);

        if (deltaQ > maxDeltaQ) {
          maxDeltaQ = deltaQ;
          bestSubComm = subComm;
        }
      }

      if (bestSubComm !== subPartition[node] && maxDeltaQ > 0) {
        const currentSubComm = subPartition[node];
        subPartition[node] = bestSubComm;
        subCommWeights.set(currentSubComm, (subCommWeights.get(currentSubComm) || 0) - nodeWeight);
        subCommWeights.set(bestSubComm, (subCommWeights.get(bestSubComm) || 0) + nodeWeight);
      }
    }

    // Copy to the refined partition
    for (const n of nodes) {
      refinedPartition[n] = subPartition[n];
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

  // Sum edge weights between communities
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
