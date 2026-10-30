import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-23: the scan summary must report the edges actually stored.
describe('scan summary counts', () => {
  let root: string;
  let output: string;
  beforeAll(() => {
    root = workspace(
      {
        'backend/app/Repo.php': '<?php\nnamespace App;\nclass Repo { public function get($id) { return $id; } public function save() { return 1; } }\n',
        'frontend/src/client.js': "import axios from 'axios';\nconst api = axios.create({ baseURL: '/api' });\nexport function load(id) { return api.get('/users/' + id); }\nexport function store(x) { return api.save(x); }\n",
        'frontend/src/Users.vue': "<template><button @click=\"save\">x</button></template>\n<script>\nimport api from './client';\nexport default { methods: { save() { return this.$http.save(1); }, fetch() { return api.get('/users'); } } }\n</script>\n",
      },
      ['backend', 'frontend'],
    );
    init(root);
    mapx(root, 'workspaces', 'add', 'backend');
    mapx(root, 'workspaces', 'add', 'frontend');
    output = mapx(root, 'scan', '.', '--all');
  }, 90000);
  afterAll(() => cleanup(root));

  it('reports the stored edge and symbol counts in a multi-repo scan', () => {
    const [{ edges }] = query<{ edges: number }>(root, 'SELECT count(*) AS edges FROM edges');
    const [{ symbols }] = query<{ symbols: number }>(root, 'SELECT count(*) AS symbols FROM symbols');
    const summary = output.match(/Found (\d+) symbols, (\d+) edges/);
    expect(summary, output).not.toBeNull();
    expect(Number(summary![2])).toBe(edges);
    expect(Number(summary![1])).toBe(symbols);
  });

  it('indexes files of a nested registered repo only once, under that repo', () => {
    expect(output).toMatch(/Languages: .*php: 1\b/);
    expect(output).toMatch(/Languages: .*javascript: 1\b/);
    const owners = query<{ repo: string; path: string }>(root, 'SELECT repo, path FROM files ORDER BY path');
    expect(owners).toEqual([
      { repo: 'backend', path: 'backend/app/Repo.php' },
      { repo: 'frontend', path: 'frontend/src/Users.vue' },
      { repo: 'frontend', path: 'frontend/src/client.js' },
    ]);
  });
});
