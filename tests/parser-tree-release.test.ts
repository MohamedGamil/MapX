import { afterEach, describe, expect, it, vi } from 'vitest';
import { Query, Tree } from 'web-tree-sitter';
import { getParserForFile } from '../src/parsers/parser-registry.js';

// M2-08-R9: a syntax tree lives in WASM memory and has no finalizer, so each parse frees its own. A
// long-lived process (`mapx serve`, a pooled parse worker, the main-thread fallback of a small sync)
// otherwise grew by a tree per parse (3000 parses of an 8 KB script: 155 MB to 1.2 GB).
describe('a parse frees its syntax tree', () => {
  afterEach(() => vi.restoreAllMocks());

  const freed = (path: string, source: string, parses: number) => async () => {
    const parser = getParserForFile(path);
    const deleted = vi.spyOn(Tree.prototype, 'delete');
    for (let i = 0; i < parses; i++) {
      const result = await parser.parse(path, source);
      expect(result.symbols.length).toBeGreaterThan(0);
    }
    expect(deleted).toHaveBeenCalledTimes(parses);
  };

  it('TypeScript', freed('a.ts', 'export function f() { return g(); }\nfunction g() { return 1; }\n', 5));
  it('JavaScript', freed('a.js', 'function f() { return g(); }\nfunction g() { return 1; }\n', 5));
  it('PHP', freed('a.php', '<?php\nclass A { public function f() { return 1; } }\n', 5));
  it('Python', freed('a.py', 'def f():\n    return g()\n\n\ndef g():\n    return 1\n', 5));

  it('also when a query throws', async () => {
    const parser = getParserForFile('a.ts');
    await parser.parse('a.ts', 'function f() {}\n');
    const deleted = vi.spyOn(Tree.prototype, 'delete');
    // The query run on the tree fails, and the tree is still freed.
    vi.spyOn(Query.prototype, 'captures').mockImplementation(() => { throw new Error('boom'); });
    await parser.parse('a.ts', 'function f() {}\n');
    expect(deleted).toHaveBeenCalledTimes(1);
  });
});
