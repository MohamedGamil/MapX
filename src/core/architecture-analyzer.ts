import type { Store } from './store.js';
import type { CodebaseProfile, FileRole, CodebaseArchetype } from '../types.js';
import { FlowValidator, LayerViolation } from './flow-validator.js';
import { calculateClusterMetrics } from './metrics.js';
import * as path from 'node:path';
import { ConfigError } from '../arch/config.js';
import { openArchitecture, type ArchContext } from '../arch/introspect.js';
import { loadBaseline } from '../arch/baseline.js';
import { buildReport } from '../arch/report.js';
import { edgeKey, ruledEdges, ruleSmells } from '../arch/smells.js';

export interface ArchSmell {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  description: string;
  involvedFiles: string[];
  involvedClusters?: string[];
  suggestion: string;
  /**
   * Where a smell shown with an architecture configuration comes from (M5-16; deptrac §3.3, AR-18):
   * `rules`, derived from `.mapx/architecture.jsonc`, or `inferred-roles`, a role-order layer
   * violation kept by `policy.alsoInferred`. Absent without a configuration, as before.
   */
  source?: 'rules' | 'inferred-roles';
  /** The layers a rule-derived smell is about (a layer cycle, an allowance …). */
  involvedLayers?: string[];
}

/** A smell as `Store.getArchSmells` returns it (the row, with its parsed lists), or a rule-derived one. */
export type SmellRow = Record<string, any>;

/**
 * The smells `mapx_smells`, `mapx arch` and the dashboard show for `repos` (M5-16; deptrac §3.3,
 * one source of truth). Without `.mapx/architecture.jsonc`, the smells the last scan stored, as
 * they are. With one, layer violations come from the rule evaluator (`mapx check`'s report, its
 * baseline applied) instead of the role order, and the AR-18 smells are appended, marked
 * `source: "rules"`, with the report's exit-3 errors (a stale baseline entry …) as
 * `architecture-config` smells. `policy.alsoInferred` keeps the role-order violations too, marked
 * `inferred-roles`, but only on edges the rules decide in no way (`ruledEdges`: a source in no
 * layer). The edges are evaluated once per call. Composed when read, so an edited configuration
 * applies without a rescan. A configuration or baseline that cannot be loaded keeps the role-order
 * violations and adds an `architecture-config` smell saying so. Layer-level smells belong to
 * `primary`, the workspace's repo; the others to their source's repo. A command that lists smells
 * twice calls this once.
 */
export function currentSmells(store: Store, dir: string, repos: string[], options: { primary: string; repoPaths?: Record<string, string> }): SmellRow[] {
  const stored = repos.flatMap((r) => store.getArchSmells(r));
  const inferred = (s: SmellRow): SmellRow => (s.type === 'layer-violation' ? { ...s, source: 'inferred-roles' } : s);
  let ctx: ArchContext | null;
  let report;
  try {
    ctx = openArchitecture(dir, store, { repoPaths: options.repoPaths });
    if (!ctx) return stored;
    // One evaluation: the report decides on the context's, which the smells reuse.
    report = buildReport(store, ctx.config, ctx.membership, { baseline: loadBaseline(dir, ctx.config), repoPaths: options.repoPaths, evaluation: ctx.evaluation() });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const first = err.issues[0];
    const where = first ? `${first.file}${first.pointer ? `#${first.pointer}` : ''}: ${first.message}` : err.message;
    const more = err.issues.length > 1 ? ` (and ${err.issues.length - 1} more)` : '';
    return [...stored.map(inferred), smellRow(options.primary, {
      type: 'architecture-config', severity: 'critical', source: 'rules', involvedFiles: [],
      description: `The architecture configuration cannot be evaluated: ${where}${more}`,
      suggestion: 'Fix it (`mapx arch validate-config` lists every problem); until then layer violations come from the inferred file roles.',
    })].filter((s) => repos.includes(s.repo));
  }
  const rules = ruleSmells(ctx, report).filter((s) => repos.includes(s.repo ?? options.primary));
  const ruled = ctx.config.policy.alsoInferred ? ruledEdges(ctx) : null;
  const kept = stored
    .filter((s) => s.type !== 'layer-violation' || (ruled !== null && !ruled.has(edgeKey(s.involvedFiles?.[0], s.involvedFiles?.[1]))))
    .map(inferred);
  return [...kept, ...rules.map(({ repo, ...s }) => smellRow(repo ?? options.primary, s))];
}

