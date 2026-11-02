import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { DETAILS_PLACEHOLDER, initDetailsPanel, initNavDrawer, initTheme } from './chrome.js';

cytoscape.use(fcose);

/**
 * Layout engines other than the default (fCoSE) load on first use (M4-20): ELK alone was two
 * thirds of the dashboard's JavaScript, and few sessions pick it.
 */
const LAZY_LAYOUTS: Record<string, () => Promise<any>> = {
  elk: () => import('cytoscape-elk'),
  cola: () => import('cytoscape-cola'),
  dagre: () => import('cytoscape-dagre'),
};
const loadedLayouts = new Set<string>();

/** Loads and registers a lazy layout engine; null when it is built in or already loaded. */
function ensureLayout(name: string): Promise<void> | null {
  const load = LAZY_LAYOUTS[name];
  if (!load || loadedLayouts.has(name)) return null;
  return load().then((mod) => {
    if (!loadedLayouts.has(name)) {
      cytoscape.use(mod.default ?? mod);
      loadedLayouts.add(name);
    }
  });
}

// Base Configuration and State
let currentTab = 'graph';
let cyInstance: any = null;

/**
 * The graph's state on `<body data-graph>` (loading, layout, ready, empty, error), and a
 * `mapx:graph-ready` performance mark each time a layout finishes: what the browser tests and
 * the audit wait on and time (M4-19).
 */
function markGraph(state: 'loading' | 'layout' | 'ready' | 'empty' | 'error') {
  document.body.dataset.graph = state;
  if (state === 'ready') performance.mark('mapx:graph-ready');
}

// ---- Workspace repos (M4-21) ----
/** The repo every view is scoped to, or null for all repos; kept in the URL as ?repo=. */
let currentRepo: string | null = new URLSearchParams(location.search).get('repo') || null;
let workspaceRepos: any[] = [];
let workspaceCross: any[] = [];
let primaryRepo = '';

/**
 * An API path scoped to the current repo. `any`: graph, symbols, routes (every repo by default).
 * `set`: clusters and smells (all repos when none is chosen). `single`: profile, DSM, metrics,
 * which are per repo (the primary repo when none is chosen).
 */
function withRepo(path: string, kind: 'any' | 'set' | 'single'): string {
  const repo = currentRepo ?? (kind === 'set' && workspaceRepos.length > 1 ? 'all' : null);
  return repo ? `${path}${path.includes('?') ? '&' : '?'}repo=${encodeURIComponent(repo)}` : path;
}

/** The sidebar's figures for the chosen repo (the whole workspace otherwise, from /api/status). */
function showRepoStats() {
  const repo = currentRepo ? workspaceRepos.find((r) => r.name === currentRepo) : null;
  if (!repo) return;
  document.getElementById('repo-name')!.textContent = repo.name;
  document.getElementById('stat-files')!.textContent = String(repo.files);
  document.getElementById('stat-symbols')!.textContent = String(repo.symbols);
  document.getElementById('stat-edges')!.textContent = String(repo.edges);
}

/** Per-repo views say which repo they show when the switcher is on "All repos". */
function updateScopeNotes() {
  const show = !currentRepo && workspaceRepos.length > 1;
  document.querySelectorAll<HTMLElement>('[data-scope-note]').forEach((el) => {
    el.hidden = !show;
    el.textContent = show ? `Showing the primary repo, ${primaryRepo}. Choose a repo in the sidebar to see another.` : '';
  });
}

function renderWorkspace() {
  const tbody = document.querySelector('#table-repos tbody');
  if (tbody) {
    tbody.innerHTML = workspaceRepos.map((r) => `
      <tr class="${r.name === currentRepo ? 'current-repo' : ''}">
        <td><button type="button" class="link-btn" data-repo="${escapeHtml(r.name)}">${escapeHtml(r.name)}</button>${r.name === primaryRepo ? ' <span class="selection-badge" style="--badge: var(--syntax-blue);">primary</span>' : ''}</td>
        <td class="col-optional"><code>${escapeHtml(r.path)}</code></td>
        <td class="num">${escapeHtml(Number(r.files).toLocaleString())}</td>
        <td class="num col-optional">${escapeHtml(Number(r.symbols).toLocaleString())}</td>
        <td class="num col-optional">${escapeHtml(Number(r.edges).toLocaleString())}</td>
        <td class="num">${escapeHtml(Number(r.crossRepoEdgeCount).toLocaleString())}</td>
        <td class="col-optional">${escapeHtml(r.lastScanned ? new Date(r.lastScanned).toLocaleString() : 'never')}</td>
        <td class="col-optional">${escapeHtml(!r.git?.isGit ? 'no git' : `${r.git.head ?? '?'}${r.git.changesSinceScan ? ` · ${r.git.changesSinceScan} changed since scan` : ' · up to date'}`)}</td>
      </tr>`).join('');
  }
  const cross = document.getElementById('workspace-cross');
  if (cross) {
    cross.innerHTML = workspaceCross.length
      ? workspaceCross.map((p) => `
        <div class="cross-pair"><strong>${escapeHtml(p.from)}</strong><span class="arrow" aria-label="calls">→</span><strong>${escapeHtml(p.to)}</strong>
          <span class="profile-pill">${escapeHtml(p.types.join(', '))}</span><span class="count">${escapeHtml(Number(p.count).toLocaleString())} edges</span></div>`).join('')
      : '<div class="details-placeholder" style="margin-top: 0; text-align: left;">No edges between repos.</div>';
  }
}

/** Loads the repo list: the switcher (more than one repo), the Workspace tab and the scope notes. */
async function loadRepos() {
  try {
    const res = await fetch('/api/repos');
    if (!res.ok) return;
    const data = await res.json();
    workspaceRepos = data.repos ?? [];
    workspaceCross = data.crossRepo ?? [];
    primaryRepo = data.primary ?? '';
    // A repo from the URL that does not exist (mistyped, or removed since): show all repos, and
    // reload the views that asked for it before the list arrived.
    if (currentRepo && !workspaceRepos.some((r) => r.name === currentRepo)) setRepo(null);
    const switcher = document.getElementById('repo-switcher');
    const select = document.getElementById('select-repo') as HTMLSelectElement | null;
    if (switcher && select) {
      switcher.hidden = workspaceRepos.length < 2;
      select.innerHTML = `<option value="">All repos (${workspaceRepos.length})</option>` +
        workspaceRepos.map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
      select.value = currentRepo ?? '';
    }
    renderWorkspace();
    updateScopeNotes();
    showRepoStats();
  } catch (err) {
    console.error('Failed to load repos:', err);
  }
}

/**
 * Bumped on each repo switch: a loader that started for an earlier repo drops its response when it
 * arrives after a newer choice (review 2026-11-02).
 */
let repoGeneration = 0;

/** Scopes the dashboard to a repo (null: all), in the URL too, and reloads every view. */
function setRepo(repo: string | null, reload = true) {
  repoGeneration++;
  currentRepo = repo;
  activeClusterId = null; // another repo's clusters
  focusSeedNode = null;
  const url = new URL(location.href);
  if (repo) url.searchParams.set('repo', repo); else url.searchParams.delete('repo');
  history.replaceState(null, '', url);
  const select = document.getElementById('select-repo') as HTMLSelectElement | null;
  if (select) select.value = repo ?? '';
  renderWorkspace();
  updateScopeNotes();
  if (!reload) return;
  if (!repo) loadStatus(); else showRepoStats();
  loadGraph();
  symbolPage = 0;
  loadSymbols(symbolSearchQuery);
  loadRoutes();
  loadMetrics();
  if (architectureLoaded) loadArchitecture();
  if (httpData) loadHttp();
}

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
      if (cyInstance) cyInstance.resize(); // now, before any control on the tab runs a layout
      setTimeout(() => {
        if (cyInstance) cyInstance.resize();
      }, 50);
    } else if (currentTab === 'architecture') {
      loadArchitecture();
    } else if (currentTab === 'config') {
      loadConfigView();
    } else if (currentTab === 'http') {
      loadHttp();
    }
  });
});

// Subtabs inside Routes & Hooks
const subtabs = document.querySelectorAll('.tab-sub-btn');
subtabs.forEach(sub => {
  sub.addEventListener('click', () => {
    subtabs.forEach(s => {
      s.classList.remove('active');
      s.setAttribute('aria-selected', 'false');
      s.setAttribute('tabindex', '-1');
    });
    sub.classList.add('active');
    sub.setAttribute('aria-selected', 'true');
    sub.removeAttribute('tabindex');

    const target = sub.getAttribute('data-subtab') || 'subtab-routes-list';
    document.querySelectorAll('.subtab-pane').forEach(p => p.classList.remove('active'));

    const targetPane = document.getElementById(target);
    if (targetPane) targetPane.classList.add('active');
  });
});

// Arrow keys move between the sub-tabs (the WAI-ARIA tabs pattern: one Tab stop, arrows inside).
subtabs.forEach((sub, i) => {
  sub.addEventListener('keydown', (e: Event) => {
    const key = (e as KeyboardEvent).key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    e.preventDefault();
    const next = subtabs[(i + (key === 'ArrowRight' ? 1 : subtabs.length - 1)) % subtabs.length] as HTMLElement;
    next.click();
    next.focus();
  });
});

// Track seen tool call IDs to avoid duplicates from SSE + history
const seenToolCallIds = new Set<string>();
const TOOL_LOG_PAGE_SIZE = 50;
let toolLogOffset = 0;
let toolLogTotal = 0;
let toolLogLoading = false;

function toolCallId(data: any): string {
  return `${data.tool}:${data.timestamp}:${data.durationMs || 0}`;
}

function renderToolCallEntry(data: any): HTMLElement {
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const timeStr = new Date(data.timestamp || Date.now()).toLocaleTimeString();
  const durationStr = data.durationMs != null ? ` <span class="log-duration">${escapeHtml(data.durationMs)}ms</span>` : '';
  const statusIcon = data.success === false ? '❌' : '✅';

  entry.innerHTML = `
    <span class="log-time">[${escapeHtml(timeStr)}]</span>
    <span class="log-status">${statusIcon}</span>
    <span class="log-name">${escapeHtml(data.tool)}</span>
    <span class="log-input">(${escapeHtml(JSON.stringify(data.input))})</span>${durationStr}
    ${data.error ? `<div class="log-result" style="color: var(--danger);">Error: ${escapeHtml(data.error)}</div>` : ''}
  `;
  return entry;
}

// Load historical tool calls from persistent log (paginated)
async function loadToolCallHistory() {
  if (toolLogLoading) return;
  toolLogLoading = true;
  const logContainer = document.getElementById('tool-log-container');
  const sentinel = document.getElementById('tool-log-sentinel');
  if (sentinel) sentinel.classList.add('loading');
  try {
    const res = await fetch(`/api/tool-calls?limit=${TOOL_LOG_PAGE_SIZE}&offset=${toolLogOffset}`);
    if (!res.ok) return;
    const { events, total } = await res.json();
    toolLogTotal = total;

    if (events.length > 0 && logContainer) {
      const placeholder = logContainer.querySelector('.log-placeholder');
      if (placeholder) placeholder.remove();
      for (const data of events) {
        const id = toolCallId(data);
        if (seenToolCallIds.has(id)) continue;
        seenToolCallIds.add(id);
        // insert before sentinel so older entries accumulate above it
        logContainer.insertBefore(renderToolCallEntry(data), sentinel ?? null);
      }
      toolLogOffset += events.length;
    }

    if (sentinel) {
      sentinel.classList.remove('loading');
      sentinel.style.display = toolLogOffset >= toolLogTotal ? 'none' : '';
    }
  } catch (err) {
    console.error('Failed to load tool call history:', err);
    if (sentinel) sentinel.classList.remove('loading');
  } finally {
    toolLogLoading = false;
  }
}

