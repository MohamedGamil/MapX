import { describe, it, expect } from 'vitest';
import { FlowTracer } from '../src/core/flow-tracer.js';
import type { Store } from '../src/core/store.js';

describe('Sinks filtering — leaf-library exclusion', () => {
  it('should exclude leaf-library files with high structural in-degree (≥3)', () => {
    // helpers.ts is imported by 3+ files (structural in-degree >= 3)
    // It has no data-bearing outgoing edges, making it a candidate sink
    // BUT the high structural in-degree means it's a stable foundation, not a true sink
    const mockStore = {
      getAllFiles: () => [
        { path: 'src/main.ts' },
        { path: 'src/scanner.ts' },
        { path: 'src/parser.ts' },
        { path: 'src/utils/helpers.ts' },
        { path: 'src/sink.ts' },
      ],
      getAllEdges: () => [
        // Data-bearing edges: main -> scanner -> parser -> sink
        { source_file: 'src/main.ts', target_file: 'src/scanner.ts', edge_type: 'call' },
        { source_file: 'src/scanner.ts', target_file: 'src/parser.ts', edge_type: 'call' },
        { source_file: 'src/parser.ts', target_file: 'src/sink.ts', edge_type: 'call' },
        // Data-bearing edges into helpers (making it a data-bearing sink candidate)
        { source_file: 'src/main.ts', target_file: 'src/utils/helpers.ts', edge_type: 'call' },
        // Structural edges: 3 files import helpers.ts
        { source_file: 'src/main.ts', target_file: 'src/utils/helpers.ts', edge_type: 'import' },
        { source_file: 'src/scanner.ts', target_file: 'src/utils/helpers.ts', edge_type: 'import' },
        { source_file: 'src/parser.ts', target_file: 'src/utils/helpers.ts', edge_type: 'import' },
      ],
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    const sinks = tracer.findSinks();

    // helpers.ts should be filtered out because it has structural in-degree >= 3
    expect(sinks.every(s => s.file !== 'src/utils/helpers.ts')).toBe(true);

    // sink.ts should still appear (no outgoing data edges, low structural in-degree)
    expect(sinks.some(s => s.file === 'src/sink.ts')).toBe(true);
  });

  it('should keep sinks with structural in-degree < 3', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts' },
        { path: 'b.ts' },
        { path: 'leaf.ts' },
      ],
      getAllEdges: () => [
        // data-bearing: a -> b -> leaf
        { source_file: 'a.ts', target_file: 'b.ts', edge_type: 'call' },
        { source_file: 'b.ts', target_file: 'leaf.ts', edge_type: 'instantiation' },
        // structural: only 2 imports (below threshold of 3)
        { source_file: 'a.ts', target_file: 'leaf.ts', edge_type: 'import' },
        { source_file: 'b.ts', target_file: 'leaf.ts', edge_type: 'import' },
      ],
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    const sinks = tracer.findSinks();

    // leaf.ts has structural in-degree of 2 (< 3), so it should remain as a sink
    expect(sinks.some(s => s.file === 'leaf.ts')).toBe(true);
  });

  it('should filter sinks with exactly 3 structural in-degree', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts' },
        { path: 'b.ts' },
        { path: 'c.ts' },
        { path: 'shared.ts' },
      ],
      getAllEdges: () => [
        // data-bearing into shared
        { source_file: 'a.ts', target_file: 'shared.ts', edge_type: 'call' },
        // structural: exactly 3 imports
        { source_file: 'a.ts', target_file: 'shared.ts', edge_type: 'import' },
        { source_file: 'b.ts', target_file: 'shared.ts', edge_type: 'import' },
        { source_file: 'c.ts', target_file: 'shared.ts', edge_type: 'import' },
      ],
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    const sinks = tracer.findSinks();

    // shared.ts has structural in-degree of exactly 3, threshold is < 3
    // so it should be filtered OUT
    expect(sinks.every(s => s.file !== 'shared.ts')).toBe(true);
  });

  it('should only count structural edge types for the filtering threshold', () => {
    // Even if a file has many data-bearing incoming edges, it's the structural
    // in-degree that determines whether it's a "leaf library"
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts' },
        { path: 'b.ts' },
        { path: 'c.ts' },
        { path: 'target.ts' },
      ],
      getAllEdges: () => [
        // 5 data-bearing edges into target
        { source_file: 'a.ts', target_file: 'target.ts', edge_type: 'call' },
        { source_file: 'b.ts', target_file: 'target.ts', edge_type: 'call' },
        { source_file: 'c.ts', target_file: 'target.ts', edge_type: 'instantiation' },
        { source_file: 'a.ts', target_file: 'target.ts', edge_type: 'dispatch' },
        { source_file: 'b.ts', target_file: 'target.ts', edge_type: 'notify' },
        // Only 1 structural edge (below threshold)
        { source_file: 'a.ts', target_file: 'target.ts', edge_type: 'import' },
      ],
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    const sinks = tracer.findSinks();

    // target.ts has structural in-degree of only 1, so it should remain as a sink
    expect(sinks.some(s => s.file === 'target.ts')).toBe(true);
  });

  it('should return empty array when there are no sinks', () => {
    // Every file has outgoing data-bearing edges
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts' },
        { path: 'b.ts' },
      ],
      getAllEdges: () => [
        { source_file: 'a.ts', target_file: 'b.ts', edge_type: 'call' },
        { source_file: 'b.ts', target_file: 'a.ts', edge_type: 'call' },
      ],
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    const sinks = tracer.findSinks();
    expect(sinks).toHaveLength(0);
  });

  it('should include leaf libraries when includeLeafLibraries is set to true', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'src/main.ts' },
        { path: 'src/scanner.ts' },
        { path: 'src/parser.ts' },
        { path: 'src/utils/helpers.ts' },
        { path: 'src/sink.ts' },
      ],
      getAllEdges: () => [
        { source_file: 'src/main.ts', target_file: 'src/scanner.ts', edge_type: 'call' },
        { source_file: 'src/scanner.ts', target_file: 'src/parser.ts', edge_type: 'call' },
        { source_file: 'src/parser.ts', target_file: 'src/sink.ts', edge_type: 'call' },
        { source_file: 'src/main.ts', target_file: 'src/utils/helpers.ts', edge_type: 'call' },
        { source_file: 'src/main.ts', target_file: 'src/utils/helpers.ts', edge_type: 'import' },
        { source_file: 'src/scanner.ts', target_file: 'src/utils/helpers.ts', edge_type: 'import' },
        { source_file: 'src/parser.ts', target_file: 'src/utils/helpers.ts', edge_type: 'import' },
      ],
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    const sinks = tracer.findSinks(undefined, true);

    expect(sinks.some(s => s.file === 'src/utils/helpers.ts')).toBe(true);
    expect(sinks.some(s => s.file === 'src/sink.ts')).toBe(true);
  });
});
