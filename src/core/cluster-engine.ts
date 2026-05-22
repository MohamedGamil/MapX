import { Store } from './store.js';

export type ClusterSource = 'namespace' | 'directory' | 'community';

export interface Cluster {
  name: string;
  label: string;
  source: ClusterSource;
  parentName: string | null;
  depth: number;
  fileCount: number;
}

export interface ClusterResult {
  clustersFound: number;
  namespaceClusters: number;
  directoryClusters: number;
  communityClusters: number;
  filesAssigned: number;
  durationMs: number;
}

export class ClusterEngine {
  constructor(private store: Store) {}

  detect(repo: string): ClusterResult {
    const startTime = Date.now();

    // 1. Detect Namespace clusters (Source 1)
    const nsRes = this.detectNamespaceClusters(repo);

    // 2. Detect Directory clusters (Source 2)
    const dirRes = this.detectDirectoryClusters(repo, nsRes.memberships);

    // Combine primary memberships
    const allPrimaryMemberships = new Map<string, string>();
    for (const [f, c] of nsRes.memberships.entries()) {
      allPrimaryMemberships.set(f, c);
    }
    for (const [f, c] of dirRes.memberships.entries()) {
      allPrimaryMemberships.set(f, c);
    }

    // Combine primary clusters
    const primaryClustersMap = new Map<string, Cluster>();
    for (const c of nsRes.clusters) {
      primaryClustersMap.set(c.name, c);
    }
    for (const c of dirRes.clusters) {
      if (!primaryClustersMap.has(c.name)) {
        primaryClustersMap.set(c.name, c);
      }
    }

    // Compute recursive file counts for primary clusters
    const primaryFileCounts = new Map<string, number>();
    for (const clusterName of allPrimaryMemberships.values()) {
      let current: string | null = clusterName;
      while (current) {
        primaryFileCounts.set(current, (primaryFileCounts.get(current) || 0) + 1);
        const idx = current.lastIndexOf('.');
        current = idx !== -1 ? current.substring(0, idx) : null;
      }
    }

    // Apply recursive file counts to primary clusters
    const primaryClusters = Array.from(primaryClustersMap.values()).map(c => ({
      ...c,
      fileCount: primaryFileCounts.get(c.name) || 0,
    }));

    // Build map of cluster name to set of files it contains recursively (for community overlap check)
    const clusterFileSets = new Map<string, Set<string>>();
    for (const c of primaryClusters) {
      clusterFileSets.set(c.name, new Set<string>());
    }
    for (const [filePath, clusterName] of allPrimaryMemberships.entries()) {
      let current: string | null = clusterName;
      while (current) {
        if (clusterFileSets.has(current)) {
          clusterFileSets.get(current)!.add(filePath);
        }
        const idx = current.lastIndexOf('.');
        current = idx !== -1 ? current.substring(0, idx) : null;
      }
    }

    // 3. Detect Community clusters (Source 3)
    const files = this.store.getAllFiles(repo);
    const edges = this.store.getAllEdges(repo);
    const commRes = this.detectCommunityClusters(repo, files, edges, clusterFileSets);

    // Save all to database
    this.store.inTransaction(() => {
      this.store.clearClusters(repo);

      // Persist primary clusters
      for (const c of primaryClusters) {
        this.store.insertCluster({
          repo,
          name: c.name,
          label: c.label,
          source: c.source,
          parentName: c.parentName,
          depth: c.depth,
          fileCount: c.fileCount,
        });
      }

      // Persist primary memberships
      for (const [filePath, clusterName] of allPrimaryMemberships.entries()) {
        this.store.insertClusterMembership({
          filePath,
          clusterName,
          repo,
          isPrimary: 1,
        });
      }

      // Persist community clusters
      for (const c of commRes.clusters) {
        this.store.insertCluster({
          repo,
          name: c.name,
          label: c.label,
          source: c.source,
          parentName: c.parentName,
          depth: c.depth,
          fileCount: c.fileCount,
        });
      }

      // Persist community memberships
      for (const m of commRes.memberships) {
        this.store.insertClusterMembership({
          filePath: m.filePath,
          clusterName: m.clusterName,
          repo,
          isPrimary: 0,
        });
      }
    });

    const namespaceCount = primaryClusters.filter(c => c.source === 'namespace').length;
    const directoryCount = primaryClusters.filter(c => c.source === 'directory').length;

    return {
      clustersFound: primaryClusters.length + commRes.clusters.length,
      namespaceClusters: namespaceCount,
      directoryClusters: directoryCount,
      communityClusters: commRes.clusters.length,
      filesAssigned: allPrimaryMemberships.size,
      durationMs: Date.now() - startTime,
    };
  }

  private detectNamespaceClusters(repo: string): { clusters: Cluster[]; memberships: Map<string, string> } {
    const files = this.store.getAllFiles(repo);
    const clustersMap = new Map<string, Cluster>();
    const memberships = new Map<string, string>();

    for (const f of files) {
      let ns = (f.namespace as string) || null;
      if (!ns && f.metadata) {
        try {
          const meta = JSON.parse(f.metadata as string);
          ns = meta.namespace || null;
        } catch {}
      }

      if (ns) {
        const normalized = ns.replace(/\\/g, '.').replace(/^\.|\.$/g, '');
        if (!normalized) continue;

        memberships.set(f.path as string, normalized);

        let current = normalized;
        while (current) {
          if (!clustersMap.has(current)) {
            const parts = current.split('.');
            const parentName = parts.slice(0, -1).join('.') || null;
            const depth = parts.length - 1;
            clustersMap.set(current, {
              name: current,
              label: parts.join(' / '),
              source: 'namespace',
              parentName,
              depth,
              fileCount: 0,
            });
          }
          const idx = current.lastIndexOf('.');
          current = idx !== -1 ? current.substring(0, idx) : '';
        }
      }
    }

    return { clusters: Array.from(clustersMap.values()), memberships };
  }

