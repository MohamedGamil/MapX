import { describe, it, expect, vi, afterEach } from 'vitest';
import { Parser } from 'web-tree-sitter';
import { loadLanguage, parseWithQueries } from '../src/parsers/wasm-parser.js';

// M0-37: exercise the real parser pool in src/parsers/wasm-parser.ts (CHANGELOG 0.3.4). A pooled
// parser is created and bound to its language once, then reused for every later parse.
const SYMBOLS = '(function_declaration name: (identifier) @symbol.name) @symbol.kind_function';

describe('WASM parser pool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('binds one parser per language and reuses it across parses', async () => {
    const js = await loadLanguage({ name: 'javascript', grammarWasm: 'wasm/tree-sitter-javascript.wasm' } as any);
    const php = await loadLanguage({ name: 'php', grammarWasm: 'wasm/tree-sitter-php.wasm' } as any);
    const setLanguage = vi.spyOn(Parser.prototype, 'setLanguage');

    for (let i = 0; i < 5; i++) {
      const parsed = await parseWithQueries(`function f${i}() {}`, js, SYMBOLS, '');
      expect(parsed.symbols.get('symbol.name')?.[0]?.node.text).toBe(`f${i}`);
    }
    await parseWithQueries('<?php function g() {}', php, '(function_definition name: (name) @symbol.name)', '');
    await parseWithQueries('<?php function h() {}', php, '(function_definition name: (name) @symbol.name)', '');

    // At most one bind per language for the whole run (zero if an earlier test already pooled it).
    const bound = setLanguage.mock.calls.map(([lang]) => lang);
    expect(bound.filter((l) => l === js).length).toBeLessThanOrEqual(1);
    expect(bound.filter((l) => l === php).length).toBeLessThanOrEqual(1);
  });

  it('keeps languages isolated: parsing PHP between JS parses does not rebind the JS parser', async () => {
    const js = await loadLanguage({ name: 'javascript', grammarWasm: 'wasm/tree-sitter-javascript.wasm' } as any);
    const php = await loadLanguage({ name: 'php', grammarWasm: 'wasm/tree-sitter-php.wasm' } as any);
    await parseWithQueries('function a() {}', js, SYMBOLS, '');
    await parseWithQueries('<?php function b() {}', php, '(function_definition name: (name) @symbol.name)', '');
    const setLanguage = vi.spyOn(Parser.prototype, 'setLanguage');
    const parsed = await parseWithQueries('function c() {}', js, SYMBOLS, '');
    expect(parsed.symbols.get('symbol.name')?.[0]?.node.text).toBe('c');
    expect(setLanguage).not.toHaveBeenCalled();
  });
});
