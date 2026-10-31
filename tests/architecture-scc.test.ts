// M0-32-R1: strongly connected components without recursion. The recursive Tarjan in
// architecture-analyzer.ts overflowed the call stack on a long import chain closing into a cycle
// (about 5,000 files in plain node), so `mapx scan` crashed in its smell-detection step.
import { describe, it, expect, afterAll } from 'vitest';
import { ArchitectureAnalyzer, stronglyConnectedComponents } from '../src/core/architecture-analyzer.js';
import type { Store } from '../src/core/store.js';
import type { CodebaseProfile } from '../src/types.js';
import { workspace, init, mapx, query, cleanup } from './helpers/e2e.js';

const profile = { archetype: 'library' } as CodebaseProfile;

function storeOf(files: string[], edges: [string, string][]): Store {
  return {
    getAllFiles: () => files.map(path => ({ path })),
    getAllEdges: () => edges.map(([source_file, target_file]) => ({ source_file, target_file })),
    raw: { prepare: () => ({ all: () => [] }) },
  } as unknown as Store;
}

function adjacency(files: string[], edges: [string, string][]): Map<string, string[]> {
  const adj = new Map<string, string[]>(files.map(f => [f, []]));
  for (const [s, t] of edges) adj.get(s)!.push(t);
  return adj;
}

/** The recursive Tarjan that architecture-analyzer.ts used before M0-32-R1, kept as an oracle. */
function recursiveTarjan(adj: Map<string, string[]>, order: string[]): string[][] {
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
    for (const w of adj.get(v) || []) {
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
      sccs.push(scc);
    }
  };
  for (const node of order) if (!indexMap.has(node)) strongConnect(node);
  return sccs;
}

// A small known graph: a 3-cycle {a,b,c} reaching a 2-cycle {d,e}, a 3-node SCC {g,h,i} with an
// inner back edge (h -> g) and a cross edge into the finished {d,e}, a sink f, a self-loop j and a
// source k pointing into {a,b,c}.
const known = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].map(n => `src/${n}.ts`);
const N = (n: string) => `src/${n}.ts`;
const knownEdges: [string, string][] = (
  [
    ['a', 'b'], ['b', 'c'], ['b', 'd'], ['c', 'a'], ['c', 'g'],
    ['d', 'e'], ['e', 'd'], ['e', 'f'],
    ['g', 'h'], ['h', 'i'], ['h', 'g'], ['i', 'g'], ['i', 'd'],
    ['j', 'j'], ['k', 'a'],
  ] as [string, string][]
).map(([s, t]) => [N(s), N(t)]);

describe('stronglyConnectedComponents (M0-32-R1)', () => {
  it('finds exactly the known components, in the order and member order of the recursive algorithm', () => {
    const sccs = stronglyConnectedComponents(adjacency(known, knownEdges), known);
    expect(sccs).toEqual([['f'], ['e', 'd'], ['i', 'h', 'g'], ['c', 'b', 'a'], ['j'], ['k']].map(c => c.map(N)));
    expect(sccs).toEqual(recursiveTarjan(adjacency(known, knownEdges), known));
  });

  it('matches the recursive algorithm on seeded random graphs', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 50; round++) {
      const files = Array.from({ length: 5 + Math.floor(rand() * 60) }, (_, i) => `n${i}`);
      const edges: [string, string][] = [];
      const m = Math.floor(rand() * files.length * 3);
      for (let k = 0; k < m; k++) {
        edges.push([files[Math.floor(rand() * files.length)], files[Math.floor(rand() * files.length)]]);
      }
      const adj = adjacency(files, edges);
      expect(stronglyConnectedComponents(adj, files)).toEqual(recursiveTarjan(adj, files));
    }
  });

  it('handles a 100,000-node chain closing into a cycle without recursion', () => {
    const n = 100_000;
    const files = Array.from({ length: n }, (_, i) => `n${i}`);
    const adj = new Map(files.map((f, i) => [f, [files[(i + 1) % n]]]));
    const sccs = stronglyConnectedComponents(adj, files);
    expect(sccs).toHaveLength(1);
    expect(new Set(sccs[0])).toEqual(new Set(files));
  });
});

