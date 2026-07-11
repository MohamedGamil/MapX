import type { Store } from './store.js';
import type { CodebaseProfile, FileRole, CodebaseArchetype } from '../types.js';
import { FlowValidator, LayerViolation } from './flow-validator.js';
import { calculateClusterMetrics } from './metrics.js';
import * as path from 'node:path';

export interface ArchSmell {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  description: string;
  involvedFiles: string[];
  involvedClusters?: string[];
  suggestion: string;
}

export class ArchitectureAnalyzer {
  private flowValidator = new FlowValidator();

  constructor(private store: Store) {}

  /**
   * Analyzes the repository for architectural smells and layer violations.
   */
  analyze(repoName: string, profile: CodebaseProfile): ArchSmell[] {
    const files = this.store.getAllFiles(repoName);
    const edges = this.store.getAllEdges(repoName);
    const filePaths = files.map(f => f.path as string);

    const smells: ArchSmell[] = [];

    // 1. Cycle Detection (Tarjan's strongly connected components)
    const cycleSmells = this.detectCycles(edges, filePaths);
    smells.push(...cycleSmells);

    // 2. Hub Component Detection
    const hubSmells = this.detectHubs(files, edges);
    smells.push(...hubSmells);

    // 3. Layer Violation Detection
    const violationSmells = this.detectLayerViolations(files, edges, profile.archetype);
    smells.push(...violationSmells);

    // 4. Cluster-Level Smells (Orphans, God clusters, unstable dependencies)
    const clusterMetrics = calculateClusterMetrics(this.store, repoName);
    const clusterSmells = this.detectClusterSmells(clusterMetrics, edges, files);
    smells.push(...clusterSmells);

    return smells;
  }

  private detectCycles(edges: any[], files: string[]): ArchSmell[] {
    const adj = new Map<string, string[]>();
    for (const f of files) adj.set(f, []);
    for (const e of edges) {
      const src = e.source_file as string;
      const tgt = e.target_file as string;
      if (adj.has(src) && adj.has(tgt)) {
        adj.get(src)!.push(tgt);
      }
    }

    const indexMap = new Map<string, number>();
    const lowlinkMap = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let index = 0;
    const sccs: string[][] = [];

    const strongConnect = (v: string) => {
      indexMap.set(v, index);
      lowlinkMap.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      const neighbors = adj.get(v) || [];
      for (const w of neighbors) {
        if (!indexMap.has(w)) {
          strongConnect(w);
          lowlinkMap.set(v, Math.min(lowlinkMap.get(v)!, lowlinkMap.get(w)!));
        } else if (onStack.has(w)) {
          lowlinkMap.set(v, Math.min(lowlinkMap.get(v)!, indexMap.get(w)!));
        }
      }

      if (lowlinkMap.get(v) === indexMap.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) {
          sccs.push(scc);
        }
      }
    };

    for (const node of files) {
      if (!indexMap.has(node)) {
        strongConnect(node);
      }
    }