/** A computed smell in the shape of a stored row, so every reader (the dashboard too) takes both. */
function smellRow(repo: string, s: ArchSmell): SmellRow {
  const involvedClusters = s.involvedClusters ?? [];
  return {
    repo, type: s.type, severity: s.severity, description: s.description,
    involved_files: JSON.stringify(s.involvedFiles), involved_clusters: JSON.stringify(involvedClusters), suggestion: s.suggestion,
    involvedFiles: s.involvedFiles, involvedClusters, ...(s.involvedLayers ? { involvedLayers: s.involvedLayers } : {}), ...(s.source ? { source: s.source } : {}),
  };
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

    // Deduplicate smells on (type, sorted involved files). Sort a copy: involvedFiles keep their
    // order (a cycle's path order, M0-32-R2).
    const seenSmells = new Set<string>();
    return smells.filter(s => {
      const key = `${s.type}:${[...(s.involvedFiles || [])].sort().join(',')}`;
      if (seenSmells.has(key)) return false;
      seenSmells.add(key);
      return true;
    });
  }

  private detectCycles(edges: any[], files: string[]): ArchSmell[] {
    const adj = new Map<string, string[]>();
    for (const f of files) adj.set(f, []);
    for (const e of edges) {
      const src = e.source_file as string;
      const tgt = e.target_file as string;
      // A file's edges to itself (calls between its own functions) are no dependency cycle, and
      // made the shortest cycle through a file the file itself (M0-32-R3: `a.ts -> a.ts`).
      if (src !== tgt && adj.has(src) && adj.has(tgt)) {
        adj.get(src)!.push(tgt);
      }
    }

    const sccs = stronglyConnectedComponents(adj, files).filter(scc => scc.length > 1);

    return sccs.map(scc => {
      const cyclePath = shortestCycleThrough(scc[0], adj, new Set(scc)) ?? scc;

      return {
        type: 'cyclic-dependency',
        severity: 'critical',
        description: `Cyclic dependency detected: ${cyclePath.map(f => path.basename(f)).join(' -> ')}`,
        // The path without its closing repeat of the first file.
        involvedFiles: [...new Set(cyclePath)],
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

/**
 * Tarjan's strongly connected components, iterative so that a long dependency chain cannot overflow
 * the call stack. Roots are taken in `order`; components come out in the order the recursive
 * algorithm pops them, each listing its members in pop order. Singletons are included.
 */
export function stronglyConnectedComponents(adj: Map<string, string[]>, order: Iterable<string>): string[][] {
  const indexMap = new Map<string, number>();
  const lowlinkMap = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let index = 0;
  // The DFS path: each frame is a node and the position of the next neighbour it will visit.
  const frames: { v: string; next: number }[] = [];

  const visit = (v: string) => {
    indexMap.set(v, index);
    lowlinkMap.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    frames.push({ v, next: 0 });
  };

  for (const root of order) {
    if (indexMap.has(root)) continue;
    visit(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const v = frame.v;
      const neighbors = adj.get(v) || [];
      if (frame.next < neighbors.length) {
        const w = neighbors[frame.next++];
        if (!indexMap.has(w)) {
          visit(w);
        } else if (onStack.has(w)) {
          lowlinkMap.set(v, Math.min(lowlinkMap.get(v)!, indexMap.get(w)!));
        }
        continue;
      }

      // Every neighbour is done: emit v's component if v is its root, then return to the parent.
      frames.pop();
      if (lowlinkMap.get(v) === indexMap.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        sccs.push(scc);
      }
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].v;
        lowlinkMap.set(parent, Math.min(lowlinkMap.get(parent)!, lowlinkMap.get(v)!));
      }
    }
  }

  return sccs;
}

/**
 * The shortest cycle from `start` back to itself through `members`, breadth-first in adjacency
 * order (`[start, ..., start]`), or null if there is none.
 */
export function shortestCycleThrough(start: string, adj: Map<string, string[]>, members: Set<string>): string[] | null {
  const parent = new Map<string, string>();
  const queue: string[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const last = queue[head];
    for (const nbr of adj.get(last) || []) {
      if (nbr === start) {
        const back: string[] = [];
        for (let n = last; n !== start; n = parent.get(n)!) back.push(n);
        return [start, ...back.reverse(), start];
      }
      if (members.has(nbr) && !parent.has(nbr)) {
        parent.set(nbr, last);
        queue.push(nbr);
      }
    }
  }
  return null;
}
