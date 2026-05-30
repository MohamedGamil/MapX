import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import fcose from 'cytoscape-fcose';
import cola from 'cytoscape-cola';
import elk from 'cytoscape-elk';

cytoscape.use(dagre);
cytoscape.use(fcose);
cytoscape.use(cola);
cytoscape.use(elk);

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

// Track seen tool call IDs to avoid duplicates from SSE + history
const seenToolCallIds = new Set<string>();

function toolCallId(data: any): string {
  return `${data.tool}:${data.timestamp}:${data.durationMs || 0}`;
}

function renderToolCallEntry(data: any): HTMLElement {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  
  const timeStr = new Date(data.timestamp || Date.now()).toLocaleTimeString();
  const durationStr = data.durationMs != null ? ` <span class="log-duration">${data.durationMs}ms</span>` : '';
  const statusIcon = data.success === false ? '❌' : '✅';
  
  entry.innerHTML = `
    <span class="log-time">[${timeStr}]</span>
    <span class="log-status">${statusIcon}</span>
    <span class="log-name">${data.tool}</span>
    <span class="log-input">(${JSON.stringify(data.input)})</span>${durationStr}
    ${data.error ? `<div class="log-result" style="color: #ef4444;">Error: ${data.error}</div>` : ''}
  `;
  return entry;
}

