import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';

// M0-36: `mapx node --include-members`, as documented in CHANGELOG 0.3.4 and the agent templates.
describe('mapx node --include-members', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'src/user.ts': 'export class User {\n  name = "";\n  save() { return 1; }\n  load() { return 2; }\n}\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('lists member methods with the flag and omits them without it', () => {
    const withFlag = mapx(root, 'node', 'User', '-d', root, '--include-members');
    expect(withFlag).toContain('Members:');
    expect(withFlag).toMatch(/method save \(L3-3\)/);
    expect(withFlag).toMatch(/method load \(L4-4\)/);
    expect(mapx(root, 'node', 'User', '-d', root)).not.toContain('Members:');
  });

  it('adds members to JSON output', () => {
    const json = JSON.parse(mapx(root, 'node', 'User', '-d', root, '--include-members', '--format', 'json'));
    expect(json.members.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(['save', 'load']));
  });
});
