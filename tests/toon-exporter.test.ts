import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decode } from '@toon-format/toon';
import { Store } from '../src/core/store.js';
import { MapxGraph } from '../src/core/graph.js';
import { ToonExporter } from '../src/exporters/toon-exporter.js';

// Real store + graph, decoded with the reference TOON implementation (I14 / M0-14-R1).
const files = [
  { path: 'src/a.ts', language: 'typescript', lines: 10 },
  { path: 'src/b, c.ts', language: 'typescript', lines: 5 },
  { path: 'app/Repo.php', language: 'php', lines: 7 },
];
const symbols = [
  { filePath: 'src/a.ts', name: 'load', kind: 'function', scope: null },
  { filePath: 'src/a.ts', name: 'Cache', kind: 'class', scope: null },
  { filePath: 'src/b, c.ts', name: 'save|all', kind: 'function', scope: null },
  { filePath: 'app/Repo.php', name: 'Repo', kind: 'class', scope: 'App' },
  { filePath: 'app/Repo.php', name: 'get', kind: 'method', scope: 'Repo' },
];
const edges = [
  { sourceFile: 'src/a.ts', targetFile: 'src/b, c.ts', sourceSymbol: null, targetSymbol: null, edgeType: 'import' },
  { sourceFile: 'src/a.ts', targetFile: 'src/b, c.ts', sourceSymbol: 'load', targetSymbol: 'save|all', edgeType: 'call' },
  { sourceFile: 'src/b, c.ts', targetFile: 'src/a.ts', sourceSymbol: null, targetSymbol: 'Cache', edgeType: 'instantiation' },
  { sourceFile: 'app/Repo.php', targetFile: 'app/Repo.php', sourceSymbol: 'Repo', targetSymbol: 'get', edgeType: 'call' },
];

describe('ToonExporter round-trip', () => {
  let store: Store;
  let exporter: ToonExporter;

  beforeEach(() => {
    store = new Store(':memory:');
    const graph = new MapxGraph('test');
    for (const f of files) {
      store.upsertFile({ ...f, repo: 'test', gitBlobHash: null, contentHash: null, lastScanned: '2026-10-30', sizeBytes: 100 });
      graph.addFileNode(f.path, f.language, 100, f.lines);
    }
    for (const s of symbols)
      store.insertSymbol({ ...s, repo: 'test', signature: s.name, startLine: 1, endLine: 2, metadata: '{}' });
    for (const e of edges) {
      store.insertEdge({ ...e, repo: 'test', weight: 1 });
      graph.addDependencyEdge({ ...e, repo: 'test', weight: 1 } as any);
    }
    exporter = new ToonExporter(store, graph);
  });
  afterEach(() => store.close());

  const roundTrip = (delimiter?: 'comma' | 'tab' | 'pipe') => {
    const doc = decode(exporter.export({ tokenBudget: 100000, delimiter })) as any;
    return {
      doc,
      files: doc.files.map((f: any) => f.path).sort(),
      symbols: doc.symbols.map((s: any) => `${s.file}::${s.scope}::${s.name}::${s.kind}`).sort(),
      edges: doc.edges.map((e: any) => `${e.sourceFile}>${e.targetFile}:${e.edgeType}:${e.sourceSymbol}>${e.targetSymbol}`).sort(),
    };
  };
  const expected = {
    files: files.map((f) => f.path).sort(),
    symbols: symbols.map((s) => `${s.filePath}::${s.scope ?? ''}::${s.name}::${s.kind}`).sort(),
    edges: edges.map((e) => `${e.sourceFile}>${e.targetFile}:${e.edgeType}:${e.sourceSymbol ?? ''}>${e.targetSymbol ?? ''}`).sort(),
  };

  it.each([undefined, 'comma', 'tab', 'pipe'] as const)('decodes losslessly with delimiter %s', (delimiter) => {
    const r = roundTrip(delimiter);
    expect(r.files).toEqual(expected.files);
    expect(r.symbols).toEqual(expected.symbols);
    expect(r.edges).toEqual(expected.edges);
    expect(r.doc.summary).toMatchObject({ files: 3, symbols: 5, edges: 4 });
    expect(r.doc.truncated).toBeUndefined();
  });

  it('reports per-file symbol counts', () => {
    const { doc } = roundTrip();
    expect(Object.fromEntries(doc.files.map((f: any) => [f.path, f.symbols]))).toEqual({
      'src/a.ts': 2,
      'src/b, c.ts': 1,
      'app/Repo.php': 2,
    });
  });

  it('truncates under a small token budget with a decodable footer', () => {
    const doc = decode(exporter.export({ tokenBudget: 120 })) as any;
    expect(doc.truncated).toBe(true);
    expect(doc.totalSymbols).toBe(5);
    expect(doc.includedSymbols).toBeLessThan(5);
    expect(doc.symbols?.length ?? 0).toBe(doc.includedSymbols);
  });
});
