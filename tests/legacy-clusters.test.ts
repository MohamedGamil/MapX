import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { detectLeidenCommunities } from '../src/core/leiden.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-08-R1: cluster detection, cluster export and class-level trace defects.
describe('Leiden', () => {
  const clique = (p: string) => {
    const nodes = [1, 2, 3, 4].map((i) => `${p}${i}`);
    const edges = nodes.flatMap((a, i) => nodes.slice(i + 1).map((b) => ({ source: a, target: b, weight: 1 })));
    return { nodes, edges };
  };

  it('splits two 4-cliques joined by one edge into 2 communities, every run', () => {
    const a = clique('a');
    const b = clique('b');
    const edges = [...a.edges, ...b.edges, { source: 'a1', target: 'b1', weight: 1 }];
    for (const resolution of [1, 1.3]) {
      for (let run = 0; run < 5; run++) {
        const communities = Object.values(detectLeidenCommunities([...a.nodes, ...b.nodes], edges, { resolution, minCommunitySize: 2 }));
        expect(communities.map((c) => [...c].sort()).sort()).toEqual([a.nodes, b.nodes]);
      }
    }
  });
});

const php = (ns: string, name: string, body = '', uses = '') => `<?php\nnamespace ${ns};\n${uses}\nclass ${name} ${body}\n`;

describe('cluster export, trace and fallback SVG', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Models/User.php': php('App\\Models', 'User', '{}'),
      'app/Models/Team.php': php('App\\Models', 'Team', '{}'),
      'app/Events/Registered.php': php('App\\Events', 'Registered', '{}', 'use Illuminate\\Foundation\\Events\\Dispatchable;'),
      'app/Events/Shipped.php': php('App\\Events', 'Shipped', '{}', 'use Illuminate\\Foundation\\Events\\Dispatchable;'),
      'app/Notifications/Welcome.php': php('App\\Notifications', 'Welcome', 'extends \\Illuminate\\Notifications\\Notification {}'),
      'app/Services/UserService.php': php('App\\Services', 'UserService', [
        '{',
        '  public function make() { return new User(); }',
        '  public function team() { return new Team(); }',
        '  public function register($u) {',
        '    event(new Registered($u));',
        '    $u->notify(new Welcome());',
        '  }',
        '}',
      ].join('\n'), 'use App\\Models\\User;\nuse App\\Models\\Team;\nuse App\\Events\\Registered;\nuse App\\Notifications\\Welcome;'),
      'routes/web.php': "<?php\nRoute::get('/', fn () => 1);\n",
      'routes/api.php': "<?php\nRoute::get('/a', fn () => 1);\n",
      'src/util.ts': 'export function helper() { return 1; }\nexport function other() { return 2; }\n',
      'src/scanner.ts': [
        "import { helper, other } from './util';",
        'export class Scanner {',
        '  scan() {',
        '    return this.walk();',
        '  }',
        '  walk() {',
        '    return helper() + other();',
        '  }',
        '}',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  it('keeps PHP namespaces on a fresh parallel scan (> 10 files)', () => {
    expect(query<{ namespace: string }>(root, "SELECT namespace FROM files WHERE path = 'app/Models/User.php'")[0]?.namespace).toBe('App\\Models');
    expect(mapx(root, 'clusters')).toMatch(/^ {2}App\.Models\s+\(namespace\)\s+\[2 files\]/m);
  });

  it('reports file counts for every directory cluster of a PHP app (no empty ones)', () => {
    const out = mapx(root, 'clusters');
    expect(out).toMatch(/^routes\s+\(directory\)\s+\[2 files\]/m);
    expect(out).not.toMatch(/\(directory\)\s+\[0 files\]/);
  });

  it('emits cluster nodes only for --cluster auto --depth 0, with penwidth from edge counts', () => {
    const dot = mapx(root, 'export', '--format', 'dot', '--cluster', 'auto', '--depth', '0');
    expect(dot).not.toMatch(/\.(php|ts)"/);
    expect(dot).toContain('"cluster_App_Services" [label="App / Services\\n1 file"]');
    expect(dot).toContain('"cluster_App_Models" [label="App / Models\\n2 files"]');
    const edges = [...dot.matchAll(/-> "\S+" \[label="(\d+) edges? \([^)]*\)", penwidth=([\d.]+)\]/g)];
    expect(edges.length).toBeGreaterThan(0);
    for (const [, count, width] of edges) expect(Number(width)).toBeCloseTo(Math.min(5, Math.log(Number(count)) + 1), 2);
    expect(edges.some(([, count]) => Number(count) > 1)).toBe(true);
    // depth 1 still renders files inside cluster subgraphs
    expect(mapx(root, 'export', '--format', 'dot', '--cluster', 'auto', '--depth', '1')).toMatch(/subgraph "cluster_[\s\S]*"app\/Models\/User\.php"/);
  });

  it('aggregates class members when tracing a class', () => {
    const trace = JSON.parse(mapx(root, 'trace', 'Scanner', '--direction', 'down', '--format', 'json'));
    expect(trace.edgeCount).toBeGreaterThan(0);
    expect(trace.nodes.map((n: { symbol: string }) => n.symbol)).toEqual(expect.arrayContaining(['helper', 'other']));
  });

  it('styles dispatch and notify edges in the fallback SVG', () => {
    const svg = mapx(root, 'export', '--format', 'svg', '--fallback-grid');
    expect(svg).toMatch(/stroke="#d946ef" stroke-width="2"/); // dispatch: bold magenta
    expect(svg).toMatch(/stroke="#ec4899" stroke-width="1.2" stroke-dasharray="1,3"/); // notify: dotted pink
  });
});