  private detectDirectoryClusters(
    repo: string,
    existingPrimaryMemberships: Map<string, string>
  ): { clusters: Cluster[]; memberships: Map<string, string> } {
    const files = this.store.getAllFiles(repo);
    const dirFileCount = new Map<string, Set<string>>();

    for (const f of files) {
      const filePath = f.path as string;
      const parts = filePath.split('/');
      if (parts.length <= 1) continue;

      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join('/');
        if (!dirFileCount.has(dirPath)) {
          dirFileCount.set(dirPath, new Set());
        }
        dirFileCount.get(dirPath)!.add(filePath);
      }
    }

    const clustersMap = new Map<string, Cluster>();
    const memberships = new Map<string, string>();

    for (const [dirPath, fileSet] of dirFileCount.entries()) {
      if (fileSet.size >= 2) {
        const clusterName = dirPath.replace(/\//g, '.');
        const parts = clusterName.split('.');
        const parentName = parts.slice(0, -1).join('.') || null;
        const depth = parts.length;

        clustersMap.set(clusterName, {
          name: clusterName,
          label: parts.join(' / '),
          source: 'directory',
          parentName,
          depth,
          fileCount: 0,
        });
      }
    }

    for (const f of files) {
      const filePath = f.path as string;
      if (existingPrimaryMemberships.has(filePath)) continue;

      const parts = filePath.split('/');
      if (parts.length <= 1) continue;

      for (let i = parts.length - 1; i >= 1; i--) {
        const dirPath = parts.slice(0, i).join('/');
        const clusterName = dirPath.replace(/\//g, '.');
        if (clustersMap.has(clusterName)) {
          memberships.set(filePath, clusterName);
          break;
        }
      }
    }

    return { clusters: Array.from(clustersMap.values()), memberships };
  }

  private detectCommunityClusters(
    repo: string,
    files: any[],
    edges: any[],
    existingClusterFileSets: Map<string, Set<string>>
  ): { clusters: Cluster[]; memberships: { filePath: string; clusterName: string }[] } {
    const filesList = files.map(f => f.path as string).sort();
    const weights = new Map<string, Map<string, number>>();
    const addWeight = (u: string, v: string, w: number) => {
      if (!weights.has(u)) weights.set(u, new Map());
      const uMap = weights.get(u)!;
      uMap.set(v, (uMap.get(v) || 0) + w);
    };

    for (const e of edges) {
      const src = e.source_file as string;
      const tgt = e.target_file as string;
      if (src === tgt) continue;
      addWeight(src, tgt, 1);
      addWeight(tgt, src, 1);
    }

    const labels = new Map<string, string>();
    for (const node of filesList) {
      labels.set(node, node);
    }

    const maxIterations = 10;
    let changed = true;
    for (let iter = 0; iter < maxIterations && changed; iter++) {
      changed = false;
      for (const node of filesList) {
        const neighbors = weights.get(node);
        if (!neighbors || neighbors.size === 0) continue;

        const labelWeights = new Map<string, number>();
        for (const [neighbor, weight] of neighbors.entries()) {
          const nLabel = labels.get(neighbor)!;
          labelWeights.set(nLabel, (labelWeights.get(nLabel) || 0) + weight);
        }

        let maxLabel = labels.get(node)!;
        let maxW = 0;

        const sortedLabels = Array.from(labelWeights.keys()).sort();
        for (const label of sortedLabels) {
          const w = labelWeights.get(label)!;
          if (w > maxW) {
            maxW = w;
            maxLabel = label;
          } else if (w === maxW) {
            if (label < maxLabel) {
              maxLabel = label;
            }
          }
        }

        if (labels.get(node) !== maxLabel) {
          labels.set(node, maxLabel);
          changed = true;
        }
      }
    }

    const communityGroups = new Map<string, string[]>();
    for (const [node, label] of labels.entries()) {
      if (!communityGroups.has(label)) {
        communityGroups.set(label, []);
      }
      communityGroups.get(label)!.push(node);
    }

    const clusters: Cluster[] = [];
    const memberships: { filePath: string; clusterName: string }[] = [];
    let communityIndex = 1;

    const sortedGroupKeys = Array.from(communityGroups.keys()).sort();
    for (const key of sortedGroupKeys) {
      const filePaths = communityGroups.get(key)!;
      if (filePaths.length < 3) continue;

      const commFileSet = new Set(filePaths);
      let overlaps = false;
      for (const fileSet of existingClusterFileSets.values()) {
        if (fileSet.size === commFileSet.size) {
          let allMatch = true;
          for (const f of filePaths) {
            if (!fileSet.has(f)) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            overlaps = true;
            break;
          }
        }
      }

      if (!overlaps) {
        const commName = `community_${communityIndex++}`;
        clusters.push({
          name: commName,
          label: `Community ${commName.split('_')[1]}`,
          source: 'community',
          parentName: null,
          depth: 0,
          fileCount: filePaths.length,
        });
        for (const f of filePaths) {
          memberships.push({ filePath: f, clusterName: commName });
        }
      }
    }

    return { clusters, memberships };
  }
}
