import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, initAndScanMultiRepo, multiRepoWorkspace } from '../scripts/ui/workspace.js';
import { Store } from '../src/core/store.js';

// M2-06-R3 (found by M4-21): an http edge from a frontend repo to a backend repo's handler is a
// cross-repo edge. It was stored without target_repo, so `status --all`, `deps --cross-repo`
// and the dashboard did not count it.
describe('http edges between registered repos (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mapx-http-xrepo-'));
    multiRepoWorkspace(root);
    initAndScanMultiRepo(root);
  }, 180_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('records the backend repo as the target of each paired call', () => {
    const store = new Store(join(root, '.mapx/mapx.db'));
    try {
      const rows = store.raw.prepare("SELECT repo, target_repo, source_file, target_file FROM edges WHERE edge_type = 'http' ORDER BY source_file").all() as any[];
      expect(rows).toHaveLength(3); // list, create, show; /api/nowhere has no route
      for (const r of rows) expect(r).toMatchObject({ repo: 'web', target_repo: 'api', source_file: 'web/src/api/orders.ts', target_file: 'api/app/Http/Controllers/OrderController.php' });
    } finally {
      store.close();
    }
  });

  it('counts them in deps --cross-repo', () => {
    expect(cli(root, 'deps', 'web/src/api/orders.ts', '--cross-repo')).toContain('→ [api] api/app/Http/Controllers/OrderController.php');
  });
});