// Setup Server Event Source (SSE)
function setupSSE() {
  const eventSource = new EventSource('/events');
  const logContainer = document.getElementById('tool-log-container');

  eventSource.addEventListener('tool-call', (event: any) => {
    try {
      const data = JSON.parse(event.data);
      const id = toolCallId(data);
      if (seenToolCallIds.has(id)) return; // Skip duplicates
      seenToolCallIds.add(id);

      if (logContainer) {
        const placeholder = logContainer.querySelector('.log-placeholder');
        if (placeholder) placeholder.remove();
        logContainer.prepend(renderToolCallEntry(data));
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
        indicator.textContent = `Scanning: ${data.current}/${data.total} (${Math.round((data.current / data.total) * 100)}%)`;
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

let lastFileCount = 0;
let lastSymbolCount = 0;
let lastEdgeCount = 0;

// Fetch general workspace status and populate stats
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const status = await res.json();

    lastFileCount = status.fileCount || 0;
    lastSymbolCount = status.symbolCount || 0;
    lastEdgeCount = status.edgeCount || 0;

    document.getElementById('repo-name')!.textContent = status.repoName || 'MapX Project';
    document.getElementById('stat-files')!.textContent = String(lastFileCount);
    document.getElementById('stat-symbols')!.textContent = String(lastSymbolCount);
    document.getElementById('stat-edges')!.textContent = String(lastEdgeCount);
    showRepoStats();

    // Populate language filters in graph panel
    const filterSelect = document.getElementById('filter-lang') as HTMLSelectElement;
    if (filterSelect && status.languages) {
      filterSelect.innerHTML = '<option value="">All Languages</option>';
      Object.keys(status.languages).forEach(lang => {
        const opt = document.createElement('option');
        opt.value = lang;
        opt.textContent = languageName(lang);
        filterSelect.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

let rawGraphElements: any[] = [];
let showClusters = false;
let currentGraphMode: 'proximity' | 'directory' | 'focus' | 'full' = 'proximity';
let focusSeedNode: string | null = null;
let focusDepth = 1;
let activeLayout: any = null;
let activeLayoutName: 'fcose' | 'cose' | 'cola' | 'dagre' | 'elk' | 'concentric' | 'circle' | 'grid' = 'fcose';

// Symbol Explorer pagination state
let symbolPage = 0;
let symbolSearchQuery = '';

// New states for Proximity Clusters Mode & Groupings & Modifications
let rawClustersData: { clusters: any[], memberships: any[] } = { clusters: [], memberships: [] };
let rawSmellsData: any[] = [];
let activeClusterId: string | null = null;
let groupingStrategy: 'community' | 'directory' | 'language' | 'custom' | 'layer' = 'layer';
const removedNodes = new Set<string>();
const removedEdges = new Set<string>();
const customTags = new Map<string, string[]>(); // node ID -> tags array

// Custom tags persistence via localStorage
function getTagsStorageKey(): string {
  const repoEl = document.getElementById('repo-name');
  const repoName = repoEl?.textContent || 'mapx';
  return `mapx-custom-tags:${repoName}`;
}

// Architectural layer color palette (matches LAYER_LABELS in cluster-engine.ts)
// Architectural layer color palette (expanded for role classification, resolved collisions)
const LAYER_COLORS: Record<string, string> = {
  // Universal roles
  'layer:entry': '#e06c75',       // soft red
  'layer:config': '#5c6370',      // slate gray
  'layer:types': '#56b6c2',       // teal/cyan
  'layer:shared': '#abb2bf',      // light gray
  'layer:test': '#98c379',        // sage green
  'layer:docs': '#7a8394',        // steel blue
  'layer:other': '#4b5263',       // dark gray

  // Backend roles
  'layer:api': '#61afef',         // light blue
  'layer:middleware': '#4db5ff',  // sky blue
  'layer:service': '#c678dd',     // purple
  'layer:data': '#e5c07b',        // gold/yellow
  'layer:integration': '#ff7b00', // vibrant orange
  'layer:auth': '#ff4a8b',        // rose pink

  // Frontend roles
  'layer:pages': '#ff5e00',       // deep orange
  'layer:components': '#c76dee',  // bright violet
  'layer:state': '#2ecc71',       // emerald green
  'layer:hooks': '#3498db',       // dodger blue
  'layer:styles': '#f39c12',      // amber
  'layer:assets': '#1abc9c',      // turquoise

  // Tool roles
  'layer:cli': '#e74c3c',         // red
  'layer:core': '#00ffff',        // cyan
  'layer:parsers': '#d19a66',     // light brown/orange
  'layer:plugins': '#9b59b6',     // amethyst purple

  // Legacy fallback roles
  'layer:utils': '#95a5a6',       // asbestos gray
  'layer:ui': '#a29bfe',          // medium purple
  'layer:exporters': '#e84393',   // prunus pink
  'layer:agents': '#fdcb6e',      // warm yellow
  'layer:frameworks': '#27ae60',  // nephritis green
  'layer:scripts': '#2d3436',     // very dark gray
};

/** A layer's colour as a theme token, for HTML (the graph keeps LAYER_COLORS' fixed hues). */
const LAYER_TOKENS: Record<string, string> = {
  entry: '--syntax-red', config: '--text-muted', types: '--syntax-cyan', shared: '--text-main', test: '--syntax-green',
  docs: '--text-muted', other: '--text-muted', api: '--syntax-blue', middleware: '--syntax-blue', service: '--syntax-purple',
  data: '--syntax-yellow', integration: '--syntax-orange', auth: '--syntax-pink', pages: '--syntax-orange',
  components: '--syntax-purple', state: '--syntax-green', hooks: '--syntax-blue', styles: '--syntax-yellow',
  assets: '--syntax-cyan', cli: '--syntax-red', core: '--syntax-cyan', parsers: '--syntax-orange',
  plugins: '--syntax-purple', utils: '--text-muted', ui: '--syntax-purple', exporters: '--syntax-pink',
  agents: '--syntax-yellow', frameworks: '--syntax-green', scripts: '--text-muted',
};
function layerToken(role: string): string {
  return `var(${LAYER_TOKENS[role] ?? '--syntax-orange'})`;
}

function saveCustomTags() {
  try {
    const obj: Record<string, string[]> = {};
    customTags.forEach((tags, nodeId) => {
      if (tags.length > 0) obj[nodeId] = tags;
    });
    localStorage.setItem(getTagsStorageKey(), JSON.stringify(obj));
  } catch { /* ignore quota errors */ }
}

function loadCustomTags() {
  try {
    const raw = localStorage.getItem(getTagsStorageKey());
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [nodeId, tags] of Object.entries(obj)) {
        if (Array.isArray(tags) && tags.length > 0) {
          customTags.set(nodeId, tags as string[]);
        }
      }
    }
  } catch { /* ignore parse errors */ }
}

function getAllUsedTags(): string[] {
  const allTags = new Set<string>();
  customTags.forEach(tags => tags.forEach(t => allTags.add(t)));
  return Array.from(allTags).sort();
}

// Color mapping for HTTP route method badges
function getRouteMethodColor(method: string): string {
  switch ((method || '').toUpperCase()) {
    case 'GET': return 'var(--syntax-green)'; // emerald
    case 'POST': return 'var(--syntax-blue)'; // blue
    case 'PUT': return 'var(--syntax-yellow)'; // amber
    case 'PATCH': return 'var(--syntax-cyan)'; // teal
    case 'DELETE': return 'var(--danger)'; // red
    case 'HEAD': return 'var(--syntax-blue)'; // indigo
    case 'OPTIONS': return 'var(--syntax-purple)'; // violet
    case 'ANY': return 'var(--syntax-purple)'; // purple
    case 'MATCH': return 'var(--syntax-pink)'; // pink
    default: return 'var(--text-muted)'; // slate
  }
}

// Color mapping for hook type badges
function getHookTypeColor(hookType: string): string {
  const t = (hookType || '').toLowerCase();
  if (t.includes('middleware')) return 'var(--syntax-blue)'; // indigo
  if (t.includes('event') || t.includes('listener')) return 'var(--syntax-cyan)'; // cyan
  if (t.includes('filter')) return 'var(--syntax-yellow)'; // amber
  if (t.includes('action')) return 'var(--syntax-red)'; // rose
  if (t.includes('lifecycle') || t.includes('init') || t.includes('boot') || t.includes('destroy')) return 'var(--syntax-cyan)'; // teal
  if (t.includes('service_provider') || t.includes('provider')) return 'var(--syntax-purple)'; // violet
  if (t.includes('guard')) return 'var(--danger)'; // red
  if (t.includes('pipe')) return 'var(--syntax-cyan)'; // cyan-light
  if (t.includes('interceptor')) return 'var(--syntax-purple)'; // purple
  if (t.includes('resolver') || t.includes('query') || t.includes('mutation')) return 'var(--syntax-blue)'; // blue
  if (t.includes('subscriber') || t.includes('subscription')) return 'var(--syntax-pink)'; // pink
  return 'var(--text-muted)'; // slate fallback
}

// Centralized layout configuration resolver
function getLayoutConfigForName(layoutName: string, elementCount?: number): any {
  const isLarge = (elementCount || 0) > 500;
  const baseAnimate = !isLarge;

  switch (layoutName) {
    case 'fcose': {
      // Scale iterations to graph size. Using 'default' quality throughout —
      // 'draft' skips fCoSE's overlap-removal pass which is the main cause of
      // nodes stacking on top of each other.
      const fcoseIter = (elementCount || 0) > 500 ? 500
        : (elementCount || 0) > 200 ? 1000
          : 2500;
      // Node separation scales up for denser graphs so there is always enough
      // space between nodes regardless of how many edges share a region.
      const fcoseSep = (elementCount || 0) > 200 ? 160 : 120;
      return {
        name: 'fcose',
        animate: baseAnimate,
        animationDuration: 500,
        quality: 'default',
        randomize: true,
        fit: true,
        padding: 60,
        nodeDimensionsIncludeLabels: true,
        uniformNodeDimensions: false,
        // On large graphs fCoSE's time is the repulsion between nodes within a range that grows
        // with the ideal edge length: shorter edges halve the layout of 2,000 files (M4-20).
        nodeRepulsion: () => ((elementCount || 0) > 1500 ? 120000 : 250000),
        idealEdgeLength: () => ((elementCount || 0) > 1500 ? 70 : 180),
        edgeElasticity: () => 0.35,
        gravity: 0.08,
        gravityRange: 2.5,
        numIter: fcoseIter,
        tile: true,
        tilingPaddingVertical: 40,
        tilingPaddingHorizontal: 40,
        nodeSeparation: fcoseSep,
        samplingType: true,
        sampleSize: 25,
        nestingFactor: 0.1,
      };
    }
    case 'cose':
      return {
        name: 'cose',
        animate: baseAnimate ? 'end' : false,
        animationDuration: 500,
        fit: true,
        padding: 50,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 120000,
        idealEdgeLength: () => 160,
        nodeOverlap: 80,
        gravity: 0.05,
        nestingFactor: 1.2,
        componentSpacing: 60,
        refresh: 20,
      };
    case 'cola':
      return {
        name: 'cola',
        animate: baseAnimate,
        fit: true,
        padding: 50,
        randomize: true,
        nodeDimensionsIncludeLabels: true,
        maxSimulationTime: isLarge ? 2000 : 4000,
        avoidOverlap: true,
        convergenceThreshold: 0.001,
        unconstrIter: 10,
        userConstIter: 20,
        allConstIter: 20,
        nodeSpacing: () => 40,
        edgeLength: undefined,
        flow: undefined,
        ungrabifyWhileSimulating: true,
      };
    case 'dagre':
      return {
        name: 'dagre',
        animate: baseAnimate,
        fit: true,
        padding: 50,
        nodeSep: 50,
        edgeSep: 10,
        rankSep: 100,
        rankDir: 'TB',
        nodeDimensionsIncludeLabels: true,
      };
    case 'elk': {
      // Partition numbers define vertical bands (lower = higher in DOWN layout).
      // Files with the same extension land in the same horizontal layer; unrelated
      // file-type groups that share no edges form fully separate tree structures.
      const EXT_PARTITION: Record<string, number> = {
        ts: 1, tsx: 1, mts: 1, cts: 1,
        js: 2, jsx: 2, mjs: 2, cjs: 2,
        json: 3, yaml: 3, yml: 3, toml: 3,
        html: 4, css: 4, scss: 4, sass: 4, less: 4, svelte: 4, vue: 4,
        md: 5, mdx: 5, txt: 5,
        sh: 6, bash: 6, zsh: 6,
        scm: 7,
      };
      return {
        name: 'elk',
        animate: baseAnimate,
        fit: true,
        padding: 60,
        nodeDimensionsIncludeLabels: true,
        nodeLayoutOptions: (node: any) => {
          // Only partition file nodes; leave cluster/compound nodes unassigned
          if (node.data('type') !== 'file') return {};
          const id: string = node.data('id') || '';
          const ext = id.includes('.') ? (id.split('.').pop()?.toLowerCase() ?? '') : '';
          return { 'elk.partitioning.partition': EXT_PARTITION[ext] ?? 0 };
        },
        elk: {
          algorithm: 'layered',
          'elk.direction': 'DOWN',
          'elk.nodeDimensionsIncludeLabels': true,
          'elk.partitioning.activate': true,
          'elk.layered.spacing.nodeNodeBetweenLayers': 60,
          'elk.spacing.nodeNode': 25,
          'elk.spacing.edgeNode': 20,
          'elk.spacing.edgeEdge': 10,
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
          'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
          'elk.layered.compaction.postCompaction.strategy': 'LEFT_RIGHT_CONSTRAINT_LOCKING',
          'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
          'elk.separateConnectedComponents': true,
          'elk.spacing.componentComponent': 40,
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.aspectRatio': 1.7,
        },
      };
    }
    case 'concentric':
      return {
        name: 'concentric',
        animate: baseAnimate,
        fit: true,
        padding: 50,
        concentric: (node: any) => node.degree ? node.degree() : 0,
        levelWidth: () => 1,
        minNodeSpacing: 30,
      };
    case 'circle':
      return {
        name: 'circle',
        animate: baseAnimate,
        fit: true,
        padding: 50,
        avoidOverlap: true,
        spacingFactor: 1.2,
      };
    case 'grid':
      return {
        name: 'grid',
        animate: baseAnimate,
        fit: true,
        padding: 50,
        avoidOverlap: true,
        condense: true,
      };
    default:
      return {
        name: 'cose',
        animate: baseAnimate ? 'end' : false,
        fit: true,
        padding: 50,
        nodeRepulsion: () => 120000,
        idealEdgeLength: () => 160,
      };
  }
}

async function loadClusters() {
  const gen = repoGeneration;
  try {
    const res = await fetch(withRepo('/api/clusters', 'set'));
    if (res.ok) {
      rawClustersData = await res.json();
      if (gen !== repoGeneration) return; // a newer repo choice is loading
    }
  } catch (err) {
    console.error('Failed to load clusters:', err);
  }
}

function buildDirectoryAggregatedElements(rawElements: any[], useClusters: boolean): any[] {
  const dirs = new Set<string>();
  const fileToDir = new Map<string, string>();

  // Extract file directories
  for (const el of rawElements) {
    if (el.data && !el.data.source && !el.data.target && el.data.type === 'file') {
      const parts = el.data.id.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
      dirs.add(dir);
      fileToDir.set(el.data.id, dir);
    }
  }

  const elements: any[] = [];

  if (useClusters) {
    // Parent folder nested compound nodes
    const allDirs = new Set<string>();
    dirs.forEach(dir => {
      if (dir === 'root') {
        allDirs.add('root');
        return;
      }
      const parts = dir.split('/');
      for (let i = 1; i <= parts.length; i++) {
        allDirs.add(parts.slice(0, i).join('/'));
      }
    });

    allDirs.forEach(dir => {
      const isRoot = dir === 'root';
      const hasParent = !isRoot && dir.includes('/');
      const parentId = hasParent ? `dir:${dir.substring(0, dir.lastIndexOf('/'))}` : (isRoot ? null : 'dir:root');

      const nodeEl: any = {
        data: {
          id: `dir:${dir}`,
          label: dir === 'root' ? 'root' : dir.substring(dir.lastIndexOf('/') + 1),
          type: 'parent-folder'
        }
      };
      if (parentId) {
        nodeEl.data.parent = parentId;
      }
      elements.push(nodeEl);
    });
  } else {
    // Create flat directory nodes with truncated labels
    dirs.forEach(dir => {
      let label = dir;
      if (dir !== 'root') {
        const parts = dir.split('/');
        label = parts.length > 2 ? '…/' + parts.slice(-2).join('/') : dir;
      }
      elements.push({
        data: {
          id: `dir:${dir}`,
          label,
          fullPath: dir,
          type: 'parent-folder'
        }
      });
    });
  }

  // Aggregate inter-directory edges
  const dirEdges = new Map<string, { source: string, target: string, count: number }>();
  for (const el of rawElements) {
    if (el.data && el.data.source && el.data.target) {
      const srcDir = fileToDir.get(el.data.source);
      const tgtDir = fileToDir.get(el.data.target);
      if (srcDir && tgtDir && srcDir !== tgtDir) {
        const sourceId = `dir:${srcDir}`;
        const targetId = `dir:${tgtDir}`;
        const edgeKey = `${sourceId}->${targetId}`;
        if (!dirEdges.has(edgeKey)) {
          dirEdges.set(edgeKey, { source: sourceId, target: targetId, count: 0 });
        }
        dirEdges.get(edgeKey)!.count++;
      }
    }
  }

  dirEdges.forEach((info) => {
    elements.push({
      data: {
        id: `dir-edge:${info.source}->${info.target}`,
        source: info.source,
        target: info.target,
        type: 'aggregated-dependency',
        label: `${info.count}`,
        count: info.count
      }
    });
  });

  return elements;
}

function buildFocusModeElements(rawElements: any[], seedId: string, depth: number, useClusters: boolean): any[] {
  const nodeMap = new Map<string, any>();
  const edgesBySource = new Map<string, any[]>();
  const edgesByTarget = new Map<string, any[]>();

  for (const el of rawElements) {
    if (el.data && !el.data.source && !el.data.target) {
      nodeMap.set(el.data.id, el);
    } else if (el.data && el.data.source && el.data.target) {
      const src = el.data.source;
      const tgt = el.data.target;
      if (!edgesBySource.has(src)) edgesBySource.set(src, []);
      if (!edgesByTarget.has(tgt)) edgesByTarget.set(tgt, []);
      edgesBySource.get(src)!.push(el);
      edgesByTarget.get(tgt)!.push(el);
    }
  }

  const visitedNodes = new Set<string>([seedId]);
  const visitedEdges = new Set<any>();
  let currentLevel = new Set<string>([seedId]);

  for (let d = 0; d < depth; d++) {
    const nextLevel = new Set<string>();
    for (const nodeId of currentLevel) {
      const outEdges = edgesBySource.get(nodeId) || [];
      for (const edge of outEdges) {
        const tgt = edge.data.target;
        visitedEdges.add(edge);
        if (!visitedNodes.has(tgt)) {
          visitedNodes.add(tgt);
          nextLevel.add(tgt);
        }
      }
      const inEdges = edgesByTarget.get(nodeId) || [];
      for (const edge of inEdges) {
        const src = edge.data.source;
        visitedEdges.add(edge);
        if (!visitedNodes.has(src)) {
          visitedNodes.add(src);
          nextLevel.add(src);
        }
      }
    }
    currentLevel = nextLevel;
  }

  const elements: any[] = [];

  if (useClusters) {
    const filesByDirectory: { [dirId: string]: any[] } = {};
    const getParentId = (filePath: string): string => {
      const parts = filePath.split('/');
      return parts.length > 1 ? `dir:${parts.slice(0, -1).join('/')}` : 'dir:root';
    };

    visitedNodes.forEach(id => {
      const node = nodeMap.get(id);
      if (node) {
        const copy = JSON.parse(JSON.stringify(node));
        if (id === seedId) {
          copy.data.isSeed = true;
        }
        const parentId = getParentId(id);
        copy.data.parent = parentId;
        if (!filesByDirectory[parentId]) {
          filesByDirectory[parentId] = [];
        }
        filesByDirectory[parentId].push(copy);
      }
    });

    // Add parent nodes
    Object.keys(filesByDirectory).forEach(dirId => {
      elements.push({
        data: {
          id: dirId,
          label: dirId === 'dir:root' ? 'root' : dirId.replace('dir:', ''),
          type: 'parent'
        }
      });
      elements.push(...filesByDirectory[dirId]);
    });
  } else {
    visitedNodes.forEach(id => {
      const node = nodeMap.get(id);
      if (node) {
        const copy = JSON.parse(JSON.stringify(node));
        if (id === seedId) {
          copy.data.isSeed = true;
        }
        elements.push(copy);
      }
    });
  }

  visitedEdges.forEach(edge => {
    elements.push(JSON.parse(JSON.stringify(edge)));
  });

  return elements;
}

function buildProximityClusterElements(): any[] {
  // 1. Get filtered nodes and edges
  const fileNodes = rawGraphElements.filter(el => el.data && el.data.type === 'file' && !removedNodes.has(el.data.id));
  const edges = rawGraphElements.filter(el =>
    el.data && el.data.source && el.data.target &&
    !removedEdges.has(el.data.id) &&
    !removedNodes.has(el.data.source) && !removedNodes.has(el.data.target)
  );

  // Calculate degrees for orphan & singular detection
  const degreeMap = new Map<string, number>();
  fileNodes.forEach(n => degreeMap.set(n.data.id, 0));
  edges.forEach(e => {
    const src = e.data.source;
    const tgt = e.data.target;
    if (degreeMap.has(src)) degreeMap.set(src, degreeMap.get(src)! + 1);
    if (degreeMap.has(tgt)) degreeMap.set(tgt, degreeMap.get(tgt)! + 1);
  });

  // Determine file-to-cluster assignment based on grouping strategy
  const fileToCluster = new Map<string, string>();

  // Community map — only map to community clusters (starts with 'community_')
  // to avoid collisions with directory or namespace cluster memberships.
  const communityMap = new Map<string, string>();
  if (rawClustersData && rawClustersData.memberships) {
    rawClustersData.memberships.forEach((m: any) => {
      if (typeof m.clusterName === 'string' && m.clusterName.startsWith('community_')) {
        // Each repo numbers its own communities: key them by repo, so community_1 of two repos stays two groups.
        communityMap.set(m.filePath, m.repo ? `${m.clusterName}@${m.repo}` : m.clusterName);
      }
    });
  }

  // Each file's layer cluster, looked up once instead of a scan of every membership per file.
  const layerOf = new Map<string, string>();
  for (const m of rawClustersData.memberships ?? []) {
    if (typeof m.clusterName === 'string' && m.clusterName.startsWith('layer:') && !layerOf.has(m.filePath)) layerOf.set(m.filePath, m.clusterName);
  }

  fileNodes.forEach(node => {
    const fId = node.data.id;
    const deg = degreeMap.get(fId) || 0;

    // Special groups override
    if (deg === 0) {
      fileToCluster.set(fId, 'cluster:orphans');
      return;
    }
    if (deg === 1) {
      fileToCluster.set(fId, 'cluster:singulars');
      return;
    }

    if (groupingStrategy === 'community') {
      const comm = communityMap.get(fId);
      if (comm) {
        fileToCluster.set(fId, `cluster:${comm}`);
      } else {
        // Fallback: group by directory to avoid a flat global unassigned cluster
        const parts = fId.split('/');
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
        fileToCluster.set(fId, `cluster:unassigned:${dir}`);
      }
    } else if (groupingStrategy === 'directory') {
      const parts = fId.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
      fileToCluster.set(fId, `dir:${dir}`);
    } else if (groupingStrategy === 'layer') {
      const fileRole = node.data.role;
      if (fileRole) {
        fileToCluster.set(fId, `layer:${fileRole}`);
      } else {
        fileToCluster.set(fId, layerOf.get(fId) ?? 'layer:other');
      }
    } else if (groupingStrategy === 'language') {
      const lang = node.data.language || 'unknown';
      fileToCluster.set(fId, `lang:${lang}`);
    } else if (groupingStrategy === 'custom') {
      const tags = customTags.get(fId) || [];
      if (tags.length > 0) {
        fileToCluster.set(fId, `tag:${tags[0]}`); // Group by first tag
      } else {
        fileToCluster.set(fId, 'tag:untagged');
      }
    }
  });

  const elements: any[] = [];

  if (activeClusterId) {
    // DRILL-DOWN expanded view of a specific cluster
    const clusterFiles = fileNodes.filter(n => fileToCluster.get(n.data.id) === activeClusterId);
    const clusterFileIds = new Set(clusterFiles.map(n => n.data.id));

    // Also identify boundary nodes outside this cluster that have edges to cluster nodes
    const boundaryNodes = new Set<string>();
    const clusterEdges: any[] = [];

    edges.forEach(edge => {
      const src = edge.data.source;
      const tgt = edge.data.target;
      const srcIn = clusterFileIds.has(src);
      const tgtIn = clusterFileIds.has(tgt);

      if (srcIn && tgtIn) {
        clusterEdges.push(JSON.parse(JSON.stringify(edge)));
      } else if (srcIn || tgtIn) {
        clusterEdges.push(JSON.parse(JSON.stringify(edge)));
        if (srcIn) boundaryNodes.add(tgt);
        if (tgtIn) boundaryNodes.add(src);
      }
    });

    // Add nodes in cluster
    clusterFiles.forEach(node => {
      const copy = JSON.parse(JSON.stringify(node));
      copy.data.isInsideCluster = true;
      elements.push(copy);
    });

    // Add boundary nodes as visually distinct nodes
    boundaryNodes.forEach(id => {
      const node = fileNodes.find(n => n.data.id === id);
      if (node) {
        const copy = JSON.parse(JSON.stringify(node));
        copy.data.isBoundaryNode = true;
        elements.push(copy);
      }
    });

    // Add edges
    elements.push(...clusterEdges);

  } else {
    // TOP-LEVEL collapsed view of all clusters
    const clusterCounts = new Map<string, number>();
    fileToCluster.forEach((clustId) => {
      clusterCounts.set(clustId, (clusterCounts.get(clustId) || 0) + 1);
    });

    // Render cluster nodes
    clusterCounts.forEach((cnt, clustId) => {
      let label = clustId;
      if (clustId === 'cluster:orphans') label = `Orphaned Files (${cnt})`;
      else if (clustId === 'cluster:singulars') label = `Singular Connected (${cnt})`;
      else if (clustId.startsWith('cluster:')) {
        const commId = clustId.replace('cluster:', '');
        if (commId.startsWith('unassigned:')) {
          const dirPath = commId.replace('unassigned:', '');
          label = `Folder: ${dirPath === 'root' ? 'root' : dirPath} (${cnt} files)`;
        } else {
          const [commName, commRepo] = commId.split('@');
          const commObj = rawClustersData.clusters?.find(c => c.name === commName && (!commRepo || c.repo === commRepo));
          const repoSuffix = commRepo && workspaceRepos.length > 1 ? ` · ${commRepo}` : '';
          label = `${commObj ? commObj.label : commName}${repoSuffix} (${cnt} files)`;
        }
      } else if (clustId.startsWith('dir:')) {
        label = `${clustId.replace('dir:', '')} (${cnt} files)`;
      } else if (clustId.startsWith('layer:')) {
        const layerCluster = rawClustersData.clusters?.find(c => c.name === clustId);
        let layerLabel = layerCluster ? layerCluster.label : '';
        if (!layerLabel) {
          const raw = clustId.replace('layer:', '');
          layerLabel = raw.charAt(0).toUpperCase() + raw.slice(1);
        }
        label = `${layerLabel} (${cnt})`;
      } else if (clustId.startsWith('lang:')) {
        label = `${clustId.replace('lang:', '').toUpperCase()} (${cnt} files)`;
      } else if (clustId.startsWith('tag:')) {
        label = `Tag: ${clustId.replace('tag:', '')} (${cnt} files)`;
      }

      elements.push({
        data: {
          id: clustId,
          label,
          type: 'cluster-group',
          fileCount: cnt,
          isOrphans: clustId === 'cluster:orphans',
          isSingulars: clustId === 'cluster:singulars',
          isFolderFallback: clustId.startsWith('cluster:unassigned:'),
          layerColor: LAYER_COLORS[clustId] ?? null,
        }
      });
    });

    // Aggregate inter-cluster edges
    const interEdges = new Map<string, { source: string, target: string, count: number }>();
    edges.forEach(edge => {
      const srcClust = fileToCluster.get(edge.data.source);
      const tgtClust = fileToCluster.get(edge.data.target);
      if (srcClust && tgtClust && srcClust !== tgtClust) {
        const key = `${srcClust}->${tgtClust}`;
        if (!interEdges.has(key)) {
          interEdges.set(key, { source: srcClust, target: tgtClust, count: 0 });
        }
        interEdges.get(key)!.count++;
      }
    });

    interEdges.forEach((info) => {
      elements.push({
        data: {
          id: `inter-edge:${info.source}->${info.target}`,
          source: info.source,
          target: info.target,
          type: 'cluster-edge',
          label: `${info.count}`,
          count: info.count
        }
      });
    });
  }

  return elements;
}

function buildGraphElementsForMode(): any[] {
  const elements = (() => {
    if (currentGraphMode === 'proximity') {
      return buildProximityClusterElements();
    } else if (currentGraphMode === 'directory') {
      return buildDirectoryAggregatedElements(rawGraphElements, showClusters);
    } else if (currentGraphMode === 'focus') {
      if (!focusSeedNode) {
        const firstFile = rawGraphElements.find(el => el.data && el.data.type === 'file');
        focusSeedNode = firstFile ? firstFile.data.id : null;
      }
      if (focusSeedNode) {
        return buildFocusModeElements(rawGraphElements, focusSeedNode, focusDepth, showClusters);
      }
      return [];
    } else {
      const filteredRaw = rawGraphElements.filter(el => {
        if (el.data && el.data.id && removedNodes.has(el.data.id)) return false;
        if (el.data && el.data.source && (removedNodes.has(el.data.source) || removedNodes.has(el.data.target) || removedEdges.has(el.data.id))) return false;
        return true;
      });
      return buildGraphElements(filteredRaw, showClusters);
    }
  })();

  // Annotate elements with smell indicators (isHub, isCycle)
  elements.forEach(el => {
    if (el.data) {
      if (el.data.type === 'file' && hubNodes.has(el.data.id)) {
        el.data.isHub = true;
      }
      if (el.data.source && el.data.target) {
        const edgeKey = `edge-${el.data.source}-${el.data.target}`;
        if (cycleEdges.has(edgeKey)) {
          el.data.isCycle = true;
        }
      }
    }
  });

  return elements;
}

function updateGraphDisplay() {
  if (!cyInstance) return;

  // A new view supersedes any layout still pending, and the elements an older pre-layout held.
  pendingWorkerLayout = null;
  pendingPrelayoutAdd = null;
  layoutTicket++;
  const newElements = buildGraphElementsForMode();
  const elementCount = newElements.length;
  const replaceElements = () => cyInstance.batch(() => {
    cyInstance.elements().stop(true, true); // a superseded animated layout's queued moves
    cyInstance.elements().remove();
    cyInstance.add(newElements);
  });

  // Resolve the layout config for this mode change.
  // All paths go through getLayoutConfigForName so the pre-scatter in runLayout
  // always fires and nodes never stack on top of each other after a mode switch.
  let layoutConfig: any;
  if (currentGraphMode === 'proximity' && !activeClusterId) {
    // Top-level proximity clusters: use the active layout; boost physics
    // options only when the chosen algorithm supports them.
    layoutConfig = getLayoutConfigForName(activeLayoutName, elementCount);
    if (layoutConfig.name === 'fcose' || layoutConfig.name === 'cose') {
      layoutConfig.nodeRepulsion = () => 350000;
      layoutConfig.idealEdgeLength = () => 220;
      layoutConfig.gravity = 0.06;
    }
    if (layoutConfig.name === 'elk') {
      layoutConfig.elk = { ...layoutConfig.elk, 'spacing.nodeNode': 80, 'spacing.nodeNodeBetweenLayers': 120 };
    }
  } else if (currentGraphMode === 'full' && showClusters) {
    layoutConfig = getLayoutOptions(showClusters, true);
  } else {
    layoutConfig = getLayoutConfigForName(activeLayoutName, elementCount);
  }

  // Always force randomize for fCoSE on a mode change so internal position
  // seeding starts fresh rather than using the stale (0,0) coordinates.
  if (layoutConfig.name === 'fcose') {
    layoutConfig = { ...layoutConfig, randomize: true };
  }

  // A large fCoSE layout runs in the worker on the raw elements, which are then added once, already
  // placed: no render of nodes stacked at the origin, and no second pass over their styles (M4-20).
  if (layoutConfig.name === 'fcose' && elementCount > WORKER_LAYOUT_MIN && prelayoutInWorker(newElements, layoutConfig, replaceElements)) {
    syncLayoutSelect();
    return;
  }

  replaceElements();
  runLayout(layoutConfig);
  syncLayoutSelect();
}

function syncLayoutSelect() {

  const layoutSelect = document.getElementById('select-layout') as HTMLSelectElement;
  if (layoutSelect && layoutSelect.value !== activeLayoutName) {
    layoutSelect.value = activeLayoutName;
  }
}

/**
 * Lays out elements that are not drawn yet in the worker; the old graph is cleared meanwhile, and
 * the new one added with its positions. False when no worker can run.
 */
function prelayoutInWorker(elements: any[], config: any, replaceElements: () => void): boolean {
  const degree = new Map<string, number>();
  const edges: Array<{ id: string; source: string; target: string }> = [];
  for (const el of elements) {
    const d = el.data;
    if (d?.source && d?.target) {
      edges.push({ id: d.id, source: d.source, target: d.target });
      degree.set(d.source, (degree.get(d.source) ?? 0) + 1);
      degree.set(d.target, (degree.get(d.target) ?? 0) + 1);
    }
  }
  const nodes: WorkerNode[] = elements.filter((el) => el.data && !el.data.source).map((el) => ({ id: el.data.id, parent: el.data.parent, ...estimatedSize(el.data, degree.get(el.data.id) ?? 0), x: 0, y: 0 }));
  if (activeLayout) {
    try { activeLayout.stop(); } catch { /* ignored */ }
    activeLayout = null;
  }
  const started = startWorkerLayout(nodes, edges, config, (positions) => {
    pendingPrelayoutAdd = null;
    for (const el of elements) {
      const p = el.data && !el.data.source ? positions[el.data.id] : undefined;
      if (p) el.position = p;
    }
    replaceElements();
    finishWorkerLayout(config);
  }, () => {
    pendingPrelayoutAdd = null;
    replaceElements();
    runLayoutOnMainThread(config);
  });
  if (!started) return false;
  pendingPrelayoutAdd = replaceElements;
  cyInstance.elements().remove(); // the old view goes; the canvas shows the layout notice
  markGraph('layout');
  return true;
}

/** fCoSE runs in a worker once the visible graph has more elements than this (M4-20). */
const WORKER_LAYOUT_MIN = 600;
let layoutWorker: Worker | null | undefined;
let layoutSeq = 0;
/** Adds the elements a worker pre-layout is holding back; set while one is pending. */
let pendingPrelayoutAdd: (() => void) | null = null;
/** Bumped by every layout request, so a late lazy engine does not override a newer choice. */
let layoutTicket = 0;
/** A worker that has not answered in this long is treated as failed (M4-20 review). */
const WORKER_LAYOUT_TIMEOUT_MS = 60_000;
type Positions = Record<string, { x: number; y: number }>;
type WorkerNode = { id: string; parent?: string; w: number; h: number; x: number; y: number };
let pendingWorkerLayout: { seq: number; onPositions: (p: Positions) => void; onFail: () => void } | null = null;

/** Option values the worker can receive: functions returning constants are evaluated. */
function serializableOptions(config: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'function') {
      try {
        const value = (v as () => unknown)();
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') out[k] = value;
      } catch { /* depends on its node argument: left to the worker's default */ }
    } else if (v === null || ['number', 'boolean', 'string'].includes(typeof v)) {
      out[k] = v;
    }
  }
  return out;
}

/** The main-thread layout, also the fallback when the worker cannot run. */
function runLayoutOnMainThread(layoutConfig: any) {
  activeLayout = cyInstance.layout(layoutConfig);
  activeLayout.one('layoutstop', () => markGraph('ready'));
  activeLayout.run();
}

function onWorkerLayout(event: MessageEvent<{ seq: number; positions?: Positions; error?: string; ms?: number }>) {
  const { seq, positions, error, ms } = event.data;
  performance.mark('mapx:layout-received');
  if (ms !== undefined) document.body.dataset.layoutMs = String(ms); // how long the worker took (tests, M4-20)
  const pending = pendingWorkerLayout;
  if (!pending || seq !== pending.seq || !cyInstance) return; // superseded by a later layout
  pendingWorkerLayout = null;
  if (error || !positions) {
    console.warn(`Layout worker failed (${error}); laying out on the main thread.`);
    pending.onFail();
    return;
  }
  pending.onPositions(positions);
}

/** Finishes a worker layout: fit, then the same signals a cytoscape layout gives. */
function finishWorkerLayout(config: any) {
  if (config.fit !== false) cyInstance.fit(undefined, config.padding ?? 50);
  activeLayout = null;
  cyInstance.emit('layoutstop');
  markGraph('ready');
}

/**
 * Posts a graph to the layout worker (started on first use). False when no worker can run, so
 * the caller lays out on the main thread; otherwise exactly one of the callbacks runs, unless a
 * later layout supersedes this one.
 */
function startWorkerLayout(nodes: WorkerNode[], edges: Array<{ id: string; source: string; target: string }>, config: any, onPositions: (p: Positions) => void, onFail: () => void): boolean {
  if (layoutWorker === null || typeof Worker === 'undefined') return false;
  if (!layoutWorker) {
    try {
      layoutWorker = new Worker(new URL('layout-worker.js', document.baseURI), { type: 'module' });
      layoutWorker.onmessage = onWorkerLayout;
      layoutWorker.onerror = (e) => {
        console.warn(`Layout worker unavailable (${e.message || 'load error'}); laying out on the main thread.`);
        layoutWorker?.terminate();
        layoutWorker = null;
        const pending = pendingWorkerLayout;
        pendingWorkerLayout = null;
        if (pending && cyInstance) pending.onFail();
      };
    } catch {
      layoutWorker = null;
      return false;
    }
  }
  const seq = ++layoutSeq;
  pendingWorkerLayout = { seq, onPositions, onFail };
  setTimeout(() => {
    if (pendingWorkerLayout?.seq !== seq) return;
    console.warn('Layout worker did not answer; laying out on the main thread.');
    layoutWorker?.terminate();
    layoutWorker = undefined; // a fresh worker next time
    pendingWorkerLayout = null;
    if (cyInstance) onFail();
  }, WORKER_LAYOUT_TIMEOUT_MS);
  layoutWorker.postMessage({ seq, nodes, edges, options: serializableOptions(config) });
  performance.mark('mapx:layout-posted');
  return true;
}

/** A node's drawn size with its label, estimated as the graph style draws it (about 6.5 px a character at 11 px). */
function estimatedSize(data: any, degree: number): { w: number; h: number } {
  const label = String(data.label ?? '');
  const side = data.type === 'cluster-group'
    ? 70 + Math.min(Math.log2(data.fileCount || 1) * 8, 40)
    : 32 + Math.min(degree * 2, 48);
  return { w: Math.max(side, label.length * 6.5 + 8), h: side + (label ? 18 : 0) };
}

/**
 * Runs an fCoSE layout in the layout worker: posts the visible nodes (with their sizes including
 * labels) and edges, and applies the positions it returns. False when no worker can be started,
 * so the caller lays out on the main thread.
 */
function runLayoutInWorker(layoutConfig: any): boolean {
  const visible = cyInstance.elements(':visible');
  const nodes: WorkerNode[] = visible.nodes().map((n: any) => ({ id: n.id(), parent: n.data('parent'), ...estimatedSize(n.data(), n.degree()), x: 0, y: 0 }));
  const edges = visible.edges().map((e: any) => ({ id: e.id(), source: e.source().id(), target: e.target().id() }));
  return startWorkerLayout(nodes, edges, layoutConfig, (positions) => {
    cyInstance.batch(() => {
      cyInstance.nodes().forEach((node: any) => {
        const p = positions[node.id()];
        if (p && !node.isParent()) node.position(p);
      });
    });
    finishWorkerLayout(layoutConfig);
  }, () => runLayoutOnMainThread(layoutConfig));
}

function runLayout(layoutConfig: any) {
  if (activeLayout) {
    try {
      activeLayout.stop();
    } catch (e) {
      // Ignored
    }
  }
  pendingWorkerLayout = null; // a newer layout supersedes one still in the worker
  // End the animations a stopped layout left queued: re-added elements with the same ids could
  // otherwise keep the new layout from ever finishing (found by the M4-24 XSS test).
  cyInstance.elements().stop(true, true);
  cyInstance.stop(true, true); // and the viewport's (a layout's fit is an animation too)
  // Elements still waiting for a superseded pre-layout are drawn now, for this layout to place.
  if (pendingPrelayoutAdd) {
    const add = pendingPrelayoutAdd;
    pendingPrelayoutAdd = null;
    add();
  }
  const ticket = ++layoutTicket;
  // The canvas may have been hidden (another tab) since cytoscape last measured it: a layout that
  // fits a zero-sized viewport never finishes its animation (found by the M4-24 XSS test).
  cyInstance.resize();

  // A layout engine loaded on demand: run once it has arrived, unless a newer layout was asked for.
  const loading = ensureLayout(layoutConfig.name);
  if (loading) {
    markGraph('layout');
    loading.then(() => { if (cyInstance && ticket === layoutTicket) runLayout(layoutConfig); }).catch((err) => {
      console.error(`Failed to load the ${layoutConfig.name} layout:`, err);
      markGraph('error');
    });
    return;
  }

  const visibleCount = cyInstance.elements(':visible').length;
  if (visibleCount > 200) {
    layoutConfig = { ...layoutConfig, animate: false };
  }

  // Large fCoSE layouts run in the worker, which randomizes the start itself (M4-20).
  if (layoutConfig.name === 'fcose' && visibleCount > WORKER_LAYOUT_MIN) {
    markGraph('layout');
    if (runLayoutInWorker(layoutConfig)) return;
  }

  // Pre-scatter nodes to random positions before any physics/force layout runs.
  // When elements are replaced in updateGraphDisplay, new nodes land at (0,0) and
  // stack on top of each other. Scattering them first gives the layout a clean
  // starting state regardless of which algorithm is selected.
  const isPhysicsLayout = ['fcose', 'cose', 'cola', 'concentric'].includes(layoutConfig.name);
  if (isPhysicsLayout) {
    const container = cyInstance.container();
    const w = container ? container.clientWidth : 800;
    const h = container ? container.clientHeight : 600;
    cyInstance.nodes(':visible').forEach((node: any) => {
      node.position({
        x: (Math.random() - 0.5) * w * 1.5 + w / 2,
        y: (Math.random() - 0.5) * h * 1.5 + h / 2,
      });
    });
  }

  markGraph('layout');
  if (visibleCount > 200) {
    runLayoutOnMainThread(layoutConfig);
    return;
  }

  if (layoutConfig.animate) {
    if (layoutConfig.name === 'cose' || layoutConfig.name === 'fcose') {
      layoutConfig = {
        ...layoutConfig,
        animate: 'end',
        animationDuration: 500,
        animationEasing: 'ease-out'
      };
    } else {
      layoutConfig = {
        ...layoutConfig,
        animate: true,
        animationDuration: 500,
        animationEasing: 'ease-out'
      };
    }
  }

  const layout = cyInstance.layout(layoutConfig);
  activeLayout = layout;
  layout.one('layoutstop', () => markGraph('ready'));
  layout.run();
  if (layoutConfig.animate) {
    // Watchdog: cytoscape can leave a node's animation stalled when a layout is replaced mid-
    // animation (switching view twice quickly), and the layout then never stops. Past its
    // duration, stalled animations jump to their end and the graph is ready (found by M4-24's test).
    setTimeout(() => {
      if (activeLayout !== layout || document.body.dataset.graph !== 'layout' || !cyInstance) return;
      cyInstance.elements().stop(true, true);
      setTimeout(() => { if (activeLayout === layout && document.body.dataset.graph === 'layout') markGraph('ready'); }, 100);
    }, (layoutConfig.animationDuration ?? 500) + 1500);
  }
}

function buildGraphElements(rawElements: any[], useClusters: boolean): any[] {
  let processed: any[] = [];

  if (!useClusters) {
    // Return copy of elements without parent fields
    processed = rawElements.map(el => {
      if (el.data && el.data.parent) {
        const copy = JSON.parse(JSON.stringify(el));
        delete copy.data.parent;
        return copy;
      }
      return el;
    });
  } else {
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
          const R = 110;
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
          const R1 = 90;
          const R2 = 180;
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
          const R1 = 80;
          const R2 = 160;
          const R3 = 240;
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
  }

  // Filter out any edges whose source or target nodes do not exist in the final elements list
  const nodeIds = new Set<string>();
  for (const el of processed) {
    if (el.data && !el.data.source && !el.data.target) {
      nodeIds.add(el.data.id);
    }
  }

  return processed.filter(el => {
    if (el.data && (el.data.source || el.data.target)) {
      return nodeIds.has(el.data.source) && nodeIds.has(el.data.target);
    }
    return true;
  });
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
    // Delegate to the centralized resolver so the initial load always honours
    // the active layout (fCoSE by default) and the pre-scatter in runLayout fires.
    const config = getLayoutConfigForName(activeLayoutName);
    return { ...config, animate };
  }
}

// Graph Mode selector event listener — manages contextual visibility
function updateToolbarVisibility(mode: string) {
  const focusSearchContainer = document.getElementById('focus-search-container');
  if (focusSearchContainer) {
    focusSearchContainer.style.display = mode === 'focus' ? 'inline-flex' : 'none';
  }

  const groupingSelect = document.getElementById('select-grouping-strategy') as HTMLSelectElement;
  if (groupingSelect) {
    // Enabled only in proximity mode at root level (no cluster/directory drilldown)
    groupingSelect.disabled = !(mode === 'proximity' && !activeClusterId);
  }

  const clustersBtn = document.getElementById('btn-toggle-clusters') as HTMLButtonElement;
  if (clustersBtn) {
    // Clusters toggle only relevant in full codebase mode
    clustersBtn.disabled = mode !== 'full';
  }

  const breadcrumb = document.getElementById('cluster-breadcrumb');
  if (breadcrumb) {
    // Breadcrumbs visible in proximity (drilldown) and focus modes
    const showBreadcrumb = (mode === 'proximity' && activeClusterId) || mode === 'focus';
    breadcrumb.style.display = showBreadcrumb ? 'inline-flex' : 'none';
  }

  // Separator visible when any of breadcrumb or focus panel are showing
  const separator = document.getElementById('toolbar-separator');
  if (separator) {
    const breadcrumbVisible = breadcrumb?.style.display !== 'none';
    const focusVisible = focusSearchContainer?.style.display !== 'none';
    separator.style.display = (breadcrumbVisible || focusVisible) ? 'block' : 'none';
  }
}

// Setup Cytoscape view and fetch graph
/** The dashboard's font stack, for canvas text (cytoscape cannot read CSS variables). */
const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/**
 * A theme colour token's current value (M4-17), optionally at an alpha: cytoscape draws on a
 * canvas and cannot use CSS variables, so its style is rebuilt from the tokens on a theme change.
 */
function t(token: string, alpha?: number): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim() || '#888888';
  if (alpha === undefined) return value;
  const hex = value.replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(full.slice(k, k + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The graph's cytoscape style, from the current theme's tokens. */
function graphStyle(): any[] {
  return [
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'color': t('--text-main'),
        'font-family': FONT_SANS,
        'font-size': '11px',
        'font-weight': '600',
        // Labels too small to read at the current zoom are hidden, and come back on zooming in.
        'min-zoomed-font-size': 7,
        'background-color': t('--text-muted'),
        'shape': 'ellipse',
        'width': (node: any) => {
          if (node.isParent && node.isParent()) return 'auto';
          const deg = node.degree ? node.degree() : 0;
          return (32 + Math.min(deg * 2, 48)) + 'px';
        },
        'height': (node: any) => {
          if (node.isParent && node.isParent()) return 'auto';
          const deg = node.degree ? node.degree() : 0;
          return (32 + Math.min(deg * 2, 48)) + 'px';
        },
        'text-valign': 'top',
        'text-margin-y': -6,
        'z-index': 10,
        'overlay-color': t('--syntax-blue'),
        'overlay-opacity': 0.08,
        'text-outline-color': t('--bg-card'),
        'text-outline-width': '1px',
        'transition-property': 'opacity, width, height, border-color, border-width, background-color',
        'transition-duration': 0.2
      } as any
    },
    {
      selector: 'node[type="file"]',
      style: {
        'shape': 'ellipse',
        'border-width': '1px',
        'border-color': t('--bg-card')
      }
    },
    {
      selector: 'node[type="symbol"]',
      style: {
        'shape': 'ellipse',
        'border-width': '1px',
        'border-color': t('--bg-card')
      }
    },
    {
      selector: ':parent',
      style: {
        'background-color': t('--bg-card', 0.15),
        'border-width': '1px',
        'border-color': t('--border-strong'),
        'border-style': 'dashed',
        'label': 'data(label)',
        'color': t('--text-main'),
        'font-family': FONT_SANS,
        'font-size': '12px',
        'font-weight': 'bold',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-outline-width': '1px',
        'text-outline-color': t('--bg-main'),
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
      selector: 'node[type="file"][?role]',
      style: {
        'background-color': (node: any) => {
          const r = node.data('role');
          return LAYER_COLORS[`layer:${r}`] || t('--text-muted');
        }
      }
    },
    {
      selector: 'edge',
      style: {
        'width': 1,
        'line-color': t('--border-base', 0.18),
        'target-arrow-color': t('--border-base', 0.18),
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'overlay-color': t('--syntax-blue'),
        'overlay-opacity': 0.05,
        'z-index': 1,
        'transition-property': 'opacity, width, line-color, target-arrow-color',
        'transition-duration': 0.2
      }
    },
    {
      selector: 'edge[type="route"]',
      style: {
        'line-color': t('--syntax-green', 0.7),
        'target-arrow-color': t('--syntax-green', 0.7)
      }
    },
    {
      selector: 'edge[source = target]',
      style: {
        // Self-edges should not use taxi/straight/segments.
        'curve-style': 'bezier',

        // Makes the self-loop visible instead of collapsed.
        'loop-direction': '45deg',
        'loop-sweep': '120deg',

        // Gives the loop enough size to avoid invalid endpoints.
        'control-point-step-size': 70,

        'source-endpoint': 'outside-to-node',
        'target-endpoint': 'outside-to-node',

        'target-arrow-shape': 'triangle',
      },
    },
    {
      selector: 'edge[type="cluster-dependency"]',
      style: {
        'width': '2px',
        'line-color': t('--syntax-blue'),
        'target-arrow-color': t('--syntax-blue'),
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'label': 'data(label)',
        'color': t('--syntax-blue'),
        'font-family': FONT_SANS,
        'font-size': '10px',
        'font-weight': 'bold',
        'text-background-color': t('--bg-card'),
        'text-background-opacity': 0.95,
        'text-background-padding': '3px',
        'text-background-shape': 'roundrectangle'
      }
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': '1.5px',
        'border-color': t('--syntax-blue')
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
        'border-width': '2px',
        'border-color': t('--syntax-blue'),
        'overlay-opacity': 0.15,
        'z-index': 9999,
        'opacity': 1,
        'text-opacity': 1
      }
    },
    {
      selector: '.highlighted-outgoing',
      style: {
        'line-color': t('--syntax-green'),
        'target-arrow-color': t('--syntax-green'),
        'width': 2,
        'z-index': 9998,
        'opacity': 1
      }
    },
    {
      selector: '.highlighted-outgoing-node',
      style: {
        'font-size': '11.5px',
        'border-width': '1.8px',
        'border-color': t('--syntax-green'),
        'z-index': 9997,
        'opacity': 1,
        'text-opacity': 1
      }
    },
    {
      selector: '.highlighted-incoming',
      style: {
        'line-color': t('--syntax-purple'),
        'target-arrow-color': t('--syntax-purple'),
        'width': 2,
        'z-index': 9998,
        'opacity': 1
      }
    },
    {
      selector: '.highlighted-incoming-node',
      style: {
        'font-size': '11.5px',
        'border-width': '1.8px',
        'border-color': t('--syntax-purple'),
        'z-index': 9997,
        'opacity': 1,
        'text-opacity': 1
      }
    },
    {
      selector: ':parent.highlighted-parent-active',
      style: {
        'border-color': t('--syntax-blue'),
        'border-width': '1.5px',
        'border-style': 'solid',
        'background-color': t('--border-base', 0.55),
        'color': t('--syntax-blue'),
        'text-outline-color': t('--bg-main')
      }
    },
    {
      selector: ':parent.highlighted-parent-outgoing',
      style: {
        'border-color': t('--syntax-green'),
        'border-width': '1.5px',
        'border-style': 'solid',
        'background-color': t('--border-base', 0.55),
        'color': t('--syntax-green'),
        'text-outline-color': t('--bg-main')
      }
    },
    {
      selector: ':parent.highlighted-parent-incoming',
      style: {
        'border-color': t('--syntax-purple'),
        'border-width': '1.5px',
        'border-style': 'solid',
        'background-color': t('--border-base', 0.55),
        'color': t('--syntax-purple'),
        'text-outline-color': t('--bg-main')
      }
    },
    {
      selector: 'node[type="parent-folder"]',
      style: {
        'shape': 'round-rectangle',
        'background-color': t('--border-strong'),
        'border-width': '2px',
        'border-color': t('--syntax-blue'),
        'width': '60px',
        'height': '40px',
        'font-size': '10px',
        'font-weight': 'bold',
        'color': t('--text-main'),
        'text-valign': 'center',
        'text-halign': 'center',
        'text-outline-width': '0px',
        'text-wrap': 'ellipsis',
        'text-max-width': '100px',
        'text-overflow-wrap': 'anywhere',
        'z-index': 15
      }
    },
    {
      selector: 'edge[type="aggregated-dependency"]',
      style: {
        'width': (edge: any) => {
          const cnt = edge.data('count') || 1;
          return Math.min(1.5 + Math.log2(cnt), 7) + 'px';
        },
        'line-color': t('--syntax-blue', 0.45),
        'target-arrow-color': t('--syntax-blue', 0.45),
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'label': 'data(label)',
        'color': t('--text-main'),
        'font-family': FONT_SANS,
        'font-size': '9px',
        'font-weight': 'bold',
        'text-background-color': t('--bg-card'),
        'text-background-opacity': 1,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle'
      }
    },
    {
      selector: 'node[?isSeed]',
      style: {
        'background-color': t('--syntax-green'),
        'border-color': t('--syntax-yellow'),
        'border-width': '3px',
        'width': '46px',
        'height': '46px',
        'z-index': 9999
      }
    },
    {
      selector: 'node[type="cluster-group"]',
      style: {
        'shape': 'hexagon',
        'background-color': t('--bg-card'),
        'background-opacity': 0.85,
        'border-width': '3px',
        'border-color': t('--syntax-orange'),
        'width': (node: any) => {
          const fileCount = node.data('fileCount') || 1;
          return (70 + Math.min(Math.log2(fileCount) * 8, 40)) + 'px';
        },
        'height': (node: any) => {
          const fileCount = node.data('fileCount') || 1;
          return (70 + Math.min(Math.log2(fileCount) * 8, 40)) + 'px';
        },
        'color': t('--text-white'),
        'font-family': FONT_SANS,
        'font-size': '14px',
        'font-weight': 'bold',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-outline-width': '2px',
        'text-outline-color': t('--bg-main'),
        'text-wrap': 'ellipsis',
        'text-max-width': (node: any) => {
          const fileCount = node.data('fileCount') || 1;
          return (60 + Math.min(Math.log2(fileCount) * 8, 40)) + 'px';
        },
        'text-overflow-wrap': 'anywhere',
        'line-height': 1.25,
        'z-index': 15,
        'transition-property': 'background-color, border-color, border-width, width, height',
        'transition-duration': 0.2
      }
    },
    {
      // Layer-colored cluster nodes: use the layerColor data property for border + glow
      selector: 'node[type="cluster-group"][?layerColor]',
      style: {
        'border-color': (node: any) => node.data('layerColor') || t('--syntax-orange'),
        'background-color': (node: any) => {
          const c = node.data('layerColor') as string | null;
          if (!c) return t('--bg-card');
          // Darken the layer color to use as background fill
          return c + '22'; // 13% opacity hex
        },
      }
    },
    {
      selector: 'node[type="cluster-group"][?isFolderFallback]',
      style: {
        'shape': 'round-rectangle',
        'border-style': 'dashed',
        'border-color': t('--syntax-yellow'), // Folder yellow
        'background-color': t('--success-surface'), // Toned-down dark background
      }
    },
    {
      selector: 'node[type="cluster-group"][?isOrphans]',
      style: {
        'shape': 'ellipse',
        'border-style': 'dashed',
        'border-color': t('--syntax-red'), // Crimson red
        'background-color': t('--danger-surface'), // Toned-down dark red background
      }
    },
    {
      selector: 'node[type="cluster-group"][?isSingulars]',
      style: {
        'shape': 'ellipse',
        'border-style': 'dashed',
        'border-color': t('--syntax-green'), // Green
        'background-color': t('--success-surface'), // Toned-down dark green background
      }
    },
    {
      selector: 'node[?isHub]',
      style: {
        'width': 52,
        'height': 52,
        'border-color': t('--danger'),
        'border-width': 2.5,
        'border-style': 'solid'
      }
    },
    {
      // Edges into another registered repo (M4-21): dashed, in their own colour, above the rest.
      selector: 'edge[?crossRepo]',
      style: {
        'line-color': t('--syntax-pink'),
        'target-arrow-color': t('--syntax-pink'),
        'line-style': 'dashed',
        'width': 2.5,
        'z-index': 30,
      }
    },
    {
      selector: 'edge[?isCycle]',
      style: {
        'line-color': t('--danger'),
        'target-arrow-color': t('--danger'),
        'width': 3,
        'line-style': 'dashed'
      }
    },
    {
      selector: 'node[?isBoundaryNode]',
      style: {
        'border-style': 'dashed',
        'border-width': '2.5px',
        'border-color': t('--syntax-yellow'),
        'opacity': 0.45,
        'text-opacity': 0.6
      }
    },
    {
      selector: 'edge[type="cluster-edge"]',
      style: {
        'width': (edge: any) => {
          const cnt = edge.data('count') || 1;
          return Math.min(2 + Math.log2(cnt) * 1.5, 8) + 'px';
        },
        'line-color': t('--syntax-orange', 0.45),
        'target-arrow-color': t('--syntax-orange', 0.45),
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'label': 'data(label)',
        'color': t('--text-main'),
        'font-family': FONT_SANS,
        'font-size': '10px',
        'font-weight': 'bold',
        'text-background-color': t('--bg-card'),
        'text-background-opacity': 0.95,
        'text-background-padding': '3px',
        'text-background-shape': 'roundrectangle'
      }
    }
  ];
}

/** The user picked a grouping: the adaptive default no longer applies. */
let groupingChosen = false;

/**
 * The Clusters Map's default grouping adapts to the project (M4-17): grouping by architecture
 * layer says little when most files have no layer (they all land in "Other"), so then the map
 * groups by directory instead. A grouping the user picked is kept.
 */
function adaptGrouping() {
  if (groupingChosen || groupingStrategy !== 'layer') return;
  const layered = new Set<string>();
  for (const m of rawClustersData.memberships ?? []) {
    if (typeof m.clusterName === 'string' && m.clusterName.startsWith('layer:') && m.clusterName !== 'layer:other') layered.add(m.filePath);
  }
  const files = rawGraphElements.filter((el) => el.data?.type === 'file');
  if (files.length < 20) return;
  const other = files.filter((el) => (!el.data.role || el.data.role === 'other') && !layered.has(el.data.id)).length;
  if (other / files.length < 0.6) return;
  groupingStrategy = 'directory';
  const select = document.getElementById('select-grouping-strategy') as HTMLSelectElement | null;
  if (select) select.value = 'directory';
}

async function loadGraph() {
  const overlay = document.getElementById('graph-loading-overlay');
  const overlayLabel = document.getElementById('graph-loading-label');
  const showOverlay = (msg: string) => {
    if (overlay) overlay.classList.remove('hidden');
    if (overlayLabel) overlayLabel.textContent = msg;
  };
  const hideOverlay = () => {
    if (overlay) overlay.classList.add('hidden');
  };

  showOverlay('Fetching graph data…');
  markGraph('loading');
  try {
    const gen = repoGeneration;
    const res = await fetch(withRepo('/api/graph', 'any'));
    if (gen !== repoGeneration) return; // a newer repo choice is loading
    if (!res.ok) { hideOverlay(); markGraph('error'); return; }
    const parsed = await res.json();
    if (gen !== repoGeneration) return;
    rawGraphElements = parsed.filter((el: any) => {
      // Drop self-loop edges (source === target) — they are scanner artifacts
      // and produce an "invalid endpoints" warning in cytoscape
      if (el.data && el.data.source && el.data.target && el.data.source === el.data.target) return false;
      return true;
    });

    const container = document.getElementById('cy');
    if (!container) return;

    // Load clusters mapping for Proximity Clusters Mode
    await loadClusters();
    if (gen !== repoGeneration) return;
    adaptGrouping();

    // The view stays what the user chose (Clusters Map at first): a reload (a repo switch, a new
    // scan) used to reset it, overriding a choice made while the graph was loading (M4-21 review).
    const modeSelect = document.getElementById('select-graph-mode') as HTMLSelectElement;
    if (modeSelect) modeSelect.value = currentGraphMode;

    const focusSearchContainer = document.getElementById('focus-search-container');
    if (focusSearchContainer) {
      focusSearchContainer.style.display = currentGraphMode === 'focus' ? 'inline-flex' : 'none';
    }

    const groupingSelect = document.getElementById('select-grouping-strategy');
    if (groupingSelect) {
      groupingSelect.style.display = currentGraphMode === 'proximity' ? 'inline-flex' : 'none';
    }

    const breadcrumb = document.getElementById('cluster-breadcrumb');
    const shouldDisplay = (currentGraphMode === 'proximity' && activeClusterId);
    if (breadcrumb) breadcrumb.style.display = shouldDisplay ? 'inline-flex' : 'none';

    // Populate focus search autocompletion datalist
    const focusSearchList = document.getElementById('focus-search-list');
    if (focusSearchList) {
      focusSearchList.innerHTML = '';
      const fileNodes = rawGraphElements.filter(el => el.data && el.data.type === 'file');
      fileNodes.forEach(node => {
        const option = document.createElement('option');
        option.value = node.data.id;
        focusSearchList.appendChild(option);
      });
    }

    const initialElements = buildGraphElementsForMode();

    if (initialElements.length === 0) {
      hideOverlay();
      markGraph('empty');
      container.innerHTML = '<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; font-size: 15px; color: var(--text-muted); text-align: center; gap: 8px; padding: 20px;"><div style="font-size: 24px;">🕸️</div><div>No codebase graph elements found.</div><div style="font-size: 12px; opacity: 0.8;">Run a scan using the mapx CLI/MCP to index files and generate the graph.</div></div>';
      return;
    }

    showOverlay('Building graph…');
    // Yield to the browser so the overlay message renders before the heavy
    // synchronous Cytoscape initialisation blocks the main thread.
    await new Promise(resolve => setTimeout(resolve, 0));

    container.innerHTML = '';

    cyInstance = cytoscape({
      container: container,
      elements: initialElements,
      wheelSensitivity: 1.33,
      style: graphStyle(),
      layout: { name: 'preset' }
    });

    // The first layout runs after its listener is attached: a synchronous (unanimated) layout
    // stops inside run(), so a listener added after construction would miss it.
    showOverlay('Running layout…');
    cyInstance.one('layoutstop', () => hideOverlay());
    runLayout(getLayoutOptions(showClusters, false));
    // Safety net: always hide after 10 s even if the event never fires.
    setTimeout(() => hideOverlay(), 10000);

    // Layout dropdown handler
    const layoutSelect = document.getElementById('select-layout') as HTMLSelectElement;
    if (layoutSelect) {
      layoutSelect.value = activeLayoutName;
      layoutSelect.addEventListener('change', () => {
        activeLayoutName = layoutSelect.value as any;
        const elementCount = cyInstance.elements().length;
        runLayout(getLayoutConfigForName(activeLayoutName, elementCount));
      });
    }

    updateToolbarVisibility(currentGraphMode);

    document.getElementById('select-graph-mode')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as any;
      currentGraphMode = mode;
      updateToolbarVisibility(mode);
      updateGraphDisplay();
    });

    // Grouping strategy change listener
    document.getElementById('select-grouping-strategy')?.addEventListener('change', (e) => {
      groupingStrategy = (e.target as HTMLSelectElement).value as any;
      groupingChosen = true;
      updateGraphDisplay();
    });

    // Breadcrumbs root button click listener
    document.getElementById('btn-breadcrumb-root')?.addEventListener('click', () => {
      activeClusterId = null;
      updateToolbarVisibility(currentGraphMode);

      const breadcrumb = document.getElementById('cluster-breadcrumb');
      if (breadcrumb) {
        breadcrumb.style.display = 'none';
      }

      updateGraphDisplay();
    });

    // === Custom Autocomplete for Neighborhood Focus Mode ===
    const focusSearchInput = document.getElementById('focus-search-input') as HTMLInputElement;
    const focusAutocomplete = document.getElementById('focus-autocomplete') as HTMLDivElement;
    let acActiveIndex = -1;
    let acItems: HTMLElement[] = [];
    let searchDebounceTimeout: any = null;

    function getFileNodes() {
      return rawGraphElements.filter(el => el.data && el.data.type === 'file');
    }

    /** `text` as escaped HTML, with the first match of `query` wrapped in a highlight. */
    function highlightMatch(text: string, query: string): string {
      if (!query) return escapeHtml(text);
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx === -1) return escapeHtml(text);
      return escapeHtml(text.substring(0, idx)) +
        `<span class="ac-match">${escapeHtml(text.substring(idx, idx + query.length))}</span>` +
        escapeHtml(text.substring(idx + query.length));
    }

    function showAutocomplete(query: string) {
      if (!focusAutocomplete || !query) {
        hideAutocomplete();
        return;
      }

      const fileNodes = getFileNodes();
      const lowerQuery = query.toLowerCase();
      const matches = fileNodes
        .filter(el => el.data.id.toLowerCase().includes(lowerQuery))
        .slice(0, 10);

      if (matches.length === 0) {
        focusAutocomplete.innerHTML = '<div class="focus-autocomplete-empty">No matching files found</div>';
        focusAutocomplete.classList.add('open');
        acItems = [];
        acActiveIndex = -1;
        return;
      }

      focusAutocomplete.innerHTML = matches.map((el, i) => {
        const id = el.data.id;
        const fileName = id.split('/').pop() || id;
        const dirPath = id.includes('/') ? id.substring(0, id.lastIndexOf('/')) : '';
        const lang = el.data.language || '';
        return `<div class="focus-autocomplete-item${i === 0 ? ' active' : ''}" data-file-id="${escapeHtml(id)}">
          <span class="ac-file-name">${highlightMatch(fileName, lowerQuery)}</span>
          <span class="ac-file-path">${dirPath ? highlightMatch(dirPath, lowerQuery) : ''}</span>
          ${lang ? `<span class="ac-lang-badge">${escapeHtml(lang)}</span>` : ''}
        </div>`;
      }).join('');

      focusAutocomplete.classList.add('open');
      acItems = Array.from(focusAutocomplete.querySelectorAll('.focus-autocomplete-item'));
      acActiveIndex = 0;
    }

    function hideAutocomplete() {
      if (focusAutocomplete) {
        focusAutocomplete.classList.remove('open');
        focusAutocomplete.innerHTML = '';
      }
      acItems = [];
      acActiveIndex = -1;
    }

    function selectAutocompleteItem(fileId: string) {
      focusSeedNode = fileId;
      if (focusSearchInput) focusSearchInput.value = fileId;
      hideAutocomplete();
      // Update breadcrumb to show focused file
      const activeLabel = document.getElementById('breadcrumb-active-cluster');
      if (activeLabel) activeLabel.textContent = fileId.split('/').pop() || fileId;
      const breadcrumb = document.getElementById('cluster-breadcrumb');
      if (breadcrumb) breadcrumb.style.display = 'inline-flex';

      const rootBtn = document.getElementById('btn-breadcrumb-root');
      if (rootBtn) rootBtn.textContent = 'Focus';

      updateGraphDisplay();
    }

    focusSearchInput?.addEventListener('input', (e) => {
      clearTimeout(searchDebounceTimeout);
      const query = (e.target as HTMLInputElement).value.trim();
      searchDebounceTimeout = setTimeout(() => showAutocomplete(query), 150);
    });

    focusSearchInput?.addEventListener('keydown', (e) => {
      if (!focusAutocomplete?.classList.contains('open')) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (acActiveIndex < acItems.length - 1) {
          acItems[acActiveIndex]?.classList.remove('active');
          acActiveIndex++;
          acItems[acActiveIndex]?.classList.add('active');
          acItems[acActiveIndex]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (acActiveIndex > 0) {
          acItems[acActiveIndex]?.classList.remove('active');
          acActiveIndex--;
          acItems[acActiveIndex]?.classList.add('active');
          acItems[acActiveIndex]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (acActiveIndex >= 0 && acItems[acActiveIndex]) {
          const fileId = acItems[acActiveIndex].getAttribute('data-file-id');
          if (fileId) selectAutocompleteItem(fileId);
        }
      } else if (e.key === 'Escape') {
        hideAutocomplete();
      }
    });

    focusAutocomplete?.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.focus-autocomplete-item');
      if (item) {
        const fileId = item.getAttribute('data-file-id');
        if (fileId) selectAutocompleteItem(fileId);
      }
    });

    // Close autocomplete when clicking outside
    document.addEventListener('click', (e) => {
      if (focusSearchInput && focusAutocomplete) {
        if (!focusSearchInput.contains(e.target as Node) && !focusAutocomplete.contains(e.target as Node)) {
          hideAutocomplete();
        }
      }
    });

    // Segmented Depth Toggle
    const depthButtons = document.querySelectorAll('.depth-btn');
    depthButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        depthButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        focusDepth = parseInt(btn.getAttribute('data-depth') || '1', 10);
        if (focusSeedNode) updateGraphDisplay();
      });
    });

    // Focus clear button
    document.getElementById('btn-focus-clear')?.addEventListener('click', () => {
      if (focusSearchInput) focusSearchInput.value = '';
      hideAutocomplete();
      const firstFile = rawGraphElements.find(el => el.data && el.data.type === 'file');
      focusSeedNode = firstFile ? firstFile.data.id : null;
      updateGraphDisplay();
    });

    // Register double click / double tap event to focus on a node
    cyInstance.on('dbltap', 'node', (evt: any) => {
      const node = evt.target;
      const data = node.data();
      if (currentGraphMode === 'focus' && data.type === 'file') {
        focusSeedNode = data.id;
        if (focusSearchInput) {
          focusSearchInput.value = data.id;
        }
        updateGraphDisplay();
      }
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
          <span>Toggle Clusters</span>
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
          <span>Toggle Clusters</span>
        `;
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
      }

      updateGraphDisplay();
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

    // Helper to build organized related flows for a node
    function buildRelatedFlowsHTML(node: any): string {
      const id = node.id();
      const isCluster = node.data('type') === 'parent';
      const label = isCluster ? id.replace('dir:', '') : id;

      const outgoingEdges = node.outgoers('edge');
      const incomingEdges = node.incomers('edge');

      let html = `<div class="flows-section">`;
      html += `<div class="flows-title">Related Flows</div>`;

      // Outgoing Group (Collapsible details, collapsed by default)
      html += `<details class="flow-details-el">`;
      html += `<summary class="flow-summary-el">`;
      html += `<svg class="flow-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      html += `<span class="flow-group-title outgoing" style="margin: 0; display: inline-flex;">Outgoing (Dependencies)</span>`;
      html += `</summary>`;
      html += `<div class="flow-content-el">`;

      if (outgoingEdges && outgoingEdges.length > 0) {
        html += `<ul class="flow-list">`;
        outgoingEdges.forEach((edge: any) => {
          const edgeId = edge.id();
          const edgeType = edge.data('type') || 'dependency';
          const targetNode = edge.target();
          const targetId = targetNode.id();
          const targetLabel = targetNode.data('type') === 'parent' ? targetId.replace('dir:', '') : targetId;

          html += `
            <li class="flow-item">
              <span class="flow-current">${escapeHtml(label)}</span>
              <button type="button" class="flow-clickable-edge" data-go-id="${escapeHtml(edgeId)}">${escapeHtml(edgeType.toUpperCase())}</button>
              <span class="flow-arrow">&rarr;</span>
              <button type="button" class="flow-clickable-node" data-go-id="${escapeHtml(targetId)}">${escapeHtml(targetLabel)}</button>
            </li>
          `;
        });
        html += `</ul>`;
      } else {
        html += `<div class="flow-empty">No outgoing dependencies</div>`;
      }
      html += `</div>`;
      html += `</details>`;

      // Incoming Group (Collapsible details, collapsed by default)
      html += `<details class="flow-details-el">`;
      html += `<summary class="flow-summary-el">`;
      html += `<svg class="flow-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      html += `<span class="flow-group-title incoming" style="margin: 0; display: inline-flex;">Incoming (Dependents)</span>`;
      html += `</summary>`;
      html += `<div class="flow-content-el">`;

      if (incomingEdges && incomingEdges.length > 0) {
        html += `<ul class="flow-list">`;
        incomingEdges.forEach((edge: any) => {
          const edgeId = edge.id();
          const edgeType = edge.data('type') || 'dependency';
          const sourceNode = edge.source();
          const sourceId = sourceNode.id();
          const sourceLabel = sourceNode.data('type') === 'parent' ? sourceId.replace('dir:', '') : sourceId;

          html += `
            <li class="flow-item">
              <button type="button" class="flow-clickable-node incoming-node" data-go-id="${escapeHtml(sourceId)}">${escapeHtml(sourceLabel)}</button>
              <span class="flow-arrow">&rarr;</span>
              <button type="button" class="flow-clickable-edge" data-go-id="${escapeHtml(edgeId)}">${escapeHtml(edgeType.toUpperCase())}</button>
              <span class="flow-arrow">&rarr;</span>
              <span class="flow-current">${escapeHtml(label)}</span>
            </li>
          `;
        });
        html += `</ul>`;
      } else {
        html += `<div class="flow-empty">No incoming dependents</div>`;
      }
      html += `</div>`;
      html += `</details>`;

      html += `</div>`;
      return html;
    }

    // Helper to build source & destination nodes list for an edge
    function buildRelatedNodesForEdgeHTML(edge: any): string {
      const sourceNode = edge.source();
      const targetNode = edge.target();
      const sourceId = sourceNode.id();
      const targetId = targetNode.id();
      const sourceLabel = sourceNode.data('type') === 'parent' ? sourceId.replace('dir:', '') : sourceId;
      const targetLabel = targetNode.data('type') === 'parent' ? targetId.replace('dir:', '') : targetId;

      return `
        <div class="flows-section">
          <div class="flows-title">Related Nodes</div>
          <div class="flow-group" style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">Source Node</div>
            <button type="button" class="flow-clickable-node" data-go-id="${escapeHtml(sourceId)}">
              ${escapeHtml(sourceLabel)}
            </button>
          </div>
          <div class="flow-group" style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">Destination Node</div>
            <button type="button" class="flow-clickable-node" data-go-id="${escapeHtml(targetId)}" style="background: color-mix(in srgb, var(--syntax-blue) 16%, transparent); color: var(--syntax-blue); border-color: color-mix(in srgb, var(--syntax-blue) 35%, transparent);">
              ${escapeHtml(targetLabel)}
            </button>
          </div>
        </div>
      `;
    }

    // Node & Edge selection details panel and highlighting
    cyInstance.on('tap', 'node', (evt: any) => {
      const node = evt.target;
      const data = node.data();
      const details = document.getElementById('details-content');

      // If tapping a collapsed cluster-group node, enter drill-down view
      if (data.type === 'cluster-group') {
        activeClusterId = data.id;
        updateToolbarVisibility(currentGraphMode);
        const breadcrumb = document.getElementById('cluster-breadcrumb');
        if (breadcrumb) {
          breadcrumb.style.display = 'inline-flex';
        }
        const activeLabel = document.getElementById('breadcrumb-active-cluster');
        if (activeLabel) {
          activeLabel.textContent = data.label || data.id;
        }
        updateGraphDisplay();
        return;
      }

      if (details) {
        if (data.type === 'parent') {
          details.innerHTML = `
            <div style="font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: var(--text-main); display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div class="detail-stat-row">
                <span class="detail-stat-label">Type</span>
                <span class="detail-stat-value" style="color: var(--syntax-green); font-weight: bold;">DIRECTORY CLUSTER</span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Path</span>
                <span class="detail-stat-value">${escapeHtml(data.fullPath || data.id.replace('dir:', ''))}</span>
              </div>
            </div>
          ` + buildRelatedFlowsHTML(node);
        } else {
          const tags = customTags.get(data.id) || [];
          const tagsListHtml = tags.map(t =>
            `<span class="tag-badge">${escapeHtml(t)}<button class="tag-badge-remove" data-node-id="${escapeHtml(data.id)}" data-tag="${escapeHtml(t)}" title="Remove tag">&times;</button></span>`
          ).join('');

          // Compute degree stats
          const inDeg = node.indegree ? node.indegree() : 0;
          const outDeg = node.outdegree ? node.outdegree() : 0;
          const totalDeg = node.degree ? node.degree() : (inDeg + outDeg);

          // Check for enriched data from API
          const symbolCount = data.symbolCount || 0;
          const pagerank = data.pagerank != null ? (data.pagerank * 1000).toFixed(2) : null;

          // Find cluster membership if available
          let clusterLabel = '';
          if (node.parent && node.parent().length > 0) {
            const parentData = node.parent().data();
            clusterLabel = parentData?.label || parentData?.id || '';
          }

          // Compute smells details
          const fileSmells = rawSmellsData.filter((s: any) => {
            if (Array.isArray(s.involvedFiles)) {
              return s.involvedFiles.includes(data.id);
            }
            if (typeof s.involved_files === 'string') {
              try {
                const files = JSON.parse(s.involved_files);
                return Array.isArray(files) && files.includes(data.id);
              } catch {
                return false;
              }
            }
            return false;
          });

          let smellsHtml = '';
          if (fileSmells.length > 0) {
            smellsHtml = `
              <div style="border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; display: flex; flex-direction: column; gap: 6px;">
                <span class="detail-stat-label" style="color: var(--danger); font-weight: bold;">Smells & Health</span>
                <ul style="list-style: none; padding: 0; margin: 0;">
                  ${fileSmells.map((s: any) => `
                    <li style="margin-bottom: 4px;">
                      <span class="smell-badge-mini ${escapeHtml(s.severity.toLowerCase())}">${escapeHtml(s.severity.toUpperCase())}</span>
                      <strong>${escapeHtml(s.type.toUpperCase())}</strong>: ${escapeHtml(s.description)}
                      <div style="color: var(--text-muted); font-style: italic; margin-top: 2px; margin-left: 8px;">💡 Suggestion: ${escapeHtml(s.suggestion)}</div>
                    </li>
                  `).join('')}
                </ul>
              </div>
            `;
          } else {
            smellsHtml = `
              <div style="padding-bottom: 8px; display: flex; flex-direction: column; gap: 4px;">
                <span class="detail-stat-label">Smells & Health</span>
                <span style="color: var(--syntax-green); font-size: 11px; padding-left: 4px;">🟢 Clean — No design smells detected</span>
              </div>
            `;
          }

          const fileRole = data.role || 'other';
          const roleConf = typeof data.roleConfidence === 'number' ? data.roleConfidence : (typeof data.role_confidence === 'number' ? data.role_confidence : 1.0);
          const roleColor = layerToken(fileRole);

          const classificationHtml = `
            <div style="border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; display: flex; flex-direction: column; gap: 6px;">
              <span class="detail-stat-label">Smart Classification</span>
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                <span class="selection-badge" style="--badge: ${roleColor};">${escapeHtml(fileRole.toUpperCase())}</span>
                <span style="color: var(--text-muted); font-size: 11px;">(conf: ${roleConf.toFixed(2)})</span>
              </div>
              <div id="classification-signals-container" style="color: var(--text-muted); font-size: 11px;">
                <div style="font-style: italic;">Loading classification signals...</div>
              </div>
            </div>
          `;

          details.innerHTML = `
            <div style="font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: var(--text-main); display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div class="detail-stat-row">
                <span class="detail-stat-label">Path</span>
                <span class="detail-stat-value">${escapeHtml(data.id)}</span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Language</span>
                <span class="detail-stat-value">${escapeHtml(data.language ? data.language.toUpperCase() : 'UNKNOWN')}</span>
              </div>

              <!-- Stats Grid -->
              <div class="detail-stat-grid">
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">Lines</span>
                  <span class="detail-stat-mini-value">${escapeHtml(data.lines || '—')}</span>
                </div>
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">Size</span>
                  <span class="detail-stat-mini-value">${data.size ? `${(data.size / 1024).toFixed(1)}K` : '—'}</span>
                </div>
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">In / Out</span>
                  <span class="detail-stat-mini-value" style="color: var(--syntax-green);">${escapeHtml(inDeg)} / ${escapeHtml(outDeg)}</span>
                </div>
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">Connections</span>
                  <span class="detail-stat-mini-value" style="color: var(--syntax-blue);">${escapeHtml(totalDeg)}</span>
                </div>
                ${symbolCount > 0 ? `
                <div class="detail-stat-grid-item" style="display: none;"></div>
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">Symbols</span>
                  <span class="detail-stat-mini-value">${symbolCount}</span>
                </div>` : ''}
                ${pagerank ? `
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">PageRank</span>
                  <span class="detail-stat-mini-value" style="color: var(--syntax-purple);">${escapeHtml(pagerank)}</span>
                </div>` : ''}
              </div>

              ${data.isBoundaryNode ? `
              <div class="detail-stat-row">
                <span class="detail-stat-label" style="color: var(--syntax-orange);">Role</span>
                <span class="detail-stat-value" style="color: var(--syntax-orange);">Boundary Node</span>
              </div>
              ` : ''}

              ${clusterLabel ? `
              <div class="detail-stat-row">
                <span class="detail-stat-label">Cluster</span>
                <span class="detail-stat-value" style="color: var(--syntax-cyan);">${escapeHtml(clusterLabel)}</span>
              </div>
              ` : ''}

              <!-- Classification & Smells Sections -->
              <div class="file-details-section">
                ${classificationHtml}
                ${smellsHtml}
              </div>

              <!-- Custom Tags Section -->
              <div style="border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; display: flex; flex-direction: column; gap: 6px;">
                <span class="detail-stat-label">Custom Tags</span>
                <div style="margin-bottom: 4px; display: flex; flex-wrap: wrap;">${tagsListHtml || '<span style="color: var(--text-muted); font-style: italic; font-size: 10px;">No tags</span>'}</div>
                <div style="display: flex; gap: 6px; position: relative;">
                  <input type="text" id="input-new-tag" placeholder="Add tag..." class="form-control" style="padding: 4px 8px; font-size: 11px; height: 26px; border-radius: 4px;">
                  <button id="btn-add-tag" class="btn" style="padding: 4px 10px; font-size: 11px; height: 26px; border-radius: 4px; flex-shrink: 0;">Add</button>
                </div>
              </div>

              <!-- Actions Section -->
              <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px;">
                <button class="btn btn-secondary btn-action-remove-node" data-node-id="${escapeHtml(data.id)}" style="padding: 6px 12px; font-size: 11px; border-color: color-mix(in srgb, var(--danger) 35%, transparent); color: var(--danger); width: 100%; border-radius: 4px;">
                  Remove Node from View
                </button>
              </div>
            </div>
          ` + buildRelatedFlowsHTML(node);

          // Fetch signals explanation asynchronously
          fetch(`/api/explain?file=${encodeURIComponent(data.id)}`)
            .then(res => res.json())
            .then(expData => {
              const sigContainer = document.getElementById('classification-signals-container');
              if (!sigContainer) return;
              const signals = expData.signals || [];
              if (signals.length === 0) {
                sigContainer.innerHTML = '<div style="font-style: italic; color: var(--text-muted); padding-left: 4px;">No signals recorded</div>';
                return;
              }
              sigContainer.innerHTML = `
                <ul style="padding-left: 16px; margin: 4px 0 0 0; list-style-type: circle; color: var(--text-main);">
                  ${signals.map((s: any) => `
                    <li style="margin-bottom: 4px;">
                      <strong>[${escapeHtml(s.source)}]</strong> 
                      <span style="color: ${layerToken(s.role)}; font-weight: 500;">${escapeHtml(s.role)}</span> 
                      <span style="color: var(--text-muted); font-size: 10px;">(conf: ${s.confidence.toFixed(2)})</span>
                      <div style="margin-top: 2px; color: var(--text-muted);">${escapeHtml(s.reason)}</div>
                    </li>
                  `).join('')}
                </ul>
              `;
            })
            .catch(err => {
              console.error('Failed to fetch classification details:', err);
              const sigContainer = document.getElementById('classification-signals-container');
              if (sigContainer) sigContainer.innerHTML = '<div style="color: var(--danger); padding-left: 4px;">Failed to load signals</div>';
            });
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
        if (data.type === 'cluster-dependency' || data.type === 'cluster-edge') {
          details.innerHTML = `
            <div style="font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: var(--text-main); display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; align-items: start;">
                <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Edge ID</span>
                <span style="word-break: break-all; text-align: right;">${escapeHtml(data.id)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; align-items: start;">
                <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Source</span>
                <span style="word-break: break-all; text-align: right;">${escapeHtml(data.source.replace('dir:', ''))}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; align-items: start;">
                <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Target</span>
                <span style="word-break: break-all; text-align: right;">${escapeHtml(data.target.replace('dir:', ''))}</span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; align-items: start;">
                <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Edge Type</span>
                <span style="text-align: right;"><span class="selection-badge" style="--badge: var(--syntax-blue);">CLUSTER DEPENDENCY</span></span>
              </div>
              <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; align-items: start;">
                <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Count</span>
                <span style="color: var(--syntax-blue); font-weight: bold; text-align: right;">${escapeHtml(data.count || 1)} file-level edge(s)</span>
              </div>
              
              <!-- Actions Section -->
              <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px;">
                <button class="btn btn-secondary btn-action-remove-edge" data-edge-id="${escapeHtml(data.id)}" style="padding: 6px 12px; font-size: 11px; border-color: color-mix(in srgb, var(--danger) 35%, transparent); color: var(--danger); width: 100%; border-radius: 4px;">
                  Remove Edge from View
                </button>
              </div>
            </div>
          ` + (data.type === 'cluster-dependency' ? buildRelatedNodesForEdgeHTML(edge) : '');
        } else {
          details.innerHTML = `
            <div style="font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: var(--text-main); display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div class="detail-stat-row">
                <span class="detail-stat-label">Source</span>
                <span class="detail-stat-value"><a href="#" data-go-id="${escapeHtml(data.source)}" style="color: var(--syntax-blue); text-decoration: none;">${escapeHtml(data.source.split('/').pop())}</a></span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Target</span>
                <span class="detail-stat-value"><a href="#" data-go-id="${escapeHtml(data.target)}" style="color: var(--syntax-blue); text-decoration: none;">${escapeHtml(data.target.split('/').pop())}</a></span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Edge Type</span>
                <span class="detail-stat-value"><span class="selection-badge" style="--badge: var(--syntax-purple);">${escapeHtml(data.type.toUpperCase())}</span></span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Verifiability</span>
                <span class="detail-stat-value"><span class="verifiability-badge ${data.verifiability === 'verified' ? 'verified' : 'inferred'}">${escapeHtml(data.verifiability || 'unknown')}</span></span>
              </div>
              ${data.weight ? `
              <div class="detail-stat-row">
                <span class="detail-stat-label">Weight</span>
                <span class="detail-stat-value">${escapeHtml(data.weight)}</span>
              </div>
              ` : ''}
              
              <!-- Actions Section -->
              <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px;">
                <button class="btn btn-secondary btn-action-remove-edge" data-edge-id="${escapeHtml(data.id)}" style="padding: 6px 12px; font-size: 11px; border-color: color-mix(in srgb, var(--danger) 35%, transparent); color: var(--danger); width: 100%; border-radius: 4px;">
                  Remove Edge from View
                </button>
              </div>
            </div>
          ` + buildRelatedNodesForEdgeHTML(edge);
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
          details.innerHTML = DETAILS_PLACEHOLDER;
        }
      }
    });

  } catch (err) {
    hideOverlay();
    markGraph('error');
    console.error('Failed to load graph:', err);
  }
}

// Fetch symbols
async function loadSymbols(query: string = '') {
  const gen = repoGeneration;
  const PAGE_SIZE = 50;
  try {
    const offset = symbolPage * PAGE_SIZE;
    const res = await fetch(withRepo(`/api/symbols?q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=${offset}`, 'any'));
    if (!res.ok) return;
    const data = await res.json();
    if (gen !== repoGeneration) return; // a newer repo choice is loading
    const symbols: any[] = data.results ?? [];
    const total: number = data.total ?? symbols.length;

    const tbody = document.querySelector('#table-symbols tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (symbols.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td colspan="3" style="text-align: center; color: var(--text-muted); padding: 30px; font-style: italic;">
          No symbols found matching "${escapeHtml(query || '')}"
        </td>
      `;
      tbody.appendChild(tr);
      updateSymbolPagination(0, 0, 0, PAGE_SIZE);
      return;
    }

    symbols.forEach((s: any) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><button type="button" class="link-btn">${escapeHtml(s.name)}</button></td>
        <td class="col-optional">${escapeHtml(s.kind)}</td>
        <td style="color:var(--text-muted); font-size:12px;">${escapeHtml(s.file_path)}</td>
      `;
      tr.dataset.symbolName = s.name;
      tr.addEventListener('click', () => {
        document.querySelectorAll('#table-symbols tbody tr').forEach(r => r.classList.remove('selected-symbol-row'));
        tr.classList.add('selected-symbol-row');
        loadSymbolDetails(s.name);
      });
      tbody.appendChild(tr);
    });

    updateSymbolPagination(offset, symbols.length, total, PAGE_SIZE);
  } catch (err) {
    console.error(err);
  }
}

function updateSymbolPagination(offset: number, count: number, total: number, pageSize: number) {
  const atStart = symbolPage === 0;
  const atEnd = offset + count >= total;
  const text = total === 0 ? 'No results' : `${offset + 1}–${offset + count} of ${total}`;

  for (const suffix of ['', '-top']) {
    const info = document.getElementById(`symbol-page-info${suffix}`);
    const prevBtn = document.getElementById(`symbol-page-prev${suffix}`) as HTMLButtonElement | null;
    const nextBtn = document.getElementById(`symbol-page-next${suffix}`) as HTMLButtonElement | null;
    if (info) info.textContent = text;
    if (prevBtn) prevBtn.disabled = atStart;
    if (nextBtn) nextBtn.disabled = atEnd;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
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
      <div style="font-family: var(--font-mono); font-size: 12px; line-height: 1.6; color: var(--text-main); display: flex; flex-direction: column; gap: 16px; width: 100%; height: 100%; min-height: 0;">
        <div style="border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 12px; flex-shrink: 0;">
          <h3 style="margin: 0 0 6px 0; color: var(--syntax-yellow); font-size: 14px;">${escapeHtml(data.symbol.name)}</h3>
          <span style="background: color-mix(in srgb, var(--syntax-yellow) 10%, transparent); color: var(--syntax-yellow); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; text-transform: uppercase;">${escapeHtml(data.symbol.kind)}</span>
        </div>

        <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; align-items: center; flex-shrink: 0;">
          <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase; flex-shrink: 0;">File</span>
          <span class="involved-file-badge" role="button" tabindex="0" data-go-id="${escapeHtml(data.symbol.file_path)}" title="Click to view in Graph Explorer" style="margin: 0; word-break: break-all; text-align: right;">${escapeHtml(data.symbol.file_path)}</span>
        </div>

        <div style="display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; align-items: start; flex-shrink: 0;">
          <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Lines</span>
          <span style="text-align: right;">${escapeHtml(data.symbol.start_line)}-${escapeHtml(data.symbol.end_line)}</span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; flex-shrink: 0;">
          <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase;">Callers (${data.callers.length})</span>
          <ul style="padding-left: 16px; margin: 4px 0 0 0; list-style-type: square; color: var(--text-main);">
            ${data.callers.map((c: any) => {
      const name = c.source_symbol;
      if (name && name !== '<top-level>') {
        return `<li style="margin-bottom: 4px;"><a href="#" class="symbol-link" data-symbol="${escapeHtml(name)}" style="color: var(--syntax-blue); text-decoration: none; font-weight: 500;">${escapeHtml(name)}</a> <span style="color: var(--text-muted); font-size: 11px;">in ${escapeHtml(c.source_file)}</span></li>`;
      }
      return `<li style="margin-bottom: 4px; color: var(--text-muted);"><span style="color: var(--text-muted);">&lt;top-level&gt;</span> in ${escapeHtml(c.source_file)}</li>`;
    }).join('') || '<li style="color: var(--text-muted); list-style-type: none; margin-left: -16px;">None</li>'}
          </ul>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid color-mix(in srgb, var(--overlay) 8%, transparent); padding-bottom: 8px; flex-shrink: 0;">
          <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase;">Callees (${data.callees.length})</span>
          <ul style="padding-left: 16px; margin: 4px 0 0 0; list-style-type: square; color: var(--text-main);">
            ${data.callees.map((c: any) => {
      const name = c.target_symbol;
      if (name) {
        return `<li style="margin-bottom: 4px;"><a href="#" class="symbol-link" data-symbol="${escapeHtml(name)}" style="color: var(--syntax-blue); text-decoration: none; font-weight: 500;">${escapeHtml(name)}</a> <span style="color: var(--text-muted); font-size: 11px;">in ${escapeHtml(c.target_file)}</span></li>`;
      }
      return `<li style="margin-bottom: 4px; color: var(--text-muted);">in ${escapeHtml(c.target_file)}</li>`;
    }).join('') || '<li style="color: var(--text-muted); list-style-type: none; margin-left: -16px;">None</li>'}
          </ul>
        </div>

        ${data.sourceCode ? `
          <div style="display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0;">
            <span style="color: var(--text-muted); font-weight: bold; text-transform: uppercase; flex-shrink: 0;">Source Code</span>
            <pre class="neat-scrollbar" tabindex="0" role="region" aria-label="Source code" style="background: var(--bg-panel); color: var(--text-main); padding: 12px; border-radius: 6px; overflow: auto; font-family: inherit; font-size: 11px; margin: 4px 0 0 0; border: 1px solid color-mix(in srgb, var(--overlay) 5%, transparent); line-height: 1.5; flex: 1; min-height: 0;">${escapeHtml(data.sourceCode)}</pre>
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
  const gen = repoGeneration;
  try {
    const res = await fetch(withRepo('/api/routes', 'any'));
    if (!res.ok) return;
    const data = await res.json();
    if (gen !== repoGeneration) return; // a newer repo choice is loading

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
          const methodColor = getRouteMethodColor(r.method);
          tr.innerHTML = `
            <td class="col-optional"><strong>${escapeHtml(r.framework)}</strong></td>
            <td><span class="method-badge" style="--badge: ${methodColor};">${escapeHtml(r.method)}</span></td>
            <td><code>${escapeHtml(r.path)}</code></td>
            <td style="color:var(--syntax-blue);">${escapeHtml(r.handlerSymbol || r.handlerFile)}</td>
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
          const hookColor = getHookTypeColor(h.hookType);
          tr.innerHTML = `
            <td class="col-optional"><strong>${escapeHtml(h.framework)}</strong></td>
            <td><span class="hook-badge" style="--badge: ${hookColor};">${escapeHtml(h.hookType)}</span></td>
            <td><code>${escapeHtml(h.hookName)}</code></td>
            <td style="color:var(--syntax-blue);">${escapeHtml(h.handlerSymbol || h.handlerFile)}</td>
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
/** Display names of MapX's language ids (the metrics breakdown and the language filter). */
const LANGUAGE_NAMES: Record<string, string> = {
  php: 'PHP', typescript: 'TypeScript', javascript: 'JavaScript', tsx: 'TSX', jsx: 'JSX', json: 'JSON',
  css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', vue: 'Vue', svelte: 'Svelte', python: 'Python',
  go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', scala: 'Scala', swift: 'Swift', ruby: 'Ruby',
  c: 'C', cpp: 'C++', c_sharp: 'C#', csharp: 'C#', dart: 'Dart', lua: 'Lua', bash: 'Bash', shell: 'Shell',
  yaml: 'YAML', toml: 'TOML', xml: 'XML', markdown: 'Markdown', sql: 'SQL', blade: 'Blade', twig: 'Twig',
  elixir: 'Elixir', haskell: 'Haskell', ocaml: 'OCaml', zig: 'Zig', dockerfile: 'Dockerfile', graphql: 'GraphQL',
};
function languageName(id: string): string {
  return LANGUAGE_NAMES[id.toLowerCase()] ?? (id ? id[0]!.toUpperCase() + id.slice(1) : id);
}

/** A breakdown as horizontal bars, longest first as given (M4-17). */
function barList(rows: Array<[string, number]>, unit: string, color = 'var(--accent)'): string {
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return `<ul class="bar-list" style="--bar: ${color};">${rows.map(([label, n]) => `
    <li class="bar-row" title="${escapeHtml(label)}: ${n} ${unit}">
      <span class="bar-label">${escapeHtml(label)}</span>
      <span class="bar-track" aria-hidden="true"><span class="bar-fill" style="width: ${Math.max(2, Math.round((n / max) * 100))}%;"></span></span>
      <span class="bar-value">${n.toLocaleString()}</span>
    </li>`).join('')}</ul>`;
}

/** A row of labelled figures. */
function statTiles(tiles: Array<[string, string | number]>): string {
  return `<div class="stat-grid">${tiles.map(([label, value]) => `
    <div class="stat-tile"><div class="stat-tile-label">${escapeHtml(label)}</div><div class="stat-tile-value">${escapeHtml(typeof value === 'number' ? value.toLocaleString() : String(value))}</div></div>`).join('')}</div>`;
}

async function loadMetrics() {
  const gen = repoGeneration;
  try {
    const res = await fetch(withRepo('/api/metrics', 'single'));
    if (!res.ok) return;
    const metrics = await res.json();
    if (gen !== repoGeneration) return; // a newer repo choice is loading

    const summary = document.getElementById('metrics-summary');
    if (summary) {
      summary.innerHTML = statTiles([
        ['Files', metrics.totalFiles || 0],
        ['Symbols', metrics.totalSymbols || 0],
        ['Edges', metrics.totalEdges || 0],
        ['Density', metrics.density || '0%'],
        ['Transitivity', metrics.transitivity || 0],
      ]);
    }

    const languagesDiv = document.getElementById('metrics-languages');
    if (languagesDiv && metrics.languages) {
      const langs = Object.entries(metrics.languages as Record<string, number>).sort((x, y) => y[1] - x[1]);
      languagesDiv.innerHTML = langs.length > 0
        ? barList(langs.map(([lang, cnt]) => [languageName(lang), cnt]), 'files')
        : '<div style="color: var(--text-muted);">No language files found.</div>';
    }

    const kindsDiv = document.getElementById('metrics-kinds');
    if (kindsDiv && metrics.symbolKinds) {
      kindsDiv.innerHTML = metrics.symbolKinds.length > 0
        ? barList(metrics.symbolKinds.map((row: any) => [row.kind, row.cnt]), 'symbols', 'var(--syntax-purple)')
        : '<div style="color: var(--text-muted);">No symbols found.</div>';
    }

    const edgesDiv = document.getElementById('metrics-edges');
    if (edgesDiv) {
      const types = metrics.edgeTypes && metrics.edgeTypes.length > 0
        ? barList(metrics.edgeTypes.map((row: any) => [row.edge_type, row.cnt]), 'edges', 'var(--syntax-green)')
        : '<div style="color: var(--text-muted);">No edges.</div>';
      edgesDiv.innerHTML = `
        ${statTiles([
          ['Avg edges / file', metrics.avgEdgesPerFile || 0],
          ['Verified', metrics.verifiedEdges || 0],
          ['Inferred', metrics.inferredEdges || 0],
        ])}
        <div style="margin-top: var(--space-4);">${types}</div>
      `;
    }

    const gitStorageDiv = document.getElementById('metrics-git-storage');
    if (gitStorageDiv) {
      const dbSizeKB = metrics.dbSize != null ? (metrics.dbSize / 1024).toFixed(1) : '0';
      const git = metrics.git || {};

      let gitStatusHTML = '';
      if (!git.isGit) {
        gitStatusHTML = '<div><strong>Git Repository:</strong> No git repository detected</div>';
      } else if (git.changesCount === 0) {
        gitStatusHTML = '<div><strong>Git Status:</strong> ✓ Index up-to-date (no changes since last scan)</div>';
      } else {
        const changesList = git.changes.map((c: any) => `
          <li><span style="font-family: var(--font-mono);">[${escapeHtml(c.status)}]</span> ${escapeHtml(c.path)}</li>
        `).join('');
        gitStatusHTML = `
          <div>
            <strong>Git Status:</strong> ⚠ Stale (${escapeHtml(git.changesCount)} changed files since last scan)
            <ul tabindex="0" aria-label="Changed files" style="padding-left: 20px; margin-top: 5px; max-height: 100px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
              ${changesList}
            </ul>
          </div>
        `;
      }

      gitStorageDiv.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div><strong>Database Size:</strong> ${escapeHtml(dbSizeKB)} KB</div>
          ${gitStatusHTML}
        </div>
      `;
    }

    const topFilesList = document.getElementById('top-files-list');
    if (topFilesList) {
      if (metrics.topFiles && metrics.topFiles.length > 0) {
        topFilesList.innerHTML = metrics.topFiles.map((f: any) => `
          <li><code>${escapeHtml(f.path)}</code> <span style="color: var(--text-muted);">${(f.pagerank || 0).toFixed(4)}</span></li>
        `).join('');
      } else {
        topFilesList.innerHTML = '<li style="color: var(--text-muted); list-style-type: none;">No files available in metrics</li>';
      }
    }

    const topSymbolsList = document.getElementById('top-symbols-list');
    if (topSymbolsList) {
      if (metrics.topSymbols && metrics.topSymbols.length > 0) {
        topSymbolsList.innerHTML = metrics.topSymbols.map((s: any) => `
          <li><code>${escapeHtml(s.name)}</code> <span style="color: var(--text-muted);">${(s.pagerank || 0).toFixed(4)}</span></li>
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
        if (resultsDiv) resultsDiv.innerHTML = `<div class="details-placeholder" style="color:var(--danger);">Error: ${escapeHtml(errData.error)}</div>`;
        return;
      }
      const context = await res.json();
      if (resultsDiv) {
        resultsDiv.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:16px;">
            <h3>Context Analysis results</h3>
            <div><strong>Token Budget Used:</strong> ${escapeHtml(context.estimatedTokens || 0)} tokens</div>
            <div>
              <strong>Key Context Files:</strong>
              <ul style="padding-left:20px; margin-top:5px; display: flex; flex-direction: column; gap: 4px;">
                ${context.files && context.files.length > 0
            ? context.files.map((f: any) => `
                      <li>
                        <code>${escapeHtml(f.path || f)}</code> 
                        <span style="font-size: 0.85em; color: var(--text-muted); margin-left: 8px;">
                          (${escapeHtml(f.language || 'unknown')} • ${escapeHtml(f.lineCount || 0)} lines)
                        </span>
                      </li>
                    `).join('')
            : '<li style="color: var(--text-muted); list-style-type: none; margin-left: -20px;">None found</li>'
          }
              </ul>
            </div>
            <div>
              <strong>Relevant Entry Symbols:</strong>
              <ul style="padding-left:20px; margin-top:5px; display: flex; flex-direction: column; gap: 4px;">
                ${context.symbols && context.symbols.length > 0
            ? context.symbols.map((s: any) => `
                      <li>
                        <code>${escapeHtml(s.name || s)}</code> 
                        <span style="font-size: 0.85em; color: var(--text-muted); margin-left: 8px;">
                          (${escapeHtml(s.kind || 'unknown')} • <code>${escapeHtml(s.filePath || '')}</code>)
                        </span>
                      </li>
                    `).join('')
            : '<li style="color: var(--text-muted); list-style-type: none; margin-left: -20px;">None found</li>'
          }
              </ul>
            </div>
          </div>
        `;
      }
    } catch (err: any) {
      if (resultsDiv) resultsDiv.innerHTML = `<div class="details-placeholder" style="color:var(--danger);">Error: ${escapeHtml(err.message)}</div>`;
    }
  });
}

// Poll endpoints periodically to keep the UI up-to-date in near-real-time (fallback/sync)
function startPeriodicPolling() {
  setInterval(async () => {
    // 1. Poll tool calls (fetch newest page only for new entries)
    const logContainer = document.getElementById('tool-log-container');
    if (logContainer) {
      try {
        const res = await fetch(`/api/tool-calls?limit=${TOOL_LOG_PAGE_SIZE}&offset=0`);
        if (res.ok) {
          const { events } = await res.json();
          if (events && events.length > 0) {
            const placeholder = logContainer.querySelector('.log-placeholder');
            const reversedEvents = [...events].reverse();
            for (const data of reversedEvents) {
              const id = toolCallId(data);
              if (seenToolCallIds.has(id)) continue;
              seenToolCallIds.add(id);
              if (placeholder) placeholder.remove();
              logContainer.prepend(renderToolCallEntry(data));
            }
          }
        }
      } catch (err) {
        console.error('Failed to poll tool calls:', err);
      }
    }

    // 2. Poll workspace status
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const status = await res.json();
        const fileCount = status.fileCount || 0;
        const symbolCount = status.symbolCount || 0;
        const edgeCount = status.edgeCount || 0;

        if (fileCount !== lastFileCount || symbolCount !== lastSymbolCount || edgeCount !== lastEdgeCount) {
          lastFileCount = fileCount;
          lastSymbolCount = symbolCount;
          lastEdgeCount = edgeCount;

          document.getElementById('repo-name')!.textContent = status.repoName || 'MapX Project';
          document.getElementById('stat-files')!.textContent = String(fileCount);
          document.getElementById('stat-symbols')!.textContent = String(symbolCount);
          document.getElementById('stat-edges')!.textContent = String(edgeCount);
          loadRepos(); // counts changed: the repo list and the chosen repo's figures too

          const filterSelect = document.getElementById('filter-lang') as HTMLSelectElement;
          if (filterSelect && status.languages) {
            const currentVal = filterSelect.value;
            filterSelect.innerHTML = '<option value="">All Languages</option>';
            Object.keys(status.languages).forEach(lang => {
              const opt = document.createElement('option');
              opt.value = lang;
              opt.textContent = languageName(lang);
              filterSelect.appendChild(opt);
            });
            filterSelect.value = currentVal;
          }

          // Reload graph and Explorer components to reflect changes
          loadGraph();
          loadSymbols(symbolSearchQuery);
          loadRoutes();
          loadMetrics();
        }
      }
    } catch (err) {
      console.error('Failed to poll status:', err);
    }
  }, 2000);
}

// Initialise everything
document.addEventListener('DOMContentLoaded', () => {
  // The frame (M4-17): theme, navigation drawer, details panel.
  initTheme(() => { if (cyInstance) cyInstance.style(graphStyle()); });
  initNavDrawer();
  initDetailsPanel(
    () => {
      if (!cyInstance) return;
      cyInstance.batch(() => {
        cyInstance.elements().unselect();
        cyInstance.elements().removeClass('dimmed highlighted-center highlighted-outgoing highlighted-outgoing-node highlighted-incoming highlighted-incoming-node highlighted-parent-active highlighted-parent-outgoing highlighted-parent-incoming');
      });
    },
    () => setTimeout(() => cyInstance?.resize(), 0),
  );

  // Helper to programmatically switch tabs
  const switchTab = (tabName: string) => {
    const tabBtn = document.querySelector(`.nav-item[data-tab="${tabName}"]`) as HTMLElement;
    if (tabBtn) {
      tabBtn.click();
    }
  };

  // Test hook (M4-17): select a graph element as a tap would, so browser tests can open the
  // details panel without hitting canvas coordinates. Returns false when nothing matching is drawn.
  (window as any).__mapxSelect = (id?: string): boolean => {
    // Without an id: the first drawn file node.
    const el = id ? cyInstance?.getElementById(id) : cyInstance?.nodes('[type="file"]').first();
    if (!el || el.empty()) return false;
    el.emit('tap');
    return true;
  };

  // Test hook (M4-21): an edge's data flags and drawn style, by its endpoints.
  (window as any).__mapxEdge = (source: string, target: string) => {
    const edge = cyInstance?.edges().filter((e: any) => e.source().id() === source && e.target().id() === target)[0];
    return edge ? { type: edge.data('type'), crossRepo: !!edge.data('crossRepo'), lineStyle: edge.style('line-style'), color: edge.style('line-color') } : null;
  };

  // Test hook (M4-20 review): how many nodes and edges the graph draws.
  (window as any).__mapxStats = () => (cyInstance ? { nodes: cyInstance.nodes().length, edges: cyInstance.edges().length } : null);

  // Keyboard: Enter or Space on a file badge acts as a click (they are role="button" spans).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as HTMLElement | null)?.closest?.('[role="button"][data-go-id]') as HTMLElement | null;
    if (el) {
      e.preventDefault();
      el.click();
    }
  });

  // Global Click listener for Node/Edge navigation using [data-go-id]
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const clickable = target.closest('[data-go-id]');
    if (clickable && cyInstance) {
      e.preventDefault();
      const id = clickable.getAttribute('data-go-id');
      if (id) {
        const isOutsideGraph = currentTab !== 'graph';
        const isSmellBadge = clickable.classList.contains('involved-file-badge');

        if (isOutsideGraph) {
          switchTab('graph');
        }

        if (isSmellBadge) {
          // Switch to Focus Mode (Neighborhood)
          currentGraphMode = 'focus';
          const modeSelect = document.getElementById('select-graph-mode') as HTMLSelectElement;
          if (modeSelect) {
            modeSelect.value = 'focus';
          }

          // Set focus seed node to clicked file and depth to 1
          focusSeedNode = id;
          focusDepth = 1;

          // Sync the depth buttons UI so button '1' is active
          const depthButtons = document.querySelectorAll('.depth-btn');
          depthButtons.forEach(btn => {
            if (btn.getAttribute('data-depth') === '1') {
              btn.classList.add('active');
            } else {
              btn.classList.remove('active');
            }
          });

          updateToolbarVisibility('focus');
          updateGraphDisplay();
        }

        const focusOnNode = () => {
          const ele = cyInstance.getElementById(id);
          if (ele && ele.length > 0) {
            ele.trigger('tap');
            cyInstance.animate({
              center: { eles: ele }
            }, {
              duration: 350
            });
          }
        };

        if (isSmellBadge) {
          // If we run a layout (smell badge clicked), wait for layoutstop to ensure final coordinates are centered
          cyInstance.one('layoutstop', () => {
            setTimeout(focusOnNode, 50);
          });
        } else if (isOutsideGraph) {
          // Just wait for tab switch fade-in/resize to complete
          setTimeout(focusOnNode, 150);
        } else {
          // Immediate focus if we are already on graph tab and layout is stable
          focusOnNode();
        }
      }
    }
  });

  loadStatus();
  loadRepos();
  document.getElementById('select-repo')?.addEventListener('change', (e) => setRepo((e.target as HTMLSelectElement).value || null));
  for (const id of ['http-filter-method', 'http-filter-pair', 'http-filter-status']) document.getElementById(id)?.addEventListener('change', renderHttpTable);
  document.getElementById('table-http')?.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('[data-call]') as HTMLElement | null;
    if (!button) return;
    httpSelected = Number(button.dataset.call);
    renderHttpTable();
    renderHttpDetail();
    (document.querySelector(`#table-http [data-call="${httpSelected}"]`) as HTMLElement | null)?.focus();
  });
  const filterByFlowLink = (target: EventTarget | null) => {
    const link = (target as Element | null)?.closest?.('[data-pair]') as HTMLElement | null;
    const select = document.getElementById('http-filter-pair') as HTMLSelectElement | null;
    if (link && select) {
      select.value = link.dataset.pair ?? '';
      renderHttpTable();
    }
  };
  document.getElementById('http-flow')?.addEventListener('click', (e) => filterByFlowLink(e.target));
  document.getElementById('http-flow')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      filterByFlowLink(e.target);
    }
  });
  document.getElementById('table-repos')?.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('[data-repo]') as HTMLElement | null;
    if (button) setRepo(button.dataset.repo ?? null);
  });
  loadGraph();
  loadSymbols();
  loadRoutes();
  loadMetrics();
  loadToolCallHistory();
  setupSSE();
  setupContextBuilder();
  startPeriodicPolling();
  loadArchitecture();

  // Infinite scroll for Tool Call Log
  const toolLogSentinel = document.getElementById('tool-log-sentinel');
  const toolLogContainer = document.getElementById('tool-log-container');
  if (toolLogSentinel && toolLogContainer) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && toolLogOffset < toolLogTotal && !toolLogLoading) {
          loadToolCallHistory();
        }
      },
      { root: toolLogContainer, threshold: 0.1 }
    );
    observer.observe(toolLogSentinel);
  }

  // Search input listener for Symbol Explorer
  const symbolSearch = document.getElementById('symbol-search');
  symbolSearch?.addEventListener('input', (e) => {
    const query = (e.target as HTMLInputElement).value;
    // Reset to first page on new search
    symbolPage = 0;
    symbolSearchQuery = query;
    loadSymbols(query);
  });

  // Pagination button listeners for Symbol Explorer (top + bottom)
  for (const suffix of ['', '-top']) {
    document.getElementById(`symbol-page-prev${suffix}`)?.addEventListener('click', () => {
      if (symbolPage > 0) { symbolPage--; loadSymbols(symbolSearchQuery); }
    });
    document.getElementById(`symbol-page-next${suffix}`)?.addEventListener('click', () => {
      symbolPage++;
      loadSymbols(symbolSearchQuery);
    });
  }

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

  // Click delegation for selection details panel related items and actions
  const detailsContent = document.getElementById('details-content');
  detailsContent?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // 1. Remove Node action
    const removeNodeBtn = target.closest('.btn-action-remove-node');
    if (removeNodeBtn) {
      const nodeId = removeNodeBtn.getAttribute('data-node-id');
      if (nodeId) {
        removedNodes.add(nodeId);
        const resetBtn = document.getElementById('btn-reset-hidden');
        if (resetBtn) resetBtn.style.display = 'inline-flex';
        updateGraphDisplay();
        if (detailsContent) detailsContent.innerHTML = DETAILS_PLACEHOLDER;
      }
      return;
    }

    // 2. Remove Edge action
    const removeEdgeBtn = target.closest('.btn-action-remove-edge');
    if (removeEdgeBtn) {
      const edgeId = removeEdgeBtn.getAttribute('data-edge-id');
      if (edgeId) {
        removedEdges.add(edgeId);
        const resetBtn = document.getElementById('btn-reset-hidden');
        if (resetBtn) resetBtn.style.display = 'inline-flex';
        updateGraphDisplay();
        if (detailsContent) detailsContent.innerHTML = DETAILS_PLACEHOLDER;
      }
      return;
    }

    // 3. Add Custom Tag action
    const addTagBtn = target.closest('#btn-add-tag');
    if (addTagBtn) {
      const input = document.getElementById('input-new-tag') as HTMLInputElement;
      const tagVal = input?.value.trim();
      if (tagVal) {
        // Find selected node in cyInstance
        const selectedNode = cyInstance.$('node:selected');
        if (selectedNode && selectedNode.length > 0) {
          const nodeId = selectedNode.id();
          const tags = customTags.get(nodeId) || [];
          if (!tags.includes(tagVal)) {
            tags.push(tagVal);
            customTags.set(nodeId, tags);
            saveCustomTags();
          }
          // Clear the input
          if (input) input.value = '';
          // Re-trigger selection to update details panel HTML
          selectedNode.trigger('tap');

          // If current grouping strategy is custom, update graph display
          if (groupingStrategy === 'custom') {
            updateGraphDisplay();
          }
        }
      }
      return;
    }

    // 4. Remove Custom Tag action
    const removeTagBtn = target.closest('.tag-badge-remove');
    if (removeTagBtn) {
      const nodeId = removeTagBtn.getAttribute('data-node-id');
      const tagVal = removeTagBtn.getAttribute('data-tag');
      if (nodeId && tagVal) {
        const tags = customTags.get(nodeId) || [];
        const idx = tags.indexOf(tagVal);
        if (idx !== -1) {
          tags.splice(idx, 1);
          if (tags.length === 0) {
            customTags.delete(nodeId);
          } else {
            customTags.set(nodeId, tags);
          }
          saveCustomTags();
        }
        // Re-trigger selection to update details panel
        const selectedNode = cyInstance?.getElementById(nodeId);
        if (selectedNode && selectedNode.length > 0) {
          selectedNode.trigger('tap');
        }
        if (groupingStrategy === 'custom') {
          updateGraphDisplay();
        }
      }
      return;
    }

    // 5. Removed local Navigation handler since global click listener handles [data-go-id] globally
  });

  // Load custom tags from localStorage
  loadCustomTags();

  // Reset hidden files/edges button
  document.getElementById('btn-reset-hidden')?.addEventListener('click', () => {
    removedNodes.clear();
    removedEdges.clear();
    const resetBtn = document.getElementById('btn-reset-hidden');
    if (resetBtn) resetBtn.style.display = 'none';
    updateGraphDisplay();
  });

  // Reset All button — restore all toolbar state to defaults
  document.getElementById('btn-reset-all')?.addEventListener('click', () => {
    // Reset mode
    currentGraphMode = 'proximity';
    const modeSelect = document.getElementById('select-graph-mode') as HTMLSelectElement;
    if (modeSelect) modeSelect.value = 'proximity';

    // Reset layout
    activeLayoutName = 'fcose';
    const layoutSelect = document.getElementById('select-layout') as HTMLSelectElement;
    if (layoutSelect) layoutSelect.value = 'fcose';

    // Reset grouping
    groupingStrategy = 'layer';
    groupingChosen = false;
    const groupingSelect = document.getElementById('select-grouping-strategy') as HTMLSelectElement;
    if (groupingSelect) groupingSelect.value = 'layer';
    adaptGrouping();

    // Reset language filter
    const langFilter = document.getElementById('filter-lang') as HTMLSelectElement;
    if (langFilter) langFilter.value = '';

    // Reset focus state
    focusSeedNode = null;
    focusDepth = 1;
    const focusInput = document.getElementById('focus-search-input') as HTMLInputElement;
    if (focusInput) focusInput.value = '';
    const depthBtns = document.querySelectorAll('.depth-btn');
    depthBtns.forEach(b => b.classList.remove('active'));
    if (depthBtns[0]) depthBtns[0].classList.add('active');

    // Reset clusters
    showClusters = false;
    activeClusterId = null;

    // Reset hidden nodes/edges
    removedNodes.clear();
    removedEdges.clear();
    const resetHiddenBtn = document.getElementById('btn-reset-hidden');
    if (resetHiddenBtn) resetHiddenBtn.style.display = 'none';

    // Update toolbar visibility and graph
    const focusPanel = document.getElementById('focus-search-container');
    if (focusPanel) focusPanel.style.display = 'none';
    const groupingEl = document.getElementById('select-grouping-strategy') as HTMLSelectElement;
    if (groupingEl) groupingEl.disabled = false;
    const clustersBtn = document.getElementById('btn-toggle-clusters') as HTMLButtonElement;
    if (clustersBtn) clustersBtn.disabled = true;
    const breadcrumb = document.getElementById('cluster-breadcrumb');
    if (breadcrumb) breadcrumb.style.display = 'none';
    updateToolbarVisibility(currentGraphMode);

    updateGraphDisplay();
  });
});

