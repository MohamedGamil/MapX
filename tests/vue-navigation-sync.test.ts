import { describe, it, expect } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M3-11-R1 companion (scanner): a scope move re-parses every file that may navigate. Guard redirects
// (`next('/x')`, a returned location) may never name `router.push` or `useRouter`; the scanner's
// filter is now the parser's own pre-filter (`mayNavigate`), so sync matches scan --force.
describe('guard redirects follow a scope move on sync (M3-11-R1)', () => {
  it('drops and restores the navigate edges of guards that name no router.push', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'mono', private: true, dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' }, devDependencies: { vite: '^5.0.0' } }),
      '.gitignore': '.mapx/\n',
      'apps/a/src/router.js': "import { createRouter, createWebHistory } from 'vue-router';\nimport Home from './views/Home.vue';\nexport default createRouter({ history: createWebHistory(), routes: [{ path: '/home', name: 'home', component: Home }] });\n",
      'apps/a/src/views/Home.vue': '<template><p>home</p></template>\n',
      // A guards module that never names the router: next('/home').
      'apps/c/src/guards.js': "export function requireHome(to, from, next) {\n  if (!to.meta.ok) next('/home');\n  else next();\n}\n",
      // Guards installed on a router passed in: a returned location.
      'apps/c/src/install.js': "export function install(router) {\n  router.beforeEach(function check(to) {\n    if (!to.meta.ok) return { name: 'home' };\n  });\n}\n",
    }, ['.']);
    const sources = () => query<{ source_file: string }>(root, "SELECT source_file FROM edges WHERE edge_type = 'navigate' ORDER BY source_file").map((r) => r.source_file);
    const all = () => query<{ e: string }>(root, "SELECT source_file || '>' || target_file || '>' || edge_type AS e FROM edges ORDER BY e").map((r) => r.e);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
    try {
      git('add', '-A');
      git('commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      expect(sources()).toEqual(['apps/c/src/guards.js', 'apps/c/src/install.js']);
      // apps/a becomes its own app: its router moves away from apps/c's guards.
      writeFileSync(join(root, 'apps/a/package.json'), JSON.stringify({ name: 'a', devDependencies: { vite: '^5.0.0' } }));
      mapx(root, 'sync', root);
      expect(sources()).toEqual([]);
      const synced = all();
      mapx(root, 'scan', root, '--force');
      expect(all()).toEqual(synced);
      // And back.
      rmSync(join(root, 'apps/a/package.json'));
      mapx(root, 'sync', root);
      expect(sources()).toEqual(['apps/c/src/guards.js', 'apps/c/src/install.js']);
    } finally {
      cleanup(root);
    }
  }, 120000);
});