    return sccs.map(scc => {
      const cyclePath: string[] = [];
      if (scc.length > 0) {
        const start = scc[0];
        const queue: string[][] = [[start]];
        const visited = new Set<string>();
        let foundPath: string[] | null = null;
        while (queue.length > 0 && !foundPath) {
          const path = queue.shift()!;
          const last = path[path.length - 1];
          const nbrs = adj.get(last) || [];
          for (const nbr of nbrs) {
            if (nbr === start) {
              foundPath = [...path, start];
              break;
            }
            if (scc.includes(nbr) && !visited.has(nbr)) {
              visited.add(nbr);
              queue.push([...path, nbr]);
            }
          }
        }
        cyclePath.push(...(foundPath || scc));
      }

      return {
        type: 'cyclic-dependency',
        severity: 'critical',
        description: `Cyclic dependency detected: ${cyclePath.map(f => path.basename(f)).join(' -> ')}`,
        involvedFiles: cyclePath,
        suggestion: `Break the cycle by extracting shared logic into interfaces or utilities.`,
      };
    });
  }

  private detectHubs(files: any[], edges: any[]): ArchSmell[] {
    const fanIn = new Map<string, number>();
    const fanOut = new Map<string, number>();

    for (const f of files) {
      fanIn.set(f.path, 0);
      fanOut.set(f.path, 0);
    }

    for (const e of edges) {
      const src = e.source_file;
      const tgt = e.target_file;
      if (fanIn.has(tgt)) fanIn.set(tgt, fanIn.get(tgt)! + 1);
      if (fanOut.has(src)) fanOut.set(src, fanOut.get(src)! + 1);
    }

    const smells: ArchSmell[] = [];
    for (const f of files) {
      const fi = fanIn.get(f.path) || 0;
      const fo = fanOut.get(f.path) || 0;

      // Statistical check or absolute: fan-in > 15 and fan-out > 15
      if (fi > 15 && fo > 10) {
        smells.push({
          type: 'hub-component',
          severity: 'warning',
          description: `God/Hub file detected: '${path.basename(f.path)}' has high fan-in (${fi}) and fan-out (${fo})`,
          involvedFiles: [f.path],
          suggestion: `Refactor '${path.basename(f.path)}' by splitting its responsibilities or delegates.`,
        });
      }
    }

    return smells;
  }

  private detectLayerViolations(files: any[], edges: any[], archetype: CodebaseArchetype): ArchSmell[] {
    const fileRoles = new Map<string, FileRole>();
    const fileClusters = new Map<string, string>();

    for (const f of files) {
      fileRoles.set(f.path, (f.role as FileRole) || 'other');
    }

    // Query memberships
    const memberships = this.store.raw.prepare('SELECT file_path, cluster_name FROM cluster_membership WHERE is_primary = 1').all() as any[];
    for (const m of memberships) {
      fileClusters.set(m.file_path, m.cluster_name);
    }

    const smells: ArchSmell[] = [];

    for (const e of edges) {
      const src = e.source_file;
      const tgt = e.target_file;
      const srcRole = fileRoles.get(src);
      const tgtRole = fileRoles.get(tgt);

      if (srcRole && tgtRole) {
        const sameCluster = fileClusters.get(src) === fileClusters.get(tgt);
        const violation = this.flowValidator.validateDependency(src, srcRole, tgt, tgtRole, archetype, sameCluster);
        if (violation) {
          smells.push({
            type: 'layer-violation',
            severity: violation.severity,
            description: violation.description,
            involvedFiles: [src, tgt],
            suggestion: `Avoid letting lower layer component '${srcRole}' import upper layer component '${tgtRole}'.`,
          });
        }
      }
    }

    return smells;
  }

  private detectClusterSmells(clusterMetrics: any[], edges: any[], files: any[]): ArchSmell[] {
    const smells: ArchSmell[] = [];
    const totalFilesCount = files.length;

    // File to cluster mapping
    const fileToCluster = new Map<string, string>();
    // Query memberships
    const memberships = this.store.raw.prepare('SELECT file_path, cluster_name FROM cluster_membership WHERE is_primary = 1').all() as any[];
    for (const m of memberships) {
      fileToCluster.set(m.file_path, m.cluster_name);
    }

    for (const m of clusterMetrics) {
      // 1. God Cluster (> 30% of total files)
      if (totalFilesCount > 10 && m.fileCount > totalFilesCount * 0.3) {
        smells.push({
          type: 'god-cluster',
          severity: 'warning',
          description: `God Cluster detected: '${m.clusterName}' contains ${m.fileCount} files (${Math.round((m.fileCount / totalFilesCount) * 100)}% of project)`,
          involvedFiles: [],
          involvedClusters: [m.clusterName],
          suggestion: `Decompose '${m.clusterName}' into smaller sub-modules or community groups.`,
        });
      }

      // 2. Orphan/Tiny Cluster (only 1-2 files)
      if (m.fileCount > 0 && m.fileCount <= 2 && !m.clusterName.startsWith('layer:')) {
        smells.push({
          type: 'orphan-cluster',
          severity: 'info',
          description: `Orphan cluster: '${m.clusterName}' has only ${m.fileCount} file(s)`,
          involvedFiles: [],
          involvedClusters: [m.clusterName],
          suggestion: `Consider merging '${m.clusterName}' into a larger related module or community.`,
        });
      }
    }

    // 3. Unstable Dependency (stable depends on unstable)
    const clusterMap = new Map<string, any>();
    for (const m of clusterMetrics) {
      clusterMap.set(m.clusterName, m);
    }

    const checkedEdges = new Set<string>();
    for (const e of edges) {
      const srcComm = fileToCluster.get(e.source_file);
      const tgtComm = fileToCluster.get(e.target_file);

      if (srcComm && tgtComm && srcComm !== tgtComm) {
        const edgeKey = `${srcComm}->${tgtComm}`;
        if (checkedEdges.has(edgeKey)) continue;
        checkedEdges.add(edgeKey);

        const srcMetric = clusterMap.get(srcComm);
        const tgtMetric = clusterMap.get(tgtComm);

        if (srcMetric && tgtMetric) {
          // If stable depends on unstable: src (stable, low instability) depends on tgt (unstable, high instability)
          if (srcMetric.instability < 0.3 && tgtMetric.instability > 0.7 && srcMetric.fileCount > 2 && tgtMetric.fileCount > 2) {
            smells.push({
              type: 'unstable-dependency',
              severity: 'warning',
              description: `Unstable dependency: Stable cluster '${srcComm}' (instability ${srcMetric.instability.toFixed(2)}) depends on unstable cluster '${tgtComm}' (instability ${tgtMetric.instability.toFixed(2)})`,
              involvedFiles: [e.source_file, e.target_file],
              involvedClusters: [srcComm, tgtComm],
              suggestion: `Consider making '${tgtComm}' more stable or decoupling '${srcComm}' from it.`,
            });
          }
        }
      }
    }

    return smells;
  }
}