// Architecture Tab Data Fetching and Rendering
const cycleEdges = new Set<string>();
const hubNodes = new Set<string>();

// ---- HTTP calls between repos (M4-23) ----
let httpData: { total: number; matched: number; pairs: any[]; unmatched: any[] } | null = null;
let httpCalls: any[] = [];
let httpSelected = -1;
/** The pair key of unmatched calls: printable, since NUL in an attribute becomes U+FFFD (review 2026-11-02). */
const NO_ROUTE = '(no route)';

/** A number for markup: whatever it is given, the result is digits (M4-23, the escaping check). */
function num(value: unknown): string {
  return String(Number(value));
}

function httpPairKey(call: any): string {
  return `${call.callerRepo}→${call.route ? call.handlerRepo : NO_ROUTE}`;
}

/** The repo-to-repo flow: callers on the left, handler repos (and "No route") on the right. */
function renderHttpFlow() {
  const el = document.getElementById('http-flow');
  if (!el || !httpData) return;
  const links = [
    ...httpData.pairs.map((p) => ({ from: p.from, to: p.to, count: p.count, unmatched: false })),
    ...httpData.unmatched.map((u) => ({ from: u.repo, to: NO_ROUTE, count: u.count, unmatched: true })),
  ];
  if (!links.length) {
    el.innerHTML = '<div class="details-placeholder" style="margin-top: 0;">No frontend HTTP calls found.</div>';
    return;
  }
  const left = [...new Set(links.map((l) => l.from))];
  const right = [...new Set(links.map((l) => l.to))].sort((a, b) => (a === NO_ROUTE ? 1 : b === NO_ROUTE ? -1 : a.localeCompare(b)));
  const rowH = 64;
  const h = Math.max(left.length, right.length) * rowH + 16;
  const W = 640;
  const boxW = 170;
  const y = (i: number, n: number) => 8 + (h - 16) * (i + 0.5) / n;
  const max = Math.max(...links.map((l) => l.count));
  const name = (r: string) => (r === NO_ROUTE ? 'No route' : r);
  const boxHtml = (r: string, x: number, cy: number, side: string) => `
    <g class="flow-node${r === NO_ROUTE ? ' is-none' : ''}" transform="translate(${num(x)}, ${cy - 18})">
      <rect width="${num(boxW)}" height="36" rx="8"></rect>
      <text x="${boxW / 2}" y="23" text-anchor="middle">${escapeHtml(name(r).length > 22 ? name(r).slice(0, 21) + '…' : name(r))}</text>
      <title>${escapeHtml(`${side}: ${name(r)}`)}</title>
    </g>`;
  const pathsHtml = links.map((l) => {
    const y1 = y(left.indexOf(l.from), left.length);
    const y2 = y(right.indexOf(l.to), right.length);
    const x1 = boxW + 8;
    const x2 = W - boxW - 8;
    const width = 2 + Math.round((l.count / max) * 14);
    const mid = (x1 + x2) / 2;
    return `<g class="flow-link${l.unmatched ? ' is-none' : ''}" data-pair="${escapeHtml(`${l.from}→${l.to}`)}" tabindex="0" role="button" aria-label="${escapeHtml(`Show the calls from ${name(l.from)} to ${name(l.to)}: ${l.count}`)}">
      <path d="M${num(x1)},${num(y1)} C${num(mid)},${num(y1)} ${num(mid)},${num(y2)} ${num(x2)},${num(y2)}" stroke-width="${num(width)}"></path>
      <text x="${num(mid)}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle">${escapeHtml(l.count)}</text>
      <title>${escapeHtml(`${name(l.from)} → ${name(l.to)}: ${l.count} call${l.count === 1 ? '' : 's'}`)}</title>
    </g>`;
  }).join('');
  const summary = links.map((l) => `${name(l.from)} to ${name(l.to)}: ${l.count}`).join('; ');
  el.innerHTML = `<svg viewBox="0 0 ${num(W)} ${num(h)}" role="group" aria-label="${escapeHtml(`HTTP calls between repos. ${summary}`)}" preserveAspectRatio="xMidYMid meet">
    ${pathsHtml}
    ${left.map((r, i) => boxHtml(r, 0, y(i, left.length), 'Calling repo')).join('')}
    ${right.map((r, i) => boxHtml(r, W - boxW, y(i, right.length), 'Serving repo')).join('')}
  </svg>`;
}

