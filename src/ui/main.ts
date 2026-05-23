import cytoscape from 'cytoscape';

// Base Configuration and State
let currentTab = 'graph';
let cyInstance: any = null;

// Tab switcher logic
const tabs = document.querySelectorAll('.nav-item');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    const target = tab.getAttribute('data-tab') || 'graph';
    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    
    const targetPane = document.getElementById(`tab-${target}`);
    if (targetPane) targetPane.classList.add('active');
    
    currentTab = target;
    if (currentTab === 'graph') {
      setTimeout(() => {
        if (cyInstance) cyInstance.resize();
      }, 50);
    }
  });
});

// Subtabs inside Routes & Hooks
const subtabs = document.querySelectorAll('.tab-sub-btn');
subtabs.forEach(sub => {
  sub.addEventListener('click', () => {
    subtabs.forEach(s => s.classList.remove('active'));
    sub.classList.add('active');

    const target = sub.getAttribute('data-subtab') || 'subtab-routes-list';
    document.querySelectorAll('.subtab-pane').forEach(p => p.classList.remove('active'));

    const targetPane = document.getElementById(target);
    if (targetPane) targetPane.classList.add('active');
  });
});

// Setup Server Event Source (SSE)
function setupSSE() {
  const eventSource = new EventSource('/events');
  const logContainer = document.getElementById('tool-log-container');

  eventSource.addEventListener('tool-call', (event: any) => {
    try {
      const data = JSON.parse(event.data);
      if (logContainer) {
        const placeholder = logContainer.querySelector('.log-placeholder');
        if (placeholder) placeholder.remove();

        const entry = document.createElement('div');
        entry.className = 'log-entry';
        
        const timeStr = new Date(data.timestamp || Date.now()).toLocaleTimeString();
        entry.innerHTML = `
          <span class="log-time">[${timeStr}]</span>
          <span class="log-name">${data.tool}</span>
          <span class="log-input">(${JSON.stringify(data.input)})</span>
          ${data.error ? `<div class="log-result" style="color: #ef4444;">Error: ${data.error}</div>` : ''}
        `;
        logContainer.prepend(entry);
      }
    } catch (err) {
      console.error('Failed to parse SSE event:', err);
    }
  });

  eventSource.addEventListener('scan-progress', (event: any) => {
    try {
      const data = JSON.parse(event.data);
      const indicator = document.getElementById('repo-name');
      if (indicator) {
        indicator.textContent = `Scanning: ${data.current}/${data.total} (${Math.round((data.current/data.total)*100)}%)`;
      }
    } catch (err) {
      console.error(err);
    }
  });

  eventSource.addEventListener('scan-complete', (event: any) => {
    try {
      const indicator = document.getElementById('repo-name');
      if (indicator) {
        indicator.textContent = 'Scan Complete';
      }
      loadStatus();
      loadGraph();
    } catch (err) {
      console.error(err);
    }
  });
}

