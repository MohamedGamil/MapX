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

    const target = sub.getAttribute('data-subtab') || 'routes-list';
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
    
    document.getElementById('repo-name')!.textContent = status.repoName || 'Mapx Project';
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

// Setup Cytoscape view and fetch graph
async function loadGraph() {
  try {
    const res = await fetch('/api/graph');
    if (!res.ok) return;
    const elements = await res.json();

    const container = document.getElementById('cy');
    if (!container) return;

    cyInstance = cytoscape({
      container: container,
      elements: elements,
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            'color': '#cbd5e1',
            'font-family': 'Outfit, sans-serif',
            'font-size': '11px',
            'background-color': '#3b82f6',
            'width': '35px',
            'height': '35px',
            'text-valign': 'bottom',
            'text-margin-y': 6,
            'overlay-color': '#3b82f6',
            'overlay-opacity': 0.2
          }
        },
        {
          selector: 'node[language="php"]',
          style: { 'background-color': '#4f5b93' }
        },
        {
          selector: 'node[language="javascript"]',
          style: { 'background-color': '#f7df1e' }
        },
        {
          selector: 'node[language="typescript"]',
          style: { 'background-color': '#3178c6' }
        },
        {
          selector: 'node[language="python"]',
          style: { 'background-color': '#3776ab' }
        },
        {
          selector: 'node[language="rust"]',
          style: { 'background-color': '#dea584' }
        },
        {
          selector: 'edge',
          style: {
            'width': 2,
            'line-color': 'rgba(255, 255, 255, 0.15)',
            'target-arrow-color': 'rgba(255, 255, 255, 0.15)',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'overlay-color': '#fff',
            'overlay-opacity': 0.1
          }
        },
        {
          selector: 'edge[type="route"]',
          style: {
            'line-color': '#10b981',
            'target-arrow-color': '#10b981'
          }
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': '3px',
            'border-color': '#fff'
          }
        }
      ],
      layout: {
        name: 'cose',
        animate: false
      }
    });

    // Handle Layout button clicks
    document.getElementById('btn-layout-fcose')?.addEventListener('click', () => {
      cyInstance.layout({ name: 'cose', animate: true }).run();
    });
    document.getElementById('btn-layout-circle')?.addEventListener('click', () => {
      cyInstance.layout({ name: 'circle', animate: true }).run();
    });
    document.getElementById('btn-layout-grid')?.addEventListener('click', () => {
      cyInstance.layout({ name: 'grid', animate: true }).run();
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
      }
    });

    // Node & Edge selection details panel
    cyInstance.on('tap', 'node', (evt: any) => {
      const node = evt.target;
      const data = node.data();
      const details = document.getElementById('details-content');
      if (details) {
        details.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:8px;">
            <div><strong>Path:</strong> <span style="word-break:break-all;">${data.id}</span></div>
            <div><strong>Language:</strong> ${data.language ? data.language.toUpperCase() : 'Unknown'}</div>
            <div><strong>Lines of Code:</strong> ${data.lines || 'N/A'}</div>
            <div><strong>File Size:</strong> ${data.size ? `${(data.size / 1024).toFixed(2)} KB` : 'N/A'}</div>
          </div>
        `;
      }
    });

    cyInstance.on('tap', 'edge', (evt: any) => {
      const edge = evt.target;
      const data = edge.data();
      const details = document.getElementById('details-content');
      if (details) {
        details.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:8px;">
            <div><strong>Edge ID:</strong> ${data.id}</div>
            <div><strong>Source File:</strong> <span style="word-break:break-all;">${data.source}</span></div>
            <div><strong>Target File:</strong> <span style="word-break:break-all;">${data.target}</span></div>
            <div><strong>Edge Type:</strong> <span class="badge" style="background:#8b5cf6; padding:3px 6px; border-radius:4px; font-size:11px;">${data.type}</span></div>
            <div><strong>Verifiability:</strong> ${data.verifiability}</div>
          </div>
        `;
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

// Fetch specific symbol details
async function loadSymbolDetails(name: string) {
  try {
    const res = await fetch(`/api/symbol/${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const data = await res.json();

    const detailView = document.getElementById('symbol-detail-view');
    if (!detailView) return;

    detailView.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:16px;">
        <h3>${data.symbol.name} (${data.symbol.kind})</h3>
        <div><strong>File:</strong> ${data.symbol.file_path} (Lines ${data.symbol.start_line}-${data.symbol.end_line})</div>
        
        <div>
          <strong>Callers (${data.callers.length}):</strong>
          <ul style="padding-left: 20px; margin-top:5px;">
            ${data.callers.map((c: any) => `<li>${c.source_symbol || 'unknown'}</li>`).join('') || '<li>None</li>'}
          </ul>
        </div>

        <div>
          <strong>Callees (${data.callees.length}):</strong>
          <ul style="padding-left: 20px; margin-top:5px;">
            ${data.callees.map((c: any) => `<li>${c.target_symbol || 'unknown'}</li>`).join('') || '<li>None</li>'}
          </ul>
        </div>

        ${data.sourceCode ? `
          <div>
            <strong>Source Code:</strong>
            <pre style="background:#090d16; padding:12px; border-radius:6px; overflow-x:auto; font-family:'JetBrains Mono', monospace; font-size:12px; margin-top:5px;">${data.sourceCode}</pre>
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

    const hooksTbody = document.querySelector('#table-hooks tbody');
    if (hooksTbody) {
      hooksTbody.innerHTML = '';
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
    if (topFilesList && metrics.topFiles) {
      topFilesList.innerHTML = metrics.topFiles.map((f: any) => `
        <li>${f.path} (PageRank: ${(f.pagerank || 0).toFixed(4)})</li>
      `).join('');
    }

    const topSymbolsList = document.getElementById('top-symbols-list');
    if (topSymbolsList && metrics.topSymbols) {
      topSymbolsList.innerHTML = metrics.topSymbols.map((s: any) => `
        <li>${s.name} (PageRank: ${(s.pagerank || 0).toFixed(4)})</li>
      `).join('');
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
                ${context.files?.map((f: any) => `<li><code>${f.path || f}</code></li>`).join('') || '<li>None</li>'}
              </ul>
            </div>
            <div>
              <strong>Relevant Entry Symbols:</strong>
              <ul style="padding-left:20px; margin-top:5px;">
                ${context.symbols?.map((s: any) => `<li><code>${s.name || s}</code></li>`).join('') || '<li>None</li>'}
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
});
