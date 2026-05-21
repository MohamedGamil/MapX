import { execSync } from 'node:child_process';
import { Store } from '../core/store.js';
import { CodeGraph } from '../core/graph.js';
import { DotExporter } from './dot-exporter.js';

export class SvgExporter {
  private store: Store;
  private graph: CodeGraph;

  constructor(store: Store, graph: CodeGraph) {
    this.store = store;
    this.graph = graph;
  }

  export(repo?: string): string {
    const dotExporter = new DotExporter(this.store, this.graph);
    const dot = dotExporter.export(repo);

    try {
      return execSync('dot -Tsvg', {
        input: dot,
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return this.renderFallback(repo);
    }
  }

  private renderFallback(repo?: string): string {
    const files = this.store.getAllFiles(repo);
    const edges = this.store.getAllEdges(repo);
    const rankedFiles = this.graph.getRankedFiles();

    const langColors: Record<string, string> = {
      php: '#8892BF',
      javascript: '#F7DF1E',
      typescript: '#3178C6',
      python: '#3776AB',
      go: '#00ADD8',
      rust: '#DEA584',
      java: '#ED8B00',
    };

    const maxPr = Math.max(...rankedFiles.map(f => f.pagerank), 0.001);
    const rankMap = new Map(rankedFiles.map(f => [f.path, f.pagerank]));

    const NODE_H = 32;
    const NODE_PAD = 16;
    const COL_GAP = 180;
    const ROW_GAP = 12;
    const MARGIN = 40;

    const nodes: Array<{
      path: string;
      label: string;
      lang: string;
      color: string;
      x: number;
      y: number;
      w: number;
    }> = [];

    let maxLabelW = 0;
    for (const file of files) {
      const path = file.path as string;
      const label = path.split('/').pop() || path;
      const estW = label.length * 7.5 + NODE_PAD * 2;
      if (estW > maxLabelW) maxLabelW = estW;
      nodes.push({
        path,
        label,
        lang: file.language as string,
        color: langColors[file.language as string] || '#CCCCCC',
        x: 0,
        y: 0,
        w: estW,
      });
    }

    const nodeW = Math.max(maxLabelW, 120);
    const cols = Math.max(1, Math.floor(Math.sqrt(nodes.length * 1.5)));
    const rows = Math.ceil(nodes.length / cols);

    nodes.sort((a, b) => {
      const prA = rankMap.get(a.path) || 0;
      const prB = rankMap.get(b.path) || 0;
      return prB - prA;
    });

    for (let i = 0; i < nodes.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      nodes[i].x = MARGIN + col * (nodeW + COL_GAP);
      nodes[i].y = MARGIN + row * (NODE_H + ROW_GAP);
      nodes[i].w = nodeW;
    }

    const svgW = MARGIN * 2 + cols * nodeW + (cols - 1) * COL_GAP;
    const svgH = MARGIN * 2 + rows * NODE_H + (rows - 1) * ROW_GAP;

    const nodeMap = new Map(nodes.map(n => [n.path, n]));

    const edgeStyles: Record<string, { stroke: string; dash: string }> = {
      import: { stroke: '#666', dash: '' },
      require: { stroke: '#666', dash: '' },
      extends: { stroke: '#333', dash: '' },
      implements: { stroke: '#333', dash: '6,3' },
      call: { stroke: '#999', dash: '3,3' },
      instantiation: { stroke: '#999', dash: '3,3' },
    };

    const seen = new Set<string>();
    const edgeLines: string[] = [];
    for (const edge of edges) {
      const src = edge.source_file as string;
      const tgt = edge.target_file as string;
      const type = edge.edge_type as string;
      const key = `${src}->${tgt}:${type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const srcNode = nodeMap.get(src);
      const tgtNode = nodeMap.get(tgt);
      if (!srcNode || !tgtNode) continue;

      const sx = srcNode.x + srcNode.w / 2;
      const sy = srcNode.y + NODE_H;
      const tx = tgtNode.x + tgtNode.w / 2;
      const ty = tgtNode.y;

      const style = edgeStyles[type] || { stroke: '#666', dash: '' };
      const dashAttr = style.dash ? ` stroke-dasharray="${style.dash}"` : '';
      const midY = (sy + ty) / 2;

      edgeLines.push(
        `  <path d="M${sx},${sy} C${sx},${midY} ${tx},${midY} ${tx},${ty}" fill="none" stroke="${style.stroke}" stroke-width="1.2"${dashAttr}/>`,
      );
    }

    const nodeLines: string[] = [];
    for (const n of nodes) {
      const pr = rankMap.get(n.path) || 0;
      const opacity = 0.5 + 0.5 * (pr / maxPr);
      const textY = n.y + NODE_H / 2 + 4.5;
      const textColor = n.lang === 'javascript' ? '#333' : '#fff';

      nodeLines.push(
        `  <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${NODE_H}" rx="4" fill="${n.color}" opacity="${opacity.toFixed(2)}"/>`,
      );
      nodeLines.push(
        `  <text x="${n.x + n.w / 2}" y="${textY}" text-anchor="middle" fill="${textColor}" font-family="monospace" font-size="11">${this.escXml(n.label)}</text>`,
      );
      nodeLines.push(
        `  <title>${this.escXml(n.path)}</title>`,
      );
    }

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">`,
      '  <rect width="100%" height="100%" fill="#fafafa"/>',
      ...edgeLines,
      ...nodeLines,
      '</svg>',
    ].join('\n');
  }

  private escXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