// Fetch general workspace status and populate stats
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const status = await res.json();
    
    document.getElementById('repo-name')!.textContent = status.repoName || 'MapX Project';
    document.getElementById('stat-files')!.textContent = status.fileCount || '0';
    document.getElementById('stat-symbols')!.textContent = status.symbolCount || '0';
    document.getElementById('stat-edges')!.textContent = status.edgeCount || '0';

    // Populate language filters in graph panel
    const filterSelect = document.getElementById('filter-lang') as HTMLSelectElement;
    if (filterSelect && status.languages) {
      filterSelect.innerHTML = '<option value="">All Languages</option>';
      Object.keys(status.languages).forEach(lang => {
        const opt = document.createElement('option');
        opt.value = lang;
        opt.textContent = lang.toUpperCase();
        filterSelect.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

let rawGraphElements: any[] = [];
let showClusters = false;

function buildGraphElements(rawElements: any[], useClusters: boolean): any[] {
  if (!useClusters) {
    // Return copy of elements without parent fields
    return rawElements.map(el => {
      if (el.data && el.data.parent) {
        const copy = JSON.parse(JSON.stringify(el));
        delete copy.data.parent;
        return copy;
      }
      return el;
    });
  }

  const processed: any[] = [];
  const filesByDirectory: { [dirId: string]: any[] } = {};
  
  const getParentId = (filePath: string): string => {
    const parts = filePath.split('/');
    return parts.length > 1 ? `dir:${parts.slice(0, -1).join('/')}` : 'dir:root';
  };

  // Group file nodes
  for (const el of rawElements) {
    if (el.data && el.data.type === 'file') {
      const parentId = getParentId(el.data.id);
      if (!filesByDirectory[parentId]) {
        filesByDirectory[parentId] = [];
      }
      const copy = JSON.parse(JSON.stringify(el));
      copy.data.parent = parentId;
      filesByDirectory[parentId].push(copy);
    }
  }

  // Get and sort directory IDs
  const dirIds = Object.keys(filesByDirectory).sort();
  const N = dirIds.length;
  
  // Calculate grid layout parameters for clear separation
  const cols = 3;
  const W = 550;
  const H = 450;

  for (let i = 0; i < N; i++) {
    const dirId = dirIds[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = col * W + W / 2;
    const cy = row * H + H / 2;

    // Add parent node
    processed.push({
      data: {
        id: dirId,
        label: dirId === 'dir:root' ? 'root' : dirId.replace('dir:', ''),
        type: 'parent'
      }
    });

    // Position children files in a concentric circle structure
    const files = filesByDirectory[dirId];
    const M = files.length;
    if (M > 0) {
      if (M === 1) {
        files[0].position = { x: cx, y: cy };
      } else if (M <= 8) {
        const R = 75;
        for (let j = 0; j < M; j++) {
          const angle = (j * 2 * Math.PI) / M;
          files[j].position = {
            x: cx + R * Math.cos(angle),
            y: cy + R * Math.sin(angle)
          };
        }
      } else if (M <= 16) {
        const innerCount = 6;
        const outerCount = M - innerCount;
        const R1 = 60;
        const R2 = 120;
        for (let j = 0; j < innerCount; j++) {
          const angle = (j * 2 * Math.PI) / innerCount;
          files[j].position = {
            x: cx + R1 * Math.cos(angle),
            y: cy + R1 * Math.sin(angle)
          };
        }
        for (let j = 0; j < outerCount; j++) {
          const angle = (j * 2 * Math.PI) / outerCount;
          files[innerCount + j].position = {
            x: cx + R2 * Math.cos(angle),
            y: cy + R2 * Math.sin(angle)
          };
        }
      } else {
        const innerCount = 5;
        const midCount = 10;
        const outerCount = M - 15;
        const R1 = 45;
        const R2 = 100;
        const R3 = 150;
        for (let j = 0; j < innerCount; j++) {
          const angle = (j * 2 * Math.PI) / innerCount;
          files[j].position = {
            x: cx + R1 * Math.cos(angle),
            y: cy + R1 * Math.sin(angle)
          };
        }
        for (let j = 0; j < midCount; j++) {
          const angle = (j * 2 * Math.PI) / midCount;
          files[innerCount + j].position = {
            x: cx + R2 * Math.cos(angle),
            y: cy + R2 * Math.sin(angle)
          };
        }
        for (let j = 0; j < outerCount; j++) {
          const angle = (j * 2 * Math.PI) / outerCount;
          files[15 + j].position = {
            x: cx + R3 * Math.cos(angle),
            y: cy + R3 * Math.sin(angle)
          };
        }
      }
      
      // Push files to elements list
      processed.push(...files);
    }
  }

  // Aggregate inter-cluster edges
  const interClusterEdges = new Map<string, { source: string, target: string, count: number }>();

  for (const el of rawElements) {
    if (el.data && el.data.source && el.data.target) {
      const src = el.data.source;
      const tgt = el.data.target;
      const parentSrc = getParentId(src);
      const parentTgt = getParentId(tgt);

      if (parentSrc !== parentTgt) {
        const edgeKey = `${parentSrc}->${parentTgt}`;
        if (!interClusterEdges.has(edgeKey)) {
          interClusterEdges.set(edgeKey, { source: parentSrc, target: parentTgt, count: 0 });
        }
        interClusterEdges.get(edgeKey)!.count++;
      } else {
        processed.push(JSON.parse(JSON.stringify(el)));
      }
    }
  }

  // Add aggregated inter-cluster edges
  for (const [key, info] of interClusterEdges.entries()) {
    processed.push({
      data: {
        id: `edge-cluster-${info.source}-${info.target}`,
        source: info.source,
        target: info.target,
        type: 'cluster-dependency',
        label: `${info.count}`,
        count: info.count
      }
    });
  }

  return processed;
}

function getLayoutOptions(useClusters: boolean, animate = true) {
  if (useClusters) {
    return {
      name: 'preset',
      animate: animate,
      animationDuration: 800,
      fit: true,
      padding: 50
    };
  } else {
    return {
      name: 'cose',
      animate: animate,
      nodeDimensionsIncludeLabels: true,
      nodeRepulsion: 75000,
      idealEdgeLength: 120,
      gravity: 0.1,
      nodeOverlap: 40,
      nestingFactor: 1.2,
      componentSpacing: 40,
      refresh: 20,
      fit: true,
      padding: 30,
      boundingBox: undefined
    };
  }
}

// Setup Cytoscape view and fetch graph
async function loadGraph() {
  try {
    const res = await fetch('/api/graph');
    if (!res.ok) return;
    rawGraphElements = await res.json();

    const container = document.getElementById('cy');
    if (!container) return;

    const initialElements = buildGraphElements(rawGraphElements, showClusters);

    if (initialElements.length === 0) {
      container.innerHTML = '<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; font-size: 15px; color: var(--text-muted); text-align: center; gap: 8px; padding: 20px;"><div style="font-size: 24px;">🕸️</div><div>No codebase graph elements found.</div><div style="font-size: 12px; opacity: 0.8;">Run a scan using the mapx CLI/MCP to index files and generate the graph.</div></div>';
      return;
    }

    container.innerHTML = '';

    cyInstance = cytoscape({
      container: container,
      elements: initialElements,
      wheelSensitivity: 4.2,
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            'color': '#abb2bf',
            'font-family': 'Outfit, sans-serif',
            'font-size': '11px',
            'font-weight': '600',
            'background-color': '#5c6370',
            'shape': 'ellipse',
            'width': '32px',
            'height': '32px',
            'text-valign': 'bottom',
            'text-margin-y': 6,
            'overlay-color': '#61afef',
            'overlay-opacity': 0.08,
            'text-outline-color': '#1e222b',
            'text-outline-width': '1px',
            'transition-property': 'opacity, width, height, border-color, border-width, background-color',
            'transition-duration': 0.2
          }
        },
        {
          selector: 'node[type="file"]',
          style: {
            'shape': 'ellipse',
            'border-width': '1px',
            'border-color': '#282c34'
          }
        },
        {
          selector: 'node[type="symbol"]',
          style: {
            'shape': 'ellipse',
            'border-width': '1px',
            'border-color': '#282c34'
          }
        },
        {
          selector: ':parent',
          style: {
            'background-color': 'rgba(40, 44, 52, 0.15)',
            'border-width': '1px',
            'border-color': '#3e4452',
            'border-style': 'dashed',
            'label': 'data(label)',
            'color': '#abb2bf',
            'font-family': 'Outfit, sans-serif',
            'font-size': '12px',
            'font-weight': 'bold',
            'text-valign': 'top',
            'text-halign': 'center',
            'text-outline-width': '1px',
            'text-outline-color': '#14161a',
            'padding': '20px'
          }
        },
        { selector: 'node[language="php"]', style: { 'background-color': '#c678dd' } },
        { selector: 'node[language="javascript"]', style: { 'background-color': '#e5c07b' } },
        { selector: 'node[language="typescript"]', style: { 'background-color': '#61afef' } },
        { selector: 'node[language="tsx"]', style: { 'background-color': '#61afef' } },
        { selector: 'node[language="python"]', style: { 'background-color': '#56b6c2' } },
        { selector: 'node[language="rust"]', style: { 'background-color': '#d19a66' } },
        { selector: 'node[language="go"]', style: { 'background-color': '#56b6c2' } },
        { selector: 'node[language="java"]', style: { 'background-color': '#c678dd' } },
        { selector: 'node[language="c_sharp"]', style: { 'background-color': '#e06c75' } },
        { selector: 'node[language="cpp"]', style: { 'background-color': '#e06c75' } },
        { selector: 'node[language="c"]', style: { 'background-color': '#5c6370' } },
        { selector: 'node[language="ruby"]', style: { 'background-color': '#e06c75' } },
        { selector: 'node[language="swift"]', style: { 'background-color': '#d19a66' } },
        { selector: 'node[language="kotlin"]', style: { 'background-color': '#c678dd' } },
        { selector: 'node[language="vue"]', style: { 'background-color': '#98c379' } },
        { selector: 'node[language="scala"]', style: { 'background-color': '#e06c75' } },
        { selector: 'node[language="dart"]', style: { 'background-color': '#56b6c2' } },
        {
          selector: 'edge',
          style: {
            'width': 1,
            'line-color': 'rgba(92, 99, 112, 0.18)',
            'target-arrow-color': 'rgba(92, 99, 112, 0.18)',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'overlay-color': '#61afef',
            'overlay-opacity': 0.05,
            'transition-property': 'opacity, width, line-color, target-arrow-color',
            'transition-duration': 0.2
          }
        },
        {
          selector: 'edge[type="route"]',
          style: {
            'line-color': 'rgba(152, 195, 121, 0.7)',
            'target-arrow-color': 'rgba(152, 195, 121, 0.7)'
          }
        },
        {
          selector: 'edge[type="cluster-dependency"]',
          style: {
            'width': '2px',
            'line-color': '#61afef',
            'target-arrow-color': '#61afef',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'label': 'data(label)',
            'color': '#61afef',
            'font-family': 'Outfit, sans-serif',
            'font-size': '10px',
            'font-weight': 'bold',
            'text-background-color': '#1e222b',
            'text-background-opacity': 0.95,
            'text-background-padding': '3px',
            'text-background-shape': 'roundrectangle'
          }
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': '1.5px',
            'border-color': '#61afef'
          }
        },
        {
          selector: '.dimmed',
          style: {
            'opacity': 0.15,
            'text-opacity': 0.15
          }
        },
        {
          selector: '.highlighted-center',
          style: {
            'width': '45px',
            'height': '45px',
            'border-width': '2px',
            'border-color': '#61afef',
            'overlay-opacity': 0.15,
            'z-index': 9999,
            'opacity': 1,
            'text-opacity': 1
          }
        },
        {
          selector: '.highlighted-outgoing',
          style: {
            'line-color': '#98c379',
            'target-arrow-color': '#98c379',
            'width': 2,
            'z-index': 9998,
            'opacity': 1
          }
        },
        {
          selector: '.highlighted-outgoing-node',
          style: {
            'width': '38px',
            'height': '38px',
            'font-size': '11.5px',
            'border-width': '1.8px',
            'border-color': '#98c379',
            'z-index': 9997,
            'opacity': 1,
            'text-opacity': 1
          }
        },
        {
          selector: '.highlighted-incoming',
          style: {
            'line-color': '#c678dd',
            'target-arrow-color': '#c678dd',
            'width': 2,
            'z-index': 9998,
            'opacity': 1
          }
        },
        {
          selector: '.highlighted-incoming-node',
          style: {
            'width': '38px',
            'height': '38px',
            'font-size': '11.5px',
            'border-width': '1.8px',
            'border-color': '#c678dd',
            'z-index': 9997,
            'opacity': 1,
            'text-opacity': 1
          }
        },
        {
          selector: ':parent.highlighted-parent-active',
          style: {
            'border-color': '#61afef',
            'border-width': '1.5px',
            'border-style': 'solid',
            'background-color': 'rgba(74, 82, 99, 0.55)',
            'color': '#61afef',
            'text-outline-color': '#14161a'
          }
        },
        {
          selector: ':parent.highlighted-parent-outgoing',
          style: {
            'border-color': '#98c379',
            'border-width': '1.5px',
            'border-style': 'solid',
            'background-color': 'rgba(74, 82, 99, 0.55)',
            'color': '#98c379',
            'text-outline-color': '#14161a'
          }
        },
        {
          selector: ':parent.highlighted-parent-incoming',
          style: {
            'border-color': '#c678dd',
            'border-width': '1.5px',
            'border-style': 'solid',
            'background-color': 'rgba(74, 82, 99, 0.55)',
            'color': '#c678dd',
            'text-outline-color': '#14161a'
          }
        }
      ],
      layout: getLayoutOptions(showClusters, false)
    });

    // Handle Layout button clicks
    document.getElementById('btn-layout-fcose')?.addEventListener('click', () => {
      cyInstance.layout(getLayoutOptions(showClusters, true)).run();
    });
    document.getElementById('btn-layout-circle')?.addEventListener('click', () => {
      cyInstance.layout({ name: 'circle', animate: true }).run();
    });
    document.getElementById('btn-layout-grid')?.addEventListener('click', () => {
      cyInstance.layout({ name: 'grid', animate: true }).run();
    });

    // Toggle clusters button listener
    document.getElementById('btn-toggle-clusters')?.addEventListener('click', (e) => {
      showClusters = !showClusters;
      const btn = e.currentTarget as HTMLButtonElement;
      if (showClusters) {
        btn.innerHTML = `
          <svg class="nav-svg-icon" style="width: 16px; height: 16px; stroke: currentColor;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="9"></rect>
            <rect x="14" y="3" width="7" height="5"></rect>
            <rect x="14" y="12" width="7" height="9"></rect>
            <rect x="3" y="16" width="7" height="5"></rect>
          </svg>
          <span>Hide Clusters</span>
        `;
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
      } else {
        btn.innerHTML = `
          <svg class="nav-svg-icon" style="width: 16px; height: 16px; stroke: currentColor;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="9"></rect>
            <rect x="14" y="3" width="7" height="5"></rect>
            <rect x="14" y="12" width="7" height="9"></rect>
            <rect x="3" y="16" width="7" height="5"></rect>
          </svg>
          <span>Show Clusters</span>
        `;
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
      }

      cyInstance.batch(() => {
        cyInstance.elements().remove();
        cyInstance.add(buildGraphElements(rawGraphElements, showClusters));
      });

      cyInstance.layout(getLayoutOptions(showClusters, true)).run();
    });

    // Filter by language dropdown listener
    document.getElementById('filter-lang')?.addEventListener('change', (e) => {
      const lang = (e.target as HTMLSelectElement).value;
      if (!lang) {
        cyInstance.elements().show();
      } else {
        cyInstance.elements().hide();
        cyInstance.elements(`node[language="${lang}"]`).show();
        cyInstance.elements(`node[language="${lang}"]`).connectedEdges().show();
        // Also show parent nodes if they exist so layout doesn't break
        cyInstance.elements(':parent').show();
      }
    });

    // Node & Edge selection details panel and highlighting
    cyInstance.on('tap', 'node', (evt: any) => {
      const node = evt.target;
      const data = node.data();
      const details = document.getElementById('details-content');
      if (details) {
        if (data.type === 'parent') {
          details.innerHTML = `
            <div style="font-family: 'JetBrains Mono', Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #cbd5e1; display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Type</span>
                <span style="color: #98c379; font-weight: bold; text-align: right; word-break: break-all;">DIRECTORY CLUSTER</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Path</span>
                <span style="word-break: break-all; text-align: right;">${data.id.replace('dir:', '')}</span>
              </div>
            </div>
          `;
        } else {
          details.innerHTML = `
            <div style="font-family: 'JetBrains Mono', Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #cbd5e1; display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Path</span>
                <span style="word-break: break-all; text-align: right;">${data.id}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Language</span>
                <span style="text-align: right; word-break: break-all;">${data.language ? data.language.toUpperCase() : 'UNKNOWN'}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Lines</span>
                <span style="text-align: right; word-break: break-all;">${data.lines || 'N/A'}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Size</span>
                <span style="text-align: right; word-break: break-all;">${data.size ? `${(data.size / 1024).toFixed(2)} KB` : 'N/A'}</span>
              </div>
            </div>
          `;
        }
      }

      cyInstance.batch(() => {
        // Reset classes
        cyInstance.elements().removeClass('dimmed highlighted-center highlighted-outgoing highlighted-outgoing-node highlighted-incoming highlighted-incoming-node highlighted-parent-active highlighted-parent-outgoing highlighted-parent-incoming');

        if (data.type === 'parent') {
          // Dim all elements not inside this parent
          cyInstance.elements().not(':parent').addClass('dimmed');
          node.addClass('highlighted-parent-active');
          node.children().removeClass('dimmed');
        } else {
          // Apply dimmed to all non-parent elements
          cyInstance.elements().not(':parent').addClass('dimmed');

          // Highlight selected node
          node.removeClass('dimmed').addClass('highlighted-center');
          if (node.parent() && node.parent().length > 0) {
            node.parent().addClass('highlighted-parent-active');
          }

          // Highlight outgoing edges and their target nodes (dependencies)
          const outgoers = node.outgoers();
          outgoers.forEach((ele: any) => {
            ele.removeClass('dimmed');
            if (ele.isEdge()) {
              ele.addClass('highlighted-outgoing');
            } else {
              ele.addClass('highlighted-outgoing-node');
              if (ele.parent() && ele.parent().length > 0) {
                ele.parent().addClass('highlighted-parent-outgoing');
              }
            }
          });

          // Highlight incoming edges and their source nodes (dependents)
          const incomers = node.incomers();
          incomers.forEach((ele: any) => {
            ele.removeClass('dimmed');
            if (ele.isEdge()) {
              ele.addClass('highlighted-incoming');
            } else {
              ele.addClass('highlighted-incoming-node');
              if (ele.parent() && ele.parent().length > 0) {
                ele.parent().addClass('highlighted-parent-incoming');
              }
            }
          });
        }
      });
    });

    cyInstance.on('tap', 'edge', (evt: any) => {
      const edge = evt.target;
      const data = edge.data();
      const details = document.getElementById('details-content');
      if (details) {
        if (data.type === 'cluster-dependency') {
          details.innerHTML = `
            <div style="font-family: 'JetBrains Mono', Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #cbd5e1; display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Edge ID</span>
                <span style="word-break: break-all; text-align: right;">${data.id}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Source</span>
                <span style="word-break: break-all; text-align: right;">${data.source.replace('dir:', '')}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Target</span>
                <span style="word-break: break-all; text-align: right;">${data.target.replace('dir:', '')}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Edge Type</span>
                <span style="text-align: right;"><span class="badge" style="background:#2563eb; padding:3px 6px; border-radius:4px; font-size:10px; color:#fff; font-family:inherit;">CLUSTER DEPENDENCY</span></span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Count</span>
                <span style="color: #61afef; font-weight: bold; text-align: right;">${data.count} file-level edge(s)</span>
              </div>
            </div>
          `;
        } else {
          details.innerHTML = `
            <div style="font-family: 'JetBrains Mono', Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #cbd5e1; display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Edge ID</span>
                <span style="word-break: break-all; text-align: right;">${data.id}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Source</span>
                <span style="word-break: break-all; text-align: right;">${data.source}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Target</span>
                <span style="word-break: break-all; text-align: right;">${data.target}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Edge Type</span>
                <span style="text-align: right;"><span class="badge" style="background:#8b5cf6; padding:3px 6px; border-radius:4px; font-size:10px; color:#fff; font-family:inherit;">${data.type}</span></span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start;">
                <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Verify</span>
                <span style="text-align: right; word-break: break-all;">${data.verifiability}</span>
              </div>
            </div>
          `;
        }
      }

      cyInstance.batch(() => {
        // Dim all non-parent elements
        cyInstance.elements().removeClass('dimmed highlighted-center highlighted-outgoing highlighted-outgoing-node highlighted-incoming highlighted-incoming-node highlighted-parent-active highlighted-parent-outgoing highlighted-parent-incoming');
        cyInstance.elements().not(':parent').addClass('dimmed');

        // Highlight this edge and its source & target nodes
        edge.removeClass('dimmed');
        const src = edge.source();
        const tgt = edge.target();
        src.removeClass('dimmed').addClass('highlighted-incoming-node');
        tgt.removeClass('dimmed').addClass('highlighted-outgoing-node');

        if (src.parent() && src.parent().length > 0) {
          src.parent().addClass('highlighted-parent-incoming');
        }
        if (tgt.parent() && tgt.parent().length > 0) {
          tgt.parent().addClass('highlighted-parent-outgoing');
        }
      });
    });

    cyInstance.on('tap', (evt: any) => {
      if (evt.target === cyInstance) {
        cyInstance.batch(() => {
          cyInstance.elements().removeClass('dimmed highlighted-center highlighted-outgoing highlighted-outgoing-node highlighted-incoming highlighted-incoming-node highlighted-parent-active highlighted-parent-outgoing highlighted-parent-incoming');
        });
        const details = document.getElementById('details-content');
        if (details) {
          details.innerHTML = 'Click a file node or dependency edge to view details.';
        }
      }
    });

  } catch (err) {
    console.error('Failed to load graph:', err);
  }
}

