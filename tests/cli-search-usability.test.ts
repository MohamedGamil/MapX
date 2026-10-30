import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';

// M0-22-R2: the CLI side of the F38 search fixes (M0-22-R1 fixed MCP).
const many = Array.from({ length: 25 }, (_, i) => `export function fn${i}() { return ${i}; }`).join('\n');

describe('mapx search usability', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({ 'src/many.ts': many });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));
  const names = (text: string) => new Set(text.match(/\bfn\d+\b/g) ?? []);

  it('lists every symbol of a file for a wildcard term', () => {
    const out = mapx(root, 'search', '*', '--file', 'src/many.ts', '-d', root);
    expect(names(out).size).toBe(25);
    expect(out).toContain('Found 25 symbols');
  });

  it('reports truncation with the real total, and honours an explicit --limit', () => {
    expect(mapx(root, 'search', 'fn', '-d', root)).toContain('Found 20 of 25 symbols');
    expect(mapx(root, 'search', '*', '--file', 'src/many.ts', '--limit', '5', '-d', root)).toContain('Found 5 of 25 symbols');
  });

  it('includes totalMatches in JSON', () => {
    const json = JSON.parse(mapx(root, 'search', 'fn', '--format', 'json', '-d', root));
    expect(json).toMatchObject({ total: 20, totalMatches: 25 });
  });
});