function renderHttpTable() {
  const method = (document.getElementById('http-filter-method') as HTMLSelectElement | null)?.value ?? '';
  const pair = (document.getElementById('http-filter-pair') as HTMLSelectElement | null)?.value ?? '';
  const status = (document.getElementById('http-filter-status') as HTMLSelectElement | null)?.value ?? '';
  const rows = httpCalls.map((c, i) => ({ c, i })).filter(({ c }) =>
    (!method || c.method.toUpperCase() === method) &&
    (!pair || httpPairKey(c) === pair) &&
    (!status || (status === 'matched' ? !!c.route : !c.route)));
  const tbody = document.querySelector('#table-http tbody');
  if (tbody) {
    tbody.innerHTML = rows.length ? rows.map(({ c, i }) => `
      <tr class="${i === httpSelected ? 'selected-symbol-row' : ''}">
        <td><button type="button" class="link-btn" data-call="${escapeHtml(i)}"><span class="method-badge" style="--badge: ${escapeHtml(getRouteMethodColor(c.method.toUpperCase()))};">${escapeHtml(c.method.toUpperCase())}</span> <code>${escapeHtml(c.url ?? c.rawUrl)}</code></button></td>
        <td class="col-optional"><code>${escapeHtml(c.file)}:${escapeHtml(c.line)}</code></td>
        <td>${c.route ? `<code>${escapeHtml(c.route.handlerSymbol ?? c.route.handlerFile)}</code>` : '<span class="selection-badge" style="--badge: var(--danger);">no route</span>'}</td>
      </tr>`).join('') : '<tr><td colspan="3" class="config-empty">No calls match the filters.</td></tr>';
  }
  const count = document.getElementById('http-count');
  if (count) count.textContent = `${rows.length} of ${httpCalls.length} calls`;
}