// Fetch symbols
async function loadSymbols(query: string = '') {
  try {
    const res = await fetch(`/api/symbols?q=${encodeURIComponent(query)}`);
    if (!res.ok) return;
    const symbols = await res.json();
    
    const tbody = document.querySelector('#table-symbols tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (symbols.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td colspan="3" style="text-align: center; color: var(--text-muted); padding: 30px; font-style: italic;">
          No symbols found matching "${query || ''}"
        </td>
      `;
      tbody.appendChild(tr);
      return;
    }

    symbols.forEach((s: any) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color:#60a5fa; font-weight:500;">${s.name}</td>
        <td>${s.kind}</td>
        <td style="color:#94a3b8; font-size:12px;">${s.file_path}</td>
      `;
      tr.addEventListener('click', () => loadSymbolDetails(s.name));
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Fetch specific symbol details
async function loadSymbolDetails(name: string) {
  try {
    const res = await fetch(`/api/symbol/${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const data = await res.json();

    const detailView = document.getElementById('symbol-detail-view');
    if (!detailView) return;

    detailView.innerHTML = `
      <div style="font-family: 'JetBrains Mono', Monaco, Consolas, monospace; font-size: 12px; line-height: 1.6; color: #cbd5e1; display: flex; flex-direction: column; gap: 16px; width: 100%; height: 100%; min-height: 0;">
        <div style="border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 12px; flex-shrink: 0;">
          <h3 style="margin: 0 0 6px 0; color: #e5c07b; font-size: 14px;">${data.symbol.name}</h3>
          <span style="background: rgba(229, 192, 123, 0.1); color: #e5c07b; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; text-transform: uppercase;">${data.symbol.kind}</span>
        </div>

        <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start; flex-shrink: 0;">
          <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">File</span>
          <span style="word-break: break-all; text-align: right;">${data.symbol.file_path}</span>
        </div>

        <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; align-items: start; flex-shrink: 0;">
          <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Lines</span>
          <span style="text-align: right;">${data.symbol.start_line}-${data.symbol.end_line}</span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; flex-shrink: 0;">
          <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase;">Callers (${data.callers.length})</span>
          <ul style="padding-left: 16px; margin: 4px 0 0 0; list-style-type: square; color: #abb2bf;">
            ${data.callers.map((c: any) => {
              const name = c.source_symbol;
              if (name && name !== '<top-level>') {
                return `<li style="margin-bottom: 4px;"><a href="#" class="symbol-link" data-symbol="${name}" style="color: #61afef; text-decoration: none; font-weight: 500;">${name}</a> <span style="color: #5c6370; font-size: 11px;">in ${c.source_file}</span></li>`;
              }
              return `<li style="margin-bottom: 4px; color: #5c6370;"><span style="color: #5c6370;">&lt;top-level&gt;</span> in ${c.source_file}</li>`;
            }).join('') || '<li style="color: #5c6370; list-style-type: none; margin-left: -16px;">None</li>'}
          </ul>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; flex-shrink: 0;">
          <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase;">Callees (${data.callees.length})</span>
          <ul style="padding-left: 16px; margin: 4px 0 0 0; list-style-type: square; color: #abb2bf;">
            ${data.callees.map((c: any) => {
              const name = c.target_symbol;
              if (name) {
                return `<li style="margin-bottom: 4px;"><a href="#" class="symbol-link" data-symbol="${name}" style="color: #61afef; text-decoration: none; font-weight: 500;">${name}</a> <span style="color: #5c6370; font-size: 11px;">in ${c.target_file}</span></li>`;
              }
              return `<li style="margin-bottom: 4px; color: #5c6370;">in ${c.target_file}</li>`;
            }).join('') || '<li style="color: #5c6370; list-style-type: none; margin-left: -16px;">None</li>'}
          </ul>
        </div>

        ${data.sourceCode ? `
          <div style="display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0;">
            <span style="color: #94a3b8; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Source Code</span>
            <pre class="neat-scrollbar" style="background: #1e1e24; color: #abb2bf; padding: 12px; border-radius: 6px; overflow: auto; font-family: inherit; font-size: 11px; margin: 4px 0 0 0; border: 1px solid rgba(255, 255, 255, 0.05); line-height: 1.5; flex: 1; min-height: 0;">${escapeHtml(data.sourceCode)}</pre>
          </div>
        ` : ''}
      </div>
    `;
  } catch (err) {
    console.error(err);
  }
}

// Fetch framework routes and hooks
async function loadRoutes() {
  try {
    const res = await fetch('/api/routes');
    if (!res.ok) return;
    const data = await res.json();

    const routesTbody = document.querySelector('#table-routes tbody');
    if (routesTbody) {
      routesTbody.innerHTML = '';
      if (!data.routes || data.routes.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 30px; font-style: italic;">
            No framework routes detected in this project.
          </td>
        `;
        routesTbody.appendChild(tr);
      } else {
        data.routes.forEach((r: any) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>${r.framework}</strong></td>
            <td><span style="background:#10b981; padding:2px 6px; border-radius:4px; font-size:11px; color:#fff;">${r.method}</span></td>
            <td><code>${r.path}</code></td>
            <td style="color:#60a5fa;">${r.handlerSymbol || r.handlerFile}</td>
          `;
          routesTbody.appendChild(tr);
        });
      }
    }

    const hooksTbody = document.querySelector('#table-hooks tbody');
    if (hooksTbody) {
      hooksTbody.innerHTML = '';
      if (!data.hooks || data.hooks.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 30px; font-style: italic;">
            No framework hooks/events detected in this project.
          </td>
        `;
        hooksTbody.appendChild(tr);
      } else {
        data.hooks.forEach((h: any) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>${h.framework}</strong></td>
            <td><span style="background:#8b5cf6; padding:2px 6px; border-radius:4px; font-size:11px; color:#fff;">${h.hookType}</span></td>
            <td><code>${h.hookName}</code></td>
            <td style="color:#60a5fa;">${h.handlerSymbol || h.handlerFile}</td>
          `;
          hooksTbody.appendChild(tr);
        });
      }
    }
  } catch (err) {
    console.error(err);
  }
}

// Fetch metrics & analytics
async function loadMetrics() {
  try {
    const res = await fetch('/api/metrics');
    if (!res.ok) return;
    const metrics = await res.json();

    const summary = document.getElementById('metrics-summary');
    if (summary) {
      summary.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div><strong>Total Codebase Volume:</strong> ${metrics.totalFiles || 0} files, ${metrics.totalSymbols || 0} symbols</div>
          <div><strong>Acyclic Graph Metrics:</strong> Density: ${metrics.density || 0} | Transitivity: ${metrics.transitivity || 0}</div>
        </div>
      `;
    }

    const topFilesList = document.getElementById('top-files-list');
    if (topFilesList) {
      if (metrics.topFiles && metrics.topFiles.length > 0) {
        topFilesList.innerHTML = metrics.topFiles.map((f: any) => `
          <li>${f.path} (PageRank: ${(f.pagerank || 0).toFixed(4)})</li>
        `).join('');
      } else {
        topFilesList.innerHTML = '<li style="color: var(--text-muted); list-style-type: none;">No files available in metrics</li>';
      }
    }

    const topSymbolsList = document.getElementById('top-symbols-list');
    if (topSymbolsList) {
      if (metrics.topSymbols && metrics.topSymbols.length > 0) {
        topSymbolsList.innerHTML = metrics.topSymbols.map((s: any) => `
          <li>${s.name} (PageRank: ${(s.pagerank || 0).toFixed(4)})</li>
        `).join('');
      } else {
        topSymbolsList.innerHTML = '<li style="color: var(--text-muted); list-style-type: none;">No symbols available in metrics</li>';
      }
    }

  } catch (err) {
    console.error(err);
  }
}

// Setup context builder events
function setupContextBuilder() {
  const btn = document.getElementById('btn-build-context');
  const taskText = document.getElementById('context-task') as HTMLTextAreaElement;
  const resultsDiv = document.getElementById('context-results');

  btn?.addEventListener('click', async () => {
    const task = taskText?.value || '';
    if (!task) return;

    if (resultsDiv) {
      resultsDiv.innerHTML = '<div class="details-placeholder">Building optimal context map...</div>';
    }

    try {
      const res = await fetch('/api/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task })
      });
      if (!res.ok) {
        const errData = await res.json();
        if (resultsDiv) resultsDiv.innerHTML = `<div class="details-placeholder" style="color:#ef4444;">Error: ${errData.error}</div>`;
        return;
      }
      const context = await res.json();
      if (resultsDiv) {
        resultsDiv.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:16px;">
            <h3>Context Analysis results</h3>
            <div><strong>Token Budget Used:</strong> ${context.estimatedTokens || 0} tokens</div>
            <div>
              <strong>Key Context Files:</strong>
              <ul style="padding-left:20px; margin-top:5px;">
                ${context.files && context.files.length > 0 ? context.files.map((f: any) => `<li><code>${f.path || f}</code></li>`).join('') : '<li style="color: var(--text-muted); list-style-type: none; margin-left: -20px;">None found</li>'}
              </ul>
            </div>
            <div>
              <strong>Relevant Entry Symbols:</strong>
              <ul style="padding-left:20px; margin-top:5px;">
                ${context.symbols && context.symbols.length > 0 ? context.symbols.map((s: any) => `<li><code>${s.name || s}</code></li>`).join('') : '<li style="color: var(--text-muted); list-style-type: none; margin-left: -20px;">None found</li>'}
              </ul>
            </div>
          </div>
        `;
      }
    } catch (err: any) {
      if (resultsDiv) resultsDiv.innerHTML = `<div class="details-placeholder" style="color:#ef4444;">Error: ${err.message}</div>`;
    }
  });
}

// Initialise everything
document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  loadGraph();
  loadSymbols();
  loadRoutes();
  loadMetrics();
  setupSSE();
  setupContextBuilder();

  // Search input listener for Symbol Explorer
  const symbolSearch = document.getElementById('symbol-search');
  symbolSearch?.addEventListener('input', (e) => {
    const query = (e.target as HTMLInputElement).value;
    loadSymbols(query);
  });

  // Click delegation for symbol explorer callers/callees links
  const symbolDetailView = document.getElementById('symbol-detail-view');
  symbolDetailView?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target && target.classList.contains('symbol-link')) {
      e.preventDefault();
      const symName = target.getAttribute('data-symbol');
      if (symName) {
        loadSymbolDetails(symName);
      }
    }
  });
});