describe('ArchitectureAnalyzer cycle smells (M0-32-R1)', () => {
  it('reports the same cycle smells on the known graph as before', () => {
    const cycles = new ArchitectureAnalyzer(storeOf(known, knownEdges))
      .analyze('r', profile)
      .filter(s => s.type === 'cyclic-dependency');
    // Each path is the shortest cycle from the component's first popped member.
    expect(cycles.map(c => c.description)).toEqual([
      'Cyclic dependency detected: e.ts -> d.ts -> e.ts',
      'Cyclic dependency detected: i.ts -> g.ts -> h.ts -> i.ts',
      'Cyclic dependency detected: c.ts -> a.ts -> b.ts -> c.ts',
    ]);
    expect(cycles.every(c => c.severity === 'critical')).toBe(true);
  });

  // M0-32-R2: the dedup in `analyze` sorted involvedFiles in place, so stored cycles came back
  // sorted (`[d, e, e]`) instead of in path order.
  it('lists involved files in cycle path order, without the closing repeat and unsorted', () => {
    const cycles = new ArchitectureAnalyzer(storeOf(known, knownEdges))
      .analyze('r', profile)
      .filter(s => s.type === 'cyclic-dependency');
    expect(cycles.map(c => c.involvedFiles)).toEqual([
      ['e', 'd'],
      ['i', 'g', 'h'],
      ['c', 'a', 'b'],
    ].map(c => c.map(N)));
  });

  it('reports one cycle over all files of a 20,000-file chain closing into a cycle', () => {
    const n = 20_000;
    const files = Array.from({ length: n }, (_, i) => `src/m${i}.ts`);
    const edges = files.map((f, i): [string, string] => [f, files[(i + 1) % n]]);
    const cycles = new ArchitectureAnalyzer(storeOf(files, edges))
      .analyze('r', profile)
      .filter(s => s.type === 'cyclic-dependency');
    expect(cycles).toHaveLength(1);
    // Path order, each file once (M0-32-R2): m19999, m0, m1, …, m19998.
    expect(cycles[0].involvedFiles).toEqual([files[n - 1], ...files.slice(0, n - 1)]);
    // The component's first popped member is the deepest node, m19999.
    const { description } = cycles[0];
    expect(description.startsWith('Cyclic dependency detected: m19999.ts -> m0.ts -> m1.ts -> ')).toBe(true);
    expect(description.endsWith(' -> m19998.ts -> m19999.ts')).toBe(true);
  });
});

// Minutes long: opt in with MAPX_SLOW_TESTS=1; the in-memory 20,000/100,000-node tests above guard the fix on every run.
describe.skipIf(!process.env.MAPX_SLOW_TESTS)('mapx scan on a long cyclic import chain (M0-32-R1)', () => {
  let root: string | undefined;
  afterAll(() => {
    if (root) cleanup(root);
  });

  // 8,000 files overflowed the recursive version in a real scan (it failed from about 5,000 nodes in
  // plain node), while keeping the scan within minutes on a loaded machine; the 20,000-file case
  // is covered in memory above, and a 20,000-file scan is recorded in reports/M0-32-R1.md.
  it('scans without a RangeError and stores the one cyclic-dependency smell over every file', () => {
    // m0 -> m1 -> ... -> m7999 -> m0, each file importing and calling the next.
    const n = 8_000;
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      files[`src/m${i}.ts`] = `import { f${next} } from './m${next}';\nexport function f${i}(): number { return f${next}(); }\n`;
    }
    root = workspace(files);
    init(root);
    mapx(root, 'scan'); // throws on a non-zero exit, which the stack overflow caused
    const smells = query<{ involved_files: string }>(
      root,
      "SELECT involved_files FROM arch_smells WHERE type = 'cyclic-dependency'",
    );
    expect(smells).toHaveLength(1);
    const involved = JSON.parse(smells[0].involved_files) as string[];
    expect(new Set(involved)).toEqual(new Set(Object.keys(files)));
  }, 600_000);
});