function renderHttpDetail() {
  const el = document.getElementById('http-detail');
  const c = httpCalls[httpSelected];
  if (!el) return;
  if (!c) {
    el.innerHTML = '<div class="details-placeholder">Select a call to see both ends.</div>';
    return;
  }
  el.innerHTML = `
    <h3 class="section-title" style="margin-top: 0;">${escapeHtml(c.method.toUpperCase())} <code>${escapeHtml(c.url ?? c.rawUrl)}</code></h3>
    <div class="http-end">
      <div class="detail-stat-label">Caller, in ${escapeHtml(c.callerRepo)}</div>
      <div><span class="involved-file-badge" role="button" tabindex="0" data-go-id="${escapeHtml(c.file)}" title="Show in the graph">${escapeHtml(c.file)}:${escapeHtml(c.line)}</span></div>
      ${c.callerCode ? `<pre class="config-json">${escapeHtml(c.callerCode)}</pre>` : ''}
      <div class="config-desc">${escapeHtml(c.client?.kind ?? '')} client <code>${escapeHtml(c.client?.name ?? '')}</code></div>
    </div>
    <div class="http-end">
      <div class="detail-stat-label">${c.route ? `Handler, in ${escapeHtml(c.handlerRepo)}` : 'Handler'}</div>
      ${c.route ? `
        <div><code>${escapeHtml(c.route.method)} ${escapeHtml(c.route.path)}</code> <span class="profile-pill">${escapeHtml(c.route.confidence)}</span></div>
        <div><code>${escapeHtml(c.route.handlerSymbol ?? '')}</code></div>
        <div><span class="involved-file-badge" role="button" tabindex="0" data-go-id="${escapeHtml(c.route.handlerFile)}" title="Show in the graph">${escapeHtml(c.route.handlerFile)}${c.handlerLine ? `:${escapeHtml(c.handlerLine)}` : ''}</span></div>`
        : '<div class="config-empty">No live route serves this call.</div>'}
    </div>`;
}

