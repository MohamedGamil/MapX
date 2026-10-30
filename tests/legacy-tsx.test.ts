import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-18-R1: methods of an anonymous default-exported class are scoped to its derived name.
describe('anonymous default class methods', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'src/AnonClass.tsx': 'export default class { go() { return 1; } stop() { return 2; } }\n',
      'src/Named.ts': 'export default class Named { go() { return 1; } }\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('scopes them to the file-derived class name', () => {
    const rows = query<{ name: string; scope: string | null }>(root, "SELECT name, scope FROM symbols WHERE file_path = 'src/AnonClass.tsx' AND kind = 'method' ORDER BY name");
    expect(rows).toEqual([{ name: 'go', scope: 'AnonClass' }, { name: 'stop', scope: 'AnonClass' }]);
    expect(query(root, "SELECT scope FROM symbols WHERE file_path = 'src/Named.ts' AND name = 'go'")).toEqual([{ scope: 'Named' }]);
  });
});
