import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-01: no edge may link a JS-family file and a PHP file by name alone.
const PHP = /\.php$/;
const JS = /\.(js|ts|vue)$/;

describe('cross-language name resolution', () => {
  let root: string;
  beforeAll(() => {
    root = workspace(
      {
        'backend/artisan': '#!/usr/bin/env php\n<?php\n',
        'backend/app/Repo.php': '<?php\nnamespace App;\nclass Repo { public function get($id) { return $id; } public function save() { return 1; } }\n',
        // The PHP controller lives in vendor/ (excluded), so only the JS class of the same name is indexed.
        'backend/routes/api.php': "<?php\nuse App\\Http\\Controllers\\UserController;\nRoute::get('users', [UserController::class, 'index']);\n",
        'frontend/src/UserController.js': 'export class UserController { index() { return []; } }\n',
        'frontend/src/client.js': "import axios from 'axios';\nconst api = axios.create({ baseURL: '/api' });\nexport function load(id) { return api.get('/users/' + id); }\nexport function store(x) { return api.save(x); }\n",
        'frontend/src/Users.vue': "<template><button @click=\"save\">x</button></template>\n<script>\nimport api from './client';\nexport default { methods: { save() { return this.$http.save(1); }, fetch() { return api.get('/users'); } } }\n</script>\n",
      },
      ['backend', 'frontend'],
    );
    init(root);
    mapx(root, 'workspaces', 'add', 'backend');
    mapx(root, 'workspaces', 'add', 'frontend');
    mapx(root, 'scan', '.', '--all');
  }, 90000);
  afterAll(() => cleanup(root));

  it('creates no edge between JS-family and PHP files', () => {
    const edges = query<{ source_file: string; target_file: string; edge_type: string }>(
      root,
      'SELECT source_file, target_file, edge_type FROM edges',
    );
    const crossing = edges.filter(
      (e) => (PHP.test(e.source_file) && JS.test(e.target_file)) || (JS.test(e.source_file) && PHP.test(e.target_file)),
    );
    expect(crossing).toEqual([]);
  });

  it('still records the route, pointing back at the route file when the PHP handler is not indexed', () => {
    const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as { path: string; handlerFile: string }[];
    const users = routes.find((r) => r.path === '/api/users');
    expect(users?.handlerFile).toBe('backend/routes/api.php');
  });
});
