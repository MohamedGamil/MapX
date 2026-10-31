import { describe, it, expect, vi, afterEach } from 'vitest';
import { Parser, Query } from 'web-tree-sitter';
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

  // M0-02-R3: compiling a query costs far more than running it, and small scans and syncs parse on
  // the main thread, so each (language, query) pair is compiled once and reused.
  it('compiles each query once per language and reuses it', async () => {
    const js = await loadLanguage({ name: 'javascript', grammarWasm: 'wasm/tree-sitter-javascript.wasm' } as any);
    const php = await loadLanguage({ name: 'php', grammarWasm: 'wasm/tree-sitter-php.wasm' } as any);
    const captures = vi.spyOn(Query.prototype, 'captures');
    const REFS = '(call_expression function: (identifier) @ref.name)';
    for (let i = 0; i < 3; i++) {
      const parsed = await parseWithQueries(`function f${i}() { g${i}(); }`, js, SYMBOLS, REFS);
      expect(parsed.symbols.get('symbol.name')?.[0]?.node.text).toBe(`f${i}`);
      expect(parsed.references.get('ref.name')?.[0]?.node.text).toBe(`g${i}`);
    }
    await parseWithQueries('<?php function h() {}', php, '(function_definition name: (name) @symbol.name)', '');

    // Six runs on JS (symbols and references, three files) use two compiled queries; PHP its own.
    const queries = captures.mock.contexts as Query[];
    expect(queries).toHaveLength(8);
    expect(new Set(queries.slice(0, 6)).size).toBe(2);
    expect(queries[0]).toBe(queries[2]);
    expect(queries[1]).toBe(queries[3]);
    expect(queries.slice(0, 6)).not.toContain(queries[6]);
    expect(queries.slice(0, 6)).not.toContain(queries[7]);
  });
});