// Load historical tool calls from persistent log
async function loadToolCallHistory() {
  const logContainer = document.getElementById('tool-log-container');
  if (!logContainer) return;
  
  try {
    const res = await fetch('/api/tool-calls');
    if (!res.ok) return;
    const events = await res.json();
    
    if (events.length > 0) {
      const placeholder = logContainer.querySelector('.log-placeholder');
      if (placeholder) placeholder.remove();
      
      for (const data of events) {
        const id = toolCallId(data);
        if (seenToolCallIds.has(id)) continue;
        seenToolCallIds.add(id);
        logContainer.appendChild(renderToolCallEntry(data));
      }
    }
  } catch (err) {
    console.error('Failed to load tool call history:', err);
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
let activeClusterId: string | null = null;
let groupingStrategy: 'community' | 'directory' | 'language' | 'custom' = 'community';
const removedNodes = new Set<string>();
const removedEdges = new Set<string>();
const customTags = new Map<string, string[]>(); // node ID -> tags array

// Custom tags persistence via localStorage
function getTagsStorageKey(): string {
  const repoEl = document.getElementById('repo-name');
  const repoName = repoEl?.textContent || 'mapx';
  return `mapx-custom-tags:${repoName}`;
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
    case 'GET':     return '#10b981'; // emerald
    case 'POST':    return '#3b82f6'; // blue
    case 'PUT':     return '#f59e0b'; // amber
    case 'PATCH':   return '#14b8a6'; // teal
    case 'DELETE':  return '#ef4444'; // red
    case 'HEAD':    return '#6366f1'; // indigo
    case 'OPTIONS': return '#8b5cf6'; // violet
    case 'ANY':     return '#a855f7'; // purple
    case 'MATCH':   return '#ec4899'; // pink
    default:        return '#64748b'; // slate
  }
}

// Color mapping for hook type badges
function getHookTypeColor(hookType: string): string {
  const t = (hookType || '').toLowerCase();
  if (t.includes('middleware'))         return '#6366f1'; // indigo
  if (t.includes('event') || t.includes('listener')) return '#06b6d4'; // cyan
  if (t.includes('filter'))            return '#f59e0b'; // amber
  if (t.includes('action'))            return '#f43f5e'; // rose
  if (t.includes('lifecycle') || t.includes('init') || t.includes('boot') || t.includes('destroy')) return '#14b8a6'; // teal
  if (t.includes('service_provider') || t.includes('provider')) return '#8b5cf6'; // violet
  if (t.includes('guard'))             return '#ef4444'; // red
  if (t.includes('pipe'))              return '#22d3ee'; // cyan-light
  if (t.includes('interceptor'))       return '#a855f7'; // purple
  if (t.includes('resolver') || t.includes('query') || t.includes('mutation')) return '#3b82f6'; // blue
  if (t.includes('subscriber') || t.includes('subscription')) return '#ec4899'; // pink
  return '#64748b'; // slate fallback
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
        nodeRepulsion: () => 250000,
        idealEdgeLength: () => 180,
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
    case 'elk':
      return {
        name: 'elk',
        animate: baseAnimate,
        fit: true,
        padding: 50,
        nodeDimensionsIncludeLabels: true,
        elk: {
          algorithm: 'mrtree',
          'nodeDimensionsIncludeLabels': true,
          'elk.direction': 'DOWN',
          'spacing.nodeNode': 50,
          'spacing.edgeNode': 25,
          'spacing.nodeNodeBetweenLayers': 60,
          'layered.nodePlacement.strategy': 'BRANDES_KOEPF',
          'layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        },
      };
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
  try {
    const res = await fetch('/api/clusters');
    if (res.ok) {
      rawClustersData = await res.json();
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
  
  // Community map
  const communityMap = new Map<string, string>();
  if (rawClustersData && rawClustersData.memberships) {
    rawClustersData.memberships.forEach((m: any) => {
      communityMap.set(m.filePath, m.clusterName);
    });
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
      const comm = communityMap.get(fId) || 'community_unassigned';
      fileToCluster.set(fId, `cluster:${comm}`);
    } else if (groupingStrategy === 'directory') {
      const parts = fId.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
      fileToCluster.set(fId, `dir:${dir}`);
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
        const commObj = rawClustersData.clusters?.find(c => c.name === commId);
        label = `${commObj ? commObj.label : commId} (${cnt} files)`;
      } else if (clustId.startsWith('dir:')) {
        label = `${clustId.replace('dir:', '')} (${cnt} files)`;
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
          isSingulars: clustId === 'cluster:singulars'
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
}

function updateGraphDisplay() {
  if (!cyInstance) return;

  const newElements = buildGraphElementsForMode();

  cyInstance.batch(() => {
    cyInstance.elements().remove();
    cyInstance.add(newElements);
  });

  const elementCount = newElements.length;

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

  runLayout(layoutConfig);

  // Update layout dropdown UI
  const layoutSelect = document.getElementById('select-layout') as HTMLSelectElement;
  if (layoutSelect && layoutSelect.value !== activeLayoutName) {
    layoutSelect.value = activeLayoutName;
  }
}

function runLayout(layoutConfig: any) {
  if (activeLayout) {
    try {
      activeLayout.stop();
    } catch (e) {
      // Ignored
    }
  }

  const visibleCount = cyInstance.elements(':visible').length;
  if (visibleCount > 200) {
    layoutConfig = { ...layoutConfig, animate: false };
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

  if (visibleCount > 200) {
    activeLayout = cyInstance.layout(layoutConfig);
    activeLayout.run();
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

  activeLayout = cyInstance.layout(layoutConfig);
  activeLayout.run();
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

  const clustersBtn = document.getElementById('btn-toggle-clusters');
  if (clustersBtn) {
    // Clusters toggle only relevant in full and focus modes
    // (proximity has its own clustering, directory has its own)
    clustersBtn.style.display = (mode === 'full' || mode === 'focus') ? 'inline-flex' : 'none';
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
  try {
    const res = await fetch('/api/graph');
    if (!res.ok) { hideOverlay(); return; }
    rawGraphElements = await res.json();

    const container = document.getElementById('cy');
    if (!container) return;

    // Load clusters mapping for Proximity Clusters Mode
    await loadClusters();

    // Decide default mode based on file count and edge count.
    // Proximity (cluster) mode is far cheaper to render for large graphs.
    const fileCount = rawGraphElements.filter(el => el.data && !el.data.source && !el.data.target && el.data.type === 'file').length;
    const edgeCount = rawGraphElements.filter(el => el.data && el.data.source && el.data.target).length;
    if (fileCount > 200 || edgeCount > 500) {
      currentGraphMode = 'proximity';
      const modeSelect = document.getElementById('select-graph-mode') as HTMLSelectElement;
      if (modeSelect) modeSelect.value = 'proximity';
    } else {
      currentGraphMode = 'full';
      const modeSelect = document.getElementById('select-graph-mode') as HTMLSelectElement;
      if (modeSelect) modeSelect.value = 'full';
    }

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
            'overlay-color': '#61afef',
            'overlay-opacity': 0.08,
            'text-outline-color': '#1e222b',
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
            'z-index': 1,
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
        },
        {
          selector: 'node[type="parent-folder"]',
          style: {
            'shape': 'round-rectangle',
            'background-color': '#2d3139',
            'border-width': '2px',
            'border-color': '#61afef',
            'width': '60px',
            'height': '40px',
            'font-size': '10px',
            'font-weight': 'bold',
            'color': '#abb2bf',
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
            'line-color': 'rgba(97, 175, 239, 0.45)',
            'target-arrow-color': 'rgba(97, 175, 239, 0.45)',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'label': 'data(label)',
            'color': '#abb2bf',
            'font-family': 'Outfit, sans-serif',
            'font-size': '9px',
            'font-weight': 'bold',
            'text-background-color': '#1e222b',
            'text-background-opacity': 1,
            'text-background-padding': '2px',
            'text-background-shape': 'roundrectangle'
          }
        },
        {
          selector: 'node[?isSeed]',
          style: {
            'background-color': '#98c379',
            'border-color': '#e5c07b',
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
            'background-color': '#1e222b',
            'background-opacity': 0.85,
            'border-width': '3px',
            'border-color': '#d19a66',
            'width': (node: any) => {
              const fileCount = node.data('fileCount') || 1;
              return (70 + Math.min(Math.log2(fileCount) * 8, 40)) + 'px';
            },
            'height': (node: any) => {
              const fileCount = node.data('fileCount') || 1;
              return (70 + Math.min(Math.log2(fileCount) * 8, 40)) + 'px';
            },
            'color': '#ffffff',
            'font-family': 'Outfit, sans-serif',
            'font-size': '10.5px',
            'font-weight': 'bold',
            'text-valign': 'center',
            'text-halign': 'center',
            'text-outline-width': '2px',
            'text-outline-color': '#14161a',
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
          selector: 'node[?isBoundaryNode]',
          style: {
            'border-style': 'dashed',
            'border-width': '2.5px',
            'border-color': '#e5c07b',
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
            'line-color': 'rgba(209, 154, 102, 0.45)',
            'target-arrow-color': 'rgba(209, 154, 102, 0.45)',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'label': 'data(label)',
            'color': '#abb2bf',
            'font-family': 'Outfit, sans-serif',
            'font-size': '10px',
            'font-weight': 'bold',
            'text-background-color': '#1e222b',
            'text-background-opacity': 0.95,
            'text-background-padding': '3px',
            'text-background-shape': 'roundrectangle'
          }
        }
      ],
      layout: getLayoutOptions(showClusters, false)
    });

    // Hide the loading overlay once the initial layout is done (or immediately
    // if layout is not animated).
    showOverlay('Running layout…');
    cyInstance.one('layoutstop', () => hideOverlay());
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

    function highlightMatch(text: string, query: string): string {
      if (!query) return text;
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx === -1) return text;
      return text.substring(0, idx) +
        `<span class="ac-match">${text.substring(idx, idx + query.length)}</span>` +
        text.substring(idx + query.length);
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
        return `<div class="focus-autocomplete-item${i === 0 ? ' active' : ''}" data-file-id="${id}">
          <span class="ac-file-name">${highlightMatch(fileName, lowerQuery)}</span>
          <span class="ac-file-path">${dirPath ? highlightMatch(dirPath, lowerQuery) : ''}</span>
          ${lang ? `<span class="ac-lang-badge">${lang}</span>` : ''}
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
              <span class="flow-current">${label}</span>
              <button type="button" class="flow-clickable-edge" data-go-id="${edgeId}">${edgeType.toUpperCase()}</button>
              <span class="flow-arrow">&rarr;</span>
              <button type="button" class="flow-clickable-node" data-go-id="${targetId}">${targetLabel}</button>
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
              <button type="button" class="flow-clickable-node incoming-node" data-go-id="${sourceId}">${sourceLabel}</button>
              <span class="flow-arrow">&rarr;</span>
              <button type="button" class="flow-clickable-edge" data-go-id="${edgeId}">${edgeType.toUpperCase()}</button>
              <span class="flow-arrow">&rarr;</span>
              <span class="flow-current">${label}</span>
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
            <button type="button" class="flow-clickable-node" data-go-id="${sourceId}">
              ${sourceLabel}
            </button>
          </div>
          <div class="flow-group" style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">Destination Node</div>
            <button type="button" class="flow-clickable-node" data-go-id="${targetId}" style="background: rgba(97, 175, 239, 0.16); color: #61afef; border-color: rgba(97, 175, 239, 0.35);">
              ${targetLabel}
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
            <div style="font-family: 'JetBrains Mono', Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #cbd5e1; display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div class="detail-stat-row">
                <span class="detail-stat-label">Type</span>
                <span class="detail-stat-value" style="color: #98c379; font-weight: bold;">DIRECTORY CLUSTER</span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Path</span>
                <span class="detail-stat-value">${data.fullPath || data.id.replace('dir:', '')}</span>
              </div>
            </div>
          ` + buildRelatedFlowsHTML(node);
        } else {
          const tags = customTags.get(data.id) || [];
          const tagsListHtml = tags.map(t =>
            `<span class="tag-badge">${t}<button class="tag-badge-remove" data-node-id="${data.id}" data-tag="${t}" title="Remove tag">&times;</button></span>`
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
          
          details.innerHTML = `
            <div style="font-family: 'JetBrains Mono', Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #cbd5e1; display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div class="detail-stat-row">
                <span class="detail-stat-label">Path</span>
                <span class="detail-stat-value">${data.id}</span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Language</span>
                <span class="detail-stat-value">${data.language ? data.language.toUpperCase() : 'UNKNOWN'}</span>
              </div>

              <!-- Stats Grid -->
              <div class="detail-stat-grid">
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">Lines</span>
                  <span class="detail-stat-mini-value">${data.lines || '—'}</span>
                </div>
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">Size</span>
                  <span class="detail-stat-mini-value">${data.size ? `${(data.size / 1024).toFixed(1)}K` : '—'}</span>
                </div>
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">In / Out</span>
                  <span class="detail-stat-mini-value" style="color: var(--syntax-green);">${inDeg} / ${outDeg}</span>
                </div>
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">Connections</span>
                  <span class="detail-stat-mini-value" style="color: var(--syntax-blue);">${totalDeg}</span>
                </div>
                ${symbolCount > 0 ? `
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">Symbols</span>
                  <span class="detail-stat-mini-value">${symbolCount}</span>
                </div>` : ''}
                ${pagerank ? `
                <div class="detail-stat-mini">
                  <span class="detail-stat-mini-label">PageRank</span>
                  <span class="detail-stat-mini-value" style="color: var(--syntax-purple);">${pagerank}</span>
                </div>` : ''}
              </div>

              ${data.isBoundaryNode ? `
              <div class="detail-stat-row">
                <span class="detail-stat-label" style="color: #d19a66;">Role</span>
                <span class="detail-stat-value" style="color: #d19a66;">Boundary Node</span>
              </div>
              ` : ''}

              ${clusterLabel ? `
              <div class="detail-stat-row">
                <span class="detail-stat-label">Cluster</span>
                <span class="detail-stat-value" style="color: var(--syntax-cyan);">${clusterLabel}</span>
              </div>
              ` : ''}
              
              <!-- Custom Tags Section -->
              <div style="border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; display: flex; flex-direction: column; gap: 6px;">
                <span class="detail-stat-label">Custom Tags</span>
                <div style="margin-bottom: 4px; display: flex; flex-wrap: wrap;">${tagsListHtml || '<span style="color: var(--text-muted); font-style: italic; font-size: 10px;">No tags</span>'}</div>
                <div style="display: flex; gap: 6px; position: relative;">
                  <input type="text" id="input-new-tag" placeholder="Add tag..." class="form-control" style="padding: 4px 8px; font-size: 11px; height: 26px; border-radius: 4px;">
                  <button id="btn-add-tag" class="btn" style="padding: 4px 10px; font-size: 11px; height: 26px; border-radius: 4px; flex-shrink: 0;">Add</button>
                </div>
              </div>
              
              <!-- Actions Section -->
              <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px;">
                <button class="btn btn-secondary btn-action-remove-node" data-node-id="${data.id}" style="padding: 6px 12px; font-size: 11px; border-color: rgba(239, 68, 68, 0.35); color: #ef4444; width: 100%; border-radius: 4px;">
                  Remove Node from View
                </button>
              </div>
            </div>
          ` + buildRelatedFlowsHTML(node);
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
                <span style="color: #61afef; font-weight: bold; text-align: right;">${data.count || 1} file-level edge(s)</span>
              </div>
              
              <!-- Actions Section -->
              <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px;">
                <button class="btn btn-secondary btn-action-remove-edge" data-edge-id="${data.id}" style="padding: 6px 12px; font-size: 11px; border-color: rgba(239, 68, 68, 0.35); color: #ef4444; width: 100%; border-radius: 4px;">
                  Remove Edge from View
                </button>
              </div>
            </div>
          ` + (data.type === 'cluster-dependency' ? buildRelatedNodesForEdgeHTML(edge) : '');
        } else {
          details.innerHTML = `
            <div style="font-family: 'JetBrains Mono', Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #cbd5e1; display: flex; flex-direction: column; gap: 10px; width: 100%;">
              <div class="detail-stat-row">
                <span class="detail-stat-label">Source</span>
                <span class="detail-stat-value"><a href="#" data-go-id="${data.source}" style="color: var(--syntax-blue); text-decoration: none;">${data.source.split('/').pop()}</a></span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Target</span>
                <span class="detail-stat-value"><a href="#" data-go-id="${data.target}" style="color: var(--syntax-blue); text-decoration: none;">${data.target.split('/').pop()}</a></span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Edge Type</span>
                <span class="detail-stat-value"><span class="badge" style="background:#8b5cf6; padding:3px 6px; border-radius:4px; font-size:10px; color:#fff; font-family:inherit;">${data.type}</span></span>
              </div>
              <div class="detail-stat-row">
                <span class="detail-stat-label">Verifiability</span>
                <span class="detail-stat-value"><span class="verifiability-badge ${data.verifiability === 'verified' ? 'verified' : 'inferred'}">${data.verifiability || 'unknown'}</span></span>
              </div>
              ${data.weight ? `
              <div class="detail-stat-row">
                <span class="detail-stat-label">Weight</span>
                <span class="detail-stat-value">${data.weight}</span>
              </div>
              ` : ''}
              
              <!-- Actions Section -->
              <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px;">
                <button class="btn btn-secondary btn-action-remove-edge" data-edge-id="${data.id}" style="padding: 6px 12px; font-size: 11px; border-color: rgba(239, 68, 68, 0.35); color: #ef4444; width: 100%; border-radius: 4px;">
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
          details.innerHTML = 'Click a file node or dependency edge to view details.';
        }
      }
    });

  } catch (err) {
    hideOverlay();
    console.error('Failed to load graph:', err);
  }
}

// Fetch symbols
async function loadSymbols(query: string = '') {
  const PAGE_SIZE = 50;
  try {
    const offset = symbolPage * PAGE_SIZE;
    const res = await fetch(`/api/symbols?q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) return;
    const data = await res.json();
    const symbols: any[] = data.results ?? [];
    const total: number = data.total ?? symbols.length;

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
      updateSymbolPagination(0, 0, 0, PAGE_SIZE);
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
          const methodColor = getRouteMethodColor(r.method);
          tr.innerHTML = `
            <td><strong>${r.framework}</strong></td>
            <td><span class="method-badge" style="background:${methodColor};">${r.method}</span></td>
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
          const hookColor = getHookTypeColor(h.hookType);
          tr.innerHTML = `
            <td><strong>${h.framework}</strong></td>
            <td><span class="hook-badge" style="background:${hookColor};">${h.hookType}</span></td>
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

    const languagesDiv = document.getElementById('metrics-languages');
    if (languagesDiv && metrics.languages) {
      const langs = Object.entries(metrics.languages).sort((a: any, b: any) => b[1] - a[1]);
      if (langs.length > 0) {
        languagesDiv.innerHTML = `
          <ul style="padding-left: 20px; display: flex; flex-direction: column; gap: 6px;">
            ${langs.map(([lang, cnt]) => `
              <li><strong style="text-transform: capitalize;">${lang}:</strong> ${cnt} files</li>
            `).join('')}
          </ul>
        `;
      } else {
        languagesDiv.innerHTML = '<div style="color: var(--text-muted);">No language files found.</div>';
      }
    }

    const kindsDiv = document.getElementById('metrics-kinds');
    if (kindsDiv && metrics.symbolKinds) {
      if (metrics.symbolKinds.length > 0) {
        kindsDiv.innerHTML = `
          <ul style="padding-left: 20px; display: flex; flex-direction: column; gap: 6px;">
            ${metrics.symbolKinds.map((row: any) => `
              <li><strong style="text-transform: capitalize;">${row.kind}:</strong> ${row.cnt}</li>
            `).join('')}
          </ul>
        `;
      } else {
        kindsDiv.innerHTML = '<div style="color: var(--text-muted);">No symbols found.</div>';
      }
    }

    const edgesDiv = document.getElementById('metrics-edges');
    if (edgesDiv) {
      const edgeTypesList = metrics.edgeTypes && metrics.edgeTypes.length > 0
        ? metrics.edgeTypes.map((row: any) => `<li><strong>${row.edge_type}:</strong> ${row.cnt}</li>`).join('')
        : '<li style="color: var(--text-muted); list-style-type: none;">None</li>';

      edgesDiv.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div><strong>Total Edges:</strong> ${metrics.totalEdges || 0}</div>
          <div><strong>Relation Density:</strong> ${metrics.density || '0%'}</div>
          <div><strong>Avg Edges/File:</strong> ${metrics.avgEdgesPerFile || 0}</div>
          <div><strong>Verified Edges:</strong> ${metrics.verifiedEdges || 0} | <strong>Inferred Edges:</strong> ${metrics.inferredEdges || 0}</div>
          <div style="margin-top: 5px;">
            <strong>Edge Types Breakdown:</strong>
            <ul style="padding-left: 20px; margin-top: 5px; display: flex; flex-direction: column; gap: 4px;">
              ${edgeTypesList}
            </ul>
          </div>
        </div>
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
          <li><span style="font-family: monospace;">[${c.status}]</span> ${c.path}</li>
        `).join('');
        gitStatusHTML = `
          <div>
            <strong>Git Status:</strong> ⚠ Stale (${git.changesCount} changed files since last scan)
            <ul style="padding-left: 20px; margin-top: 5px; max-height: 100px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
              ${changesList}
            </ul>
          </div>
        `;
      }

      gitStorageDiv.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div><strong>Database Size:</strong> ${dbSizeKB} KB</div>
          ${gitStatusHTML}
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
              <ul style="padding-left:20px; margin-top:5px; display: flex; flex-direction: column; gap: 4px;">
                ${context.files && context.files.length > 0 
                  ? context.files.map((f: any) => `
                      <li>
                        <code>${f.path || f}</code> 
                        <span style="font-size: 0.85em; color: var(--text-muted); margin-left: 8px;">
                          (${f.language || 'unknown'} • ${f.lineCount || 0} lines)
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
                        <code>${s.name || s}</code> 
                        <span style="font-size: 0.85em; color: var(--text-muted); margin-left: 8px;">
                          (${s.kind || 'unknown'} • <code>${s.filePath || ''}</code>)
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
      if (resultsDiv) resultsDiv.innerHTML = `<div class="details-placeholder" style="color:#ef4444;">Error: ${err.message}</div>`;
    }
  });
}

// Poll endpoints periodically to keep the UI up-to-date in near-real-time (fallback/sync)
function startPeriodicPolling() {
  setInterval(async () => {
    // 1. Poll tool calls
    const logContainer = document.getElementById('tool-log-container');
    if (logContainer) {
      try {
        const res = await fetch('/api/tool-calls');
        if (res.ok) {
          const events = await res.json();
          if (events.length > 0) {
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
          
          const filterSelect = document.getElementById('filter-lang') as HTMLSelectElement;
          if (filterSelect && status.languages) {
            const currentVal = filterSelect.value;
            filterSelect.innerHTML = '<option value="">All Languages</option>';
            Object.keys(status.languages).forEach(lang => {
              const opt = document.createElement('option');
              opt.value = lang;
              opt.textContent = lang.toUpperCase();
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
  loadStatus();
  loadGraph();
  loadSymbols();
  loadRoutes();
  loadMetrics();
  loadToolCallHistory();
  setupSSE();
  setupContextBuilder();
  startPeriodicPolling();

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
        if (detailsContent) detailsContent.innerHTML = 'Click a file node or dependency edge to view details.';
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
        if (detailsContent) detailsContent.innerHTML = 'Click a file node or dependency edge to view details.';
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

    // 5. Clickable Node/Edge navigation
    const clickable = target.closest('[data-go-id]');
    if (clickable && cyInstance) {
      e.preventDefault();
      const id = clickable.getAttribute('data-go-id');
      if (id) {
        const ele = cyInstance.getElementById(id);
        if (ele && ele.length > 0) {
          ele.trigger('tap');
          
          // Focus/center the graph on the clicked element
          cyInstance.animate({
            center: { eles: ele }
          }, {
            duration: 350
          });
        }
      }
    }
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
    groupingStrategy = 'community';
    const groupingSelect = document.getElementById('select-grouping-strategy') as HTMLSelectElement;
    if (groupingSelect) groupingSelect.value = 'community';

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
    const clustersBtn = document.getElementById('btn-toggle-clusters');
    if (clustersBtn) clustersBtn.style.display = 'none';
    const breadcrumb = document.getElementById('cluster-breadcrumb');
    if (breadcrumb) breadcrumb.style.display = 'none';
    updateToolbarVisibility(currentGraphMode);

    updateGraphDisplay();
  });
});