async function loadHttp() {
  const gen = repoGeneration;
  try {
    const res = await fetch(withRepo('/api/http', 'any'));
    if (!res.ok) return;
    httpData = await res.json();
    if (gen !== repoGeneration) return; // a newer repo choice is loading
    httpCalls = [...httpData!.pairs.flatMap((p) => p.calls), ...httpData!.unmatched.flatMap((u) => u.calls)];
    httpSelected = -1;
    const summary = document.getElementById('http-summary');
    if (summary) summary.innerHTML = statTiles([
      ['Calls', httpData!.total],
      ['Matched', httpData!.matched],
      ['Unmatched', httpData!.total - httpData!.matched],
      ['Repo pairs', httpData!.pairs.length],
    ]);
    const methodSelect = document.getElementById('http-filter-method') as HTMLSelectElement | null;
    if (methodSelect) {
      const methods = [...new Set(httpCalls.map((c) => c.method.toUpperCase()))].sort();
      methodSelect.innerHTML = '<option value="">All</option>' + methods.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    }
    const pairSelect = document.getElementById('http-filter-pair') as HTMLSelectElement | null;
    if (pairSelect) {
      const pairs = [
        ...httpData!.pairs.map((p) => [`${p.from}→${p.to}`, `${p.from} → ${p.to} (${p.count})`]),
        ...httpData!.unmatched.map((u) => [`${u.repo}→${NO_ROUTE}`, `${u.repo} → no route (${u.count})`]),
      ];
      pairSelect.innerHTML = '<option value="">All</option>' + pairs.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
    }
    renderHttpFlow();
    renderHttpTable();
    renderHttpDetail();
  } catch (err) {
    console.error('Failed to load HTTP calls:', err);
  }
}

