import { execSync } from 'node:child_process';
import { Store } from '../core/store.js';
import { MapxGraph } from '../core/graph.js';
import { DotExporter } from './dot-exporter.js';

export class SvgExporter {
  private store: Store;
  private graph: MapxGraph;

  constructor(store: Store, graph: MapxGraph) {
    this.store = store;
    this.graph = graph;
  }

  export(repo?: string, filesFilter?: string[], opts?: { cluster?: 'none' | 'auto'; depth?: number; forceFallback?: boolean }): string {
    if (opts?.forceFallback) {
      return this.renderFallback(repo, filesFilter, opts);
    }
    const dotExporter = new DotExporter(this.store, this.graph);
    const dot = dotExporter.export(repo, filesFilter, opts);

    try {
      return execSync('dot -Tsvg', {
        input: dot,
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return this.renderFallback(repo, filesFilter, opts);
    }
  }

  private renderFallback(repo?: string, filesFilter?: string[], opts?: { cluster?: 'none' | 'auto'; depth?: number; forceFallback?: boolean }): string {
    const clusterMode = opts?.cluster ?? 'none';
    let files = this.store.getAllFiles(repo);
    let edges = this.store.getAllEdges(repo);
    let rankedFiles = this.graph.getRankedFiles();

    if (filesFilter) {
      const allowed = new Set(filesFilter);
      files = files.filter(f => allowed.has(f.path as string));
      edges = edges.filter(e => allowed.has(e.source_file as string) && allowed.has(e.target_file as string));
      rankedFiles = rankedFiles.filter(f => allowed.has(f.path));
    }

    const langColors: Record<string, string> = {
      php: '#4f5b93',
      javascript: '#eab308',
      typescript: '#2563eb',
      python: '#3b82f6',
      go: '#06b6d4',
      rust: '#f97316',
      java: '#ea580c',
      c: '#0284c7',
      cpp: '#0284c7',
      csharp: '#0891b2',
      ruby: '#dc2626',
      swift: '#f97316',
      kotlin: '#7c3aed',
      scala: '#dc2626',
      shell: '#10b981',
      html: '#f97316',
      css: '#2563eb',
      sql: '#005b96',
      yaml: '#78716c',
      json: '#78716c',
      markdown: '#0f172a',
    };

    const maxPr = Math.max(...rankedFiles.map(f => f.pagerank), 0.001);
    const rankMap = new Map(rankedFiles.map(f => [f.path, f.pagerank]));

    const TARGET_WIDTH = 1200;
    const MARGIN = 40;
    const CARD_PADDING = 16;
    const TITLE_HEIGHT = 28;
    const CARD_GAP = 24;
    const ITEM_W = 160;
    const ITEM_H = 32;
    const ITEM_GAP_X = 12;
    const ITEM_GAP_Y = 8;

    const nodePositions = new Map<string, {
      x: number;
      y: number;
      w: number;
      h: number;
      file: typeof files[0];
    }>();

    let svgW = TARGET_WIDTH;
    let svgH = 0;
    const cardLines: string[] = [];

    if (clusterMode !== 'none') {
      const clusters = this.store.getClusters(repo);
      const memberships = this.store.getClusterMemberships(repo);
      const primaryMemberships = new Map<string, string>();
      for (const m of memberships) {
        if (m.is_primary === 1) {
          primaryMemberships.set(m.file_path as string, m.cluster_name as string);
        }
      }

      const clusterMap = new Map<string, typeof files>();
      const unclustered: typeof files = [];
      for (const f of files) {
        const cName = primaryMemberships.get(f.path as string);
        if (cName) {
          if (!clusterMap.has(cName)) {
            clusterMap.set(cName, []);
          }
          clusterMap.get(cName)!.push(f);
        } else {
          unclustered.push(f);
        }
      }

      interface ClusterGroup {
        name: string;
        label: string;
        files: typeof files;
        cols: number;
        width: number;
        height: number;
        x?: number;
        y?: number;
      }

      const getCols = (N: number): number => {
        if (N <= 3) return 1;
        if (N <= 8) return 2;
        if (N <= 15) return 3;
        if (N <= 30) return 4;
        return 5;
      };

      const groups: ClusterGroup[] = [];
      for (const [cName, fList] of clusterMap.entries()) {
        const clusterInfo = clusters.find(c => c.name === cName);
        const label = String(clusterInfo?.label || cName);
        fList.sort((a, b) => {
          const prA = rankMap.get(a.path as string) || 0;
          const prB = rankMap.get(b.path as string) || 0;
          return prB - prA;
        });

        const N = fList.length;
        const cols = getCols(N);
        const width = CARD_PADDING * 2 + cols * ITEM_W + (cols - 1) * ITEM_GAP_X;
        const rows = Math.ceil(N / cols);
        const height = CARD_PADDING * 2 + TITLE_HEIGHT + rows * ITEM_H + (rows - 1) * ITEM_GAP_Y;
        groups.push({
          name: cName,
          label,
          files: fList,
          cols,
          width,
          height
        });
      }

      if (unclustered.length > 0) {
        unclustered.sort((a, b) => {
          const prA = rankMap.get(a.path as string) || 0;
          const prB = rankMap.get(b.path as string) || 0;
          return prB - prA;
        });

        const N = unclustered.length;
        const cols = getCols(N);
        const width = CARD_PADDING * 2 + cols * ITEM_W + (cols - 1) * ITEM_GAP_X;
        const rows = Math.ceil(N / cols);
        const height = CARD_PADDING * 2 + TITLE_HEIGHT + rows * ITEM_H + (rows - 1) * ITEM_GAP_Y;
        groups.push({
          name: '__unclustered__',
          label: 'Other Files',
          files: unclustered,
          cols,
          width,
          height
        });
      }

      groups.sort((a, b) => b.files.length - a.files.length);

      let currentX = MARGIN;
      let currentY = MARGIN;
      let rowMaxHeight = 0;

      for (const group of groups) {
        if (currentX + group.width > TARGET_WIDTH - MARGIN && currentX > MARGIN) {
          currentX = MARGIN;
          currentY += rowMaxHeight + CARD_GAP;
          rowMaxHeight = 0;
        }
        group.x = currentX;
        group.y = currentY;

        cardLines.push(
          `  <!-- Cluster Group: ${this.escXml(group.name)} -->`,
          `  <rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="12" fill="#131b2e" stroke="#1e293b" stroke-width="1.5" class="cluster-card"/>`,
          `  <text x="${group.x + CARD_PADDING}" y="${group.y + CARD_PADDING + 14}" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" letter-spacing="0.5">${this.escXml(group.label.toUpperCase())}</text>`
        );

        const gX = group.x;
        const gY = group.y;
        const cols = group.cols;

        for (let idx = 0; idx < group.files.length; idx++) {
          const file = group.files[idx];
          const col = idx % cols;
          const row = Math.floor(idx / cols);

          const nodeX = gX + CARD_PADDING + col * (ITEM_W + ITEM_GAP_X);
          const nodeY = gY + CARD_PADDING + TITLE_HEIGHT + row * (ITEM_H + ITEM_GAP_Y);

          nodePositions.set(file.path as string, {
            x: nodeX,
            y: nodeY,
            w: ITEM_W,
            h: ITEM_H,
            file
          });
        }

        currentX += group.width + CARD_GAP;
        if (group.height > rowMaxHeight) {
          rowMaxHeight = group.height;
        }
      }

      svgH = currentY + rowMaxHeight + MARGIN;
    } else {
      const GAP_X = 16;
      const GAP_Y = 12;
      const cols = Math.max(1, Math.floor((TARGET_WIDTH - MARGIN * 2 + GAP_X) / (ITEM_W + GAP_X)));

      files.sort((a, b) => {
        const prA = rankMap.get(a.path as string) || 0;
        const prB = rankMap.get(b.path as string) || 0;
        return prB - prA;
      });

      for (let i = 0; i < files.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const nodeX = MARGIN + col * (ITEM_W + GAP_X);
        const nodeY = MARGIN + row * (ITEM_H + GAP_Y);

        nodePositions.set(files[i].path as string, {
          x: nodeX,
          y: nodeY,
          w: ITEM_W,
          h: ITEM_H,
          file: files[i]
        });
      }

      const rows = Math.ceil(files.length / cols);
      svgH = MARGIN * 2 + rows * ITEM_H + (rows - 1) * GAP_Y;
    }

    const edgeStyles: Record<string, { stroke: string; dash: string }> = {
      import: { stroke: '#64748b', dash: '' },
      require: { stroke: '#64748b', dash: '' },
      extends: { stroke: '#3b82f6', dash: '' },
      implements: { stroke: '#10b981', dash: '4,4' },
      call: { stroke: '#f59e0b', dash: '3,3' },
      instantiation: { stroke: '#8b5cf6', dash: '3,3' },
      relation: { stroke: '#3b82f6', dash: '' },
      route: { stroke: '#10b981', dash: '' },
      binding: { stroke: '#8b5cf6', dash: '4,4' },
      middleware: { stroke: '#f97316', dash: '2,2' },
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

      const srcNode = nodePositions.get(src);
      const tgtNode = nodePositions.get(tgt);
      if (!srcNode || !tgtNode) continue;

      const sx = srcNode.x + srcNode.w / 2;
      const sy = srcNode.y + ITEM_H;
      const tx = tgtNode.x + tgtNode.w / 2;
      const ty = tgtNode.y;

      const style = edgeStyles[type] || { stroke: '#64748b', dash: '' };
      const dash = edge.verifiability === 'inferred' ? '5,5' : style.dash;
      const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
      const midY = (sy + ty) / 2;

      edgeLines.push(
        `  <path d="M${sx},${sy} C${sx},${midY} ${tx},${midY} ${tx},${ty}" fill="none" stroke="${style.stroke}" stroke-width="1.2"${dashAttr} opacity="0.35" class="edge-path" marker-end="url(#arrow)"/>`,
      );
    }

    const nodeLines: string[] = [];
    for (const [path, n] of nodePositions.entries()) {
      const pr = rankMap.get(path) || 0;
      const opacity = 0.7 + 0.3 * (pr / maxPr);
      const textY = n.y + ITEM_H / 2 + 4.5;
      const color = langColors[n.file.language as string] || '#CCCCCC';
      const textColor = '#ffffff';
      const isHighRank = pr > maxPr * 0.5;
      const strokeAttr = isHighRank ? ` stroke="#60a5fa" stroke-width="1.5"` : ` stroke="#1e293b" stroke-width="1"`;

      const filePath = String(n.file.path || '');
      nodeLines.push(
        `  <g class="node-group">`,
        `    <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${ITEM_H}" rx="6" fill="${color}" opacity="${opacity.toFixed(2)}"${strokeAttr} class="node-rect"/>`,
        `    <text x="${n.x + n.w / 2}" y="${textY}" text-anchor="middle" fill="${textColor}" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="500">${this.escXml(filePath.split('/').pop() || filePath)}</text>`,
        `    <title>${this.escXml(filePath)} (PageRank: ${pr.toFixed(4)})</title>`,
        `  </g>`,
      );
    }

    const styleBlock = [
      '  <style>',
      '    .cluster-card {',
      '      transition: stroke 0.2s ease, fill 0.2s ease;',
      '    }',
      '    .cluster-card:hover {',
      '      stroke: #475569;',
      '      fill: #1e293b;',
      '    }',
      '    .node-rect {',
      '      transition: filter 0.2s ease, stroke 0.2s ease;',
      '    }',
      '    .node-rect:hover {',
      '      filter: brightness(1.2);',
      '      stroke: #60a5fa;',
      '      stroke-width: 1.5px;',
      '      cursor: pointer;',
      '    }',
      '    .edge-path {',
      '      transition: opacity 0.2s ease, stroke-width 0.2s ease;',
      '    }',
      '    .edge-path:hover {',
      '      opacity: 0.85;',
      '      stroke-width: 2px;',
      '    }',
      '  </style>'
    ].join('\n');

    const defs = [
      '  <defs>',
      '    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
      '      <path d="M 0 2 L 8 5 L 0 8 z" fill="#64748b"/>',
      '    </marker>',
      '  </defs>'
    ].join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">`,
      styleBlock,
      defs,
      '  <rect width="100%" height="100%" fill="#0b0f19"/>',
      ...cardLines,
      ...edgeLines,
      ...nodeLines,
      '</svg>',
    ].join('\n');
  }

  private escXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
