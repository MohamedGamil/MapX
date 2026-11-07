// fCoSE layout off the main thread (M4-20). The dashboard posts the visible graph (node ids, parents,
// sizes including labels, and edges) with the layout options; this worker runs the layout on a
// headless cytoscape and posts back each node's position. Large graphs no longer freeze the page.
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';

cytoscape.use(fcose);

export interface LayoutRequest {
  seq: number;
  nodes: Array<{ id: string; parent?: string; w: number; h: number; x: number; y: number }>;
  edges: Array<{ id: string; source: string; target: string }>;
  options: Record<string, unknown>;
}
export interface LayoutResult {
  seq: number;
  positions?: Record<string, { x: number; y: number }>;
  error?: string;
  ms?: number;
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { seq, nodes, edges, options } = event.data;
  const started = performance.now();
  try {
    const cy = cytoscape({
      headless: true,
      styleEnabled: true,
      elements: [
        ...nodes.map((n) => ({ group: 'nodes' as const, data: { id: n.id, parent: n.parent, w: n.w, h: n.h }, position: { x: n.x, y: n.y } })),
        ...edges.map((e) => ({ group: 'edges' as const, data: { id: e.id, source: e.source, target: e.target } })),
      ],
      style: [
        { selector: 'node', style: { width: 'data(w)', height: 'data(h)' } },
        { selector: ':parent', style: { padding: '30px' } },
      ] as any,
    });
    const layout = cy.layout({ ...options, name: 'fcose', animate: false, fit: false, nodeDimensionsIncludeLabels: false } as any);
    layout.run();
    const positions: Record<string, { x: number; y: number }> = {};
    cy.nodes().forEach((n) => {
      // Compound parents follow their children; only leaves are positioned by the caller.
      if (!n.isParent()) positions[n.id()] = n.position();
    });
    cy.destroy();
    (self as any).postMessage({ seq, positions, ms: Math.round(performance.now() - started) } satisfies LayoutResult);
  } catch (err) {
    (self as any).postMessage({ seq, error: err instanceof Error ? err.message : String(err) } satisfies LayoutResult);
  }
};