// ---- Configuration (M4-22): read-only ----
const SOURCE_BADGE: Record<string, string> = { default: 'var(--text-muted)', user: 'var(--syntax-blue)', env: 'var(--syntax-purple)' };

function configValueHtml(setting: any): string {
  if (Array.isArray(setting.entries)) {
    if (!setting.entries.length) return '<span class="config-empty">none</span>';
    const user = setting.entries.filter((e: any) => e.source === 'user');
    const chips = (list: any[]) => list.map((e: any) => `<code class="config-chip${e.source === 'user' ? ' is-user' : ''}">${escapeHtml(e.value)}</code>`).join('');
    // The user's own patterns stay visible; MapX's built-in ones fold away.
    const builtIn = setting.entries.filter((e: any) => e.source === 'default');
    return `${user.length ? `<div class="config-chips">${chips(user)}</div>` : ''}${builtIn.length ? `<details class="config-details"><summary>${escapeHtml(builtIn.length)} built-in pattern${builtIn.length === 1 ? '' : 's'}</summary><div class="config-chips">${chips(builtIn)}</div></details>` : ''}`;
  }
  const value = setting.value;
  if (value !== null && typeof value === 'object') {
    const text = JSON.stringify(value, null, 2);
    return text === '{}' ? '<span class="config-empty">none</span>' : `<pre class="config-json">${escapeHtml(text)}</pre>`;
  }
  return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
}

async function loadConfigView() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const config = await res.json();
    const path = document.getElementById('config-path');
    if (path) path.innerHTML = `Edit <code>${escapeHtml(config.path)}</code> to change them.`;
    const warnings = document.getElementById('config-warnings');
    if (warnings) {
      warnings.innerHTML = config.warnings.length
        ? `<div class="config-warnings" role="status"><strong>${escapeHtml(config.warnings.length)} warning${config.warnings.length === 1 ? '' : 's'}</strong><ul>${config.warnings.map((w: string) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
        : '<p class="config-ok">No problems found in the configuration.</p>';
    }
    const tbody = document.querySelector('#table-config tbody');
    if (tbody) {
      tbody.innerHTML = config.settings.map((s: any) => `
        <tr data-setting="${escapeHtml(s.key)}">
          <td><code>${escapeHtml(s.key)}</code><div class="config-desc">${escapeHtml(s.description)}</div></td>
          <td>${configValueHtml(s)}</td>
          <td><span class="selection-badge" style="--badge: ${escapeHtml(SOURCE_BADGE[s.source] ?? 'var(--text-muted)')};">${escapeHtml(s.source)}</span></td>
        </tr>`).join('');
    }
    const repos = document.querySelector('#table-config-repos tbody');
    if (repos) {
      repos.innerHTML = config.repos.map((r: any) => `
        <tr><td>${escapeHtml(r.name)}${r.primary ? ' <span class="selection-badge" style="--badge: var(--syntax-blue);">primary</span>' : ''}</td>
        <td><code>${escapeHtml(r.path)}</code>${r.exists ? '' : ' <span class="selection-badge" style="--badge: var(--danger);">missing</span>'}</td>
        <td class="col-optional">${escapeHtml(r.framework ?? '')}</td></tr>`).join('');
    }
    const languages = document.getElementById('config-languages');
    if (languages) {
      languages.innerHTML = config.languages.length
        ? `<ul class="config-languages">${config.languages.map((l: any) => `<li><strong>${escapeHtml(l.name)}</strong> <span class="config-desc">${escapeHtml(l.extensions.join(', ') || 'no extensions')} · ${escapeHtml(l.grammarWasm || 'no grammar')}</span></li>`).join('')}</ul>`
        : '<p class="config-empty">None. Built-in languages need no configuration; add others with <code>mapx lang install</code>.</p>';
    }
  } catch (err) {
    console.error('Failed to load the configuration:', err);
  }
}

let architectureLoaded = false;

async function loadArchitecture() {
  const gen = repoGeneration;
  architectureLoaded = true;
  try {
    // 1. Fetch smells to populate annotations before drawing/re-drawing the graph
    await loadSmells();
    
    // 2. Fetch profile
    const profileRes = await fetch(withRepo('/api/profile', 'single'));
    const profileData = profileRes.ok ? await profileRes.json() : null;
    if (gen !== repoGeneration) return; // a newer repo choice is loading
    renderProfile(profileData?.profile);

    // 3. Fetch DSM
    const dsmRes = await fetch(withRepo('/api/dsm', 'single'));
    const dsmData = dsmRes.ok ? await dsmRes.json() : null;
    if (gen !== repoGeneration) return; // a newer repo choice is loading
    renderDSM(dsmData);
  } catch (err) {
    console.error('Failed to load architecture data:', err);
  }
}

async function loadSmells() {
  const gen = repoGeneration;
  try {
    const res = await fetch(withRepo('/api/smells', 'set'));
    if (!res.ok) return;
    const data = await res.json();
    if (gen !== repoGeneration) return; // a newer repo choice is loading
    
    cycleEdges.clear();
    hubNodes.clear();
    
    const smellsListEl = document.getElementById('arch-smells-list');
    if (!smellsListEl) return;
    
    const smells = data.smells || [];
    rawSmellsData = smells;
    if (smells.length === 0) {
      smellsListEl.innerHTML = '<div class="details-placeholder">No architectural smells detected! Your system health is excellent.</div>';
      
      const badge = document.getElementById('arch-health-badge');
      const score = document.getElementById('arch-health-score');
      if (badge) {
        badge.textContent = 'A+';
        badge.style.color = 'var(--syntax-green)';
      }
      if (score) score.textContent = '100%';

      // Update SVG gauge ring
      const ring = document.getElementById('arch-health-ring');
      if (ring) {
        ring.style.strokeDashoffset = '0';
        ring.style.stroke = 'var(--syntax-green)';
      }
      return;
    }
    
    let criticalCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    
    let html = '';
    for (const smell of smells) {
      const severity = (smell.severity || 'warning').toLowerCase();
      if (severity === 'critical') criticalCount++;
      else if (severity === 'warning') warningCount++;
      else infoCount++;
      
      let involvedFilesStr = '';
      if (smell.involved_files) {
        try {
          const files = Array.isArray(smell.involved_files)
            ? smell.involved_files
            : (typeof smell.involved_files === 'string' ? JSON.parse(smell.involved_files) : []);
          if (Array.isArray(files) && files.length > 0) {
            involvedFilesStr = files.map((f: string) => {
              const name = f.split('/').pop() || f;
              return `<span class="involved-file-badge" role="button" tabindex="0" data-go-id="${escapeHtml(f)}" title="Click to view in Graph Explorer">${escapeHtml(name)}</span>`;
            }).join('');
          }
        } catch (e) {
          const fallbackName = typeof smell.involved_files === 'string' ? smell.involved_files.split('/').pop() : 'file';
          involvedFilesStr = `<span class="involved-file-badge" role="button" tabindex="0" data-go-id="${escapeHtml(smell.involved_files)}" title="Click to view in Graph Explorer">${escapeHtml(fallbackName)}</span>`;
        }
      }
      
      html += `
        <div class="smell-item-card severity-${escapeHtml(severity)}">
          <div class="smell-header">
            <span class="smell-badge ${escapeHtml(severity)}">${escapeHtml(severity)}</span>
            <span class="smell-title">${escapeHtml(smell.type.toUpperCase())} SMELL</span>
          </div>
          <div class="smell-desc">${escapeHtml(smell.description)}</div>
          ${smell.suggestion ? `<div class="smell-suggestion">💡 Suggestion: ${escapeHtml(smell.suggestion)}</div>` : ''}
          ${involvedFilesStr ? `<div class="smell-involved">📍 Involved: ${involvedFilesStr}</div>` : ''}
        </div>
      `;
    }
    
    smellsListEl.innerHTML = html;
    
    // Dynamically calculate health score: 100 - (critical * 15) - (warning * 5) - (info * 1)
    const rawScore = Math.max(30, 100 - (criticalCount * 15) - (warningCount * 5) - (infoCount * 1));
    const healthScore = Math.round(rawScore);
    
    let healthGrade = 'A';
    let healthColor = 'var(--syntax-green)';
    if (healthScore >= 95) { healthGrade = 'A+'; }
    else if (healthScore >= 90) { healthGrade = 'A'; }
    else if (healthScore >= 85) { healthGrade = 'A-'; healthColor = 'var(--syntax-green)'; }
    else if (healthScore >= 80) { healthGrade = 'B+'; healthColor = 'var(--syntax-yellow)'; }
    else if (healthScore >= 75) { healthGrade = 'B'; healthColor = 'var(--syntax-yellow)'; }
    else if (healthScore >= 70) { healthGrade = 'B-'; healthColor = 'var(--syntax-yellow)'; }
    else if (healthScore >= 60) { healthGrade = 'C'; healthColor = 'var(--syntax-orange)'; }
    else if (healthScore >= 50) { healthGrade = 'D'; healthColor = 'var(--syntax-red)'; }
    else { healthGrade = 'F'; healthColor = 'var(--danger)'; }
    
    const badge = document.getElementById('arch-health-badge');
    const score = document.getElementById('arch-health-score');
    if (badge) {
      badge.textContent = healthGrade;
      badge.style.color = healthColor;
    }
    if (score) {
      score.textContent = `${healthScore}%`;
    }

    // Update SVG gauge ring
    const ring = document.getElementById('arch-health-ring');
    if (ring) {
      const radius = 42;
      const circumference = 2 * Math.PI * radius; // 263.89
      const offset = circumference - (healthScore / 100) * circumference;
      ring.style.strokeDashoffset = String(offset);
      ring.style.stroke = healthColor;
    }
  } catch (err) {
    console.error('Failed to load smells:', err);
  }
}

function renderProfile(profile: any) {
  const container = document.getElementById('arch-profile-details');
  if (!container) return;
  
  if (!profile) {
    container.innerHTML = '<div class="details-placeholder">No codebase profile available. Scan the project to profile archetype.</div>';
    return;
  }
  
  const dominantLangs = profile.dominantLanguages || [];
  const frameworks = profile.detectedFrameworks || [];
  const patterns = profile.detectedPatterns || [];
  
  const renderPills = (items: string[]) => {
    if (!items || items.length === 0) return '<span class="profile-pill-empty">none</span>';
    return items.map(item => `<span class="profile-pill">${escapeHtml(item)}</span>`).join('');
  };

  const renderYesNo = (val: boolean) => {
    return val 
      ? '<span class="profile-pill-bool yes">Yes</span>' 
      : '<span class="profile-pill-bool no">No</span>';
  };

  const arch = profile.archetype || 'mixed';
  const conf = typeof profile.archetypeConfidence === 'number' ? profile.archetypeConfidence : 1.0;
  const archBadge = `<span class="profile-pill-arch archetype-${escapeHtml(arch)}">${escapeHtml(arch.toUpperCase())} <span style="opacity:0.6;font-size:9px;margin-left:4px;">${conf.toFixed(2)}</span></span>`;

  container.innerHTML = `
    <div class="profile-detail-item">
      <span class="profile-detail-label">Archetype</span>
      <span class="profile-detail-value">${archBadge}</span>
    </div>
    <div class="profile-detail-item">
      <span class="profile-detail-label">Dominant Languages</span>
      <span class="profile-detail-value">${renderPills(dominantLangs)}</span>
    </div>
    <div class="profile-detail-item">
      <span class="profile-detail-label">Detected Frameworks</span>
      <span class="profile-detail-value">${renderPills(frameworks)}</span>
    </div>
    <div class="profile-detail-item">
      <span class="profile-detail-label">Architecture Patterns</span>
      <span class="profile-detail-value">${renderPills(patterns)}</span>
    </div>
    <div class="profile-detail-item">
      <span class="profile-detail-label">Has Backend</span>
      <span class="profile-detail-value">${escapeHtml(renderYesNo(profile.hasBackend))}</span>
    </div>
    <div class="profile-detail-item">
      <span class="profile-detail-label">Has Frontend</span>
      <span class="profile-detail-value">${escapeHtml(renderYesNo(profile.hasFrontend))}</span>
    </div>
    <div class="profile-detail-item">
      <span class="profile-detail-label">Is Monorepo</span>
      <span class="profile-detail-value">${escapeHtml(renderYesNo(profile.isMonorepo))}</span>
    </div>
  `;
}

function renderDSM(dsm: any) {
  const container = document.getElementById('arch-dsm-matrix');
  if (!container) return;
  
  if (!dsm || !dsm.clusterNames || dsm.clusterNames.length === 0) {
    container.innerHTML = '<div class="details-placeholder">No clusters found to generate DSM matrix.</div>';
    return;
  }
  
  const names: string[] = dsm.clusterNames;
  const matrix: number[][] = dsm.matrix;
  const dominantTypes: string[][] = dsm.dominantTypes || [];
  
  let html = '<table class="dsm-table">';
  
  // Headers
  html += '<thead><tr><th><span class="visually-hidden">Depends on</span></th>';
  for (let j = 0; j < names.length; j++) {
    html += `<th title="${escapeHtml(names[j])}">C${j + 1}</th>`;
  }
  html += '</tr></thead><tbody>';
  
  // Rows
  for (let i = 0; i < names.length; i++) {
    html += `<tr><th class="dsm-row-hdr" title="${escapeHtml(names[i])}">C${i + 1}: ${escapeHtml(names[i])}</th>`;
    for (let j = 0; j < names.length; j++) {
      if (i === j) {
        html += `<td class="dsm-cell dsm-diagonal" title="${escapeHtml(names[i])} self-coupling">—</td>`;
      } else {
        const val = matrix[i][j] || 0;
        const domType = (dominantTypes[i] && dominantTypes[i][j]) || '';
        
        let bgStyle = '';
        let cellClass = 'dsm-cell';
        let textVal = '';
        
        if (val > 0) {
          textVal = String(val);
          // Stronger coupling, stronger tint; capped so the count stays readable in both themes.
          const pct = Math.round(Math.min(12 + val * 6, 45));
          bgStyle = `style="background-color: color-mix(in srgb, var(--syntax-blue) ${pct}%, transparent); color: var(--text-white); font-weight: bold;"`;
        } else {
          cellClass += ' dsm-empty';
          textVal = '0';
        }
        
        const cellTitle = `${names[i]} calls ${names[j]}: ${val} times${domType ? ` (dominant type: ${domType})` : ''}`;
        html += `<td class="${cellClass}" ${bgStyle} title="${escapeHtml(cellTitle)}" data-src="${escapeHtml(names[i])}" data-tgt="${escapeHtml(names[j])}" data-val="${val}" data-type="${escapeHtml(domType)}">${textVal}</td>`;
      }
    }
    html += '</tr>';
  }
  
  html += '</tbody></table>';
  container.innerHTML = html;
  
  // Cell click listener
  container.querySelectorAll('.dsm-cell:not(.dsm-diagonal)').forEach(cell => {
    cell.addEventListener('click', (e) => {
      const el = e.currentTarget as HTMLElement;
      const src = el.getAttribute('data-src') || '';
      const tgt = el.getAttribute('data-tgt') || '';
      const val = el.getAttribute('data-val') || '0';
      const domType = el.getAttribute('data-type') || '';
      
      const detailEl = document.getElementById('dsm-legend-detail');
      if (detailEl) {
        if (parseInt(val, 10) > 0) {
          detailEl.innerHTML = `<strong>${escapeHtml(src)}</strong> depends on <strong>${escapeHtml(tgt)}</strong> (weight: <strong>${val}</strong>, primary: <em>${escapeHtml(domType)}</em>)`;
        } else {
          detailEl.innerHTML = `No direct dependencies from <strong>${escapeHtml(src)}</strong> to <strong>${escapeHtml(tgt)}</strong>`;
        }
      }
    });
  });
}
