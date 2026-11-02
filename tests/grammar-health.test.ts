import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBuiltinLanguages } from '../src/languages/registry.js';
import { getPooledParser, loadLanguage } from '../src/parsers/wasm-parser.js';
import { getParserForFile } from '../src/parsers/parser-registry.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M4-27: a grammar must parse every file of a process alike. The Lua grammar's external scanner
// kept its state across parses, so only the first Lua file of a process parsed correctly.

const LUA_A = 'local M = {}\nfunction M.foo() return M.bar() end\nfunction M.bar() return 1 end\n-- c\nlocal s = "x" .. [[long]] .. \'y\'\n--[==[ block ]==]\nreturn M\n';
const LUA_B = 'local N = {}\nfunction N.go() return N.stop() end\nfunction N.stop() end\nreturn N\n';

/** A small valid sample per bundled grammar, by wasm file name. */
const SAMPLES: Record<string, string> = {
  bash: 'f() { echo "$x"; }\n',
  c: 'int main() { return 0; }\n',
  c_sharp: 'class A { void F() { var s = $"x{1}"; } }\n',
  cpp: 'int main() { return 0; }\n',
  dart: 'void main() { var s = "a"; }\n',
  elixir: 'defmodule A do\n  def f, do: "x"\nend\n',
  fish: 'function f\n  echo "x"\nend\n',
  go: 'package main\nfunc main() { s := `x` }\n',
  java: 'class A { void f() { String s = "x"; } }\n',
  javascript: 'const s = `a${1}`; function f() { return 1; }\n',
  kotlin: 'fun f(): String { return "a${1}" }\n',
  lua: LUA_A,
  pascal: 'program A; begin end.\n',
  php: '<?php\nfunction f() { return "a"; }\n',
  python: 'def f(x):\n    if x:\n        return "a"\n    return 1\n',
  ruby: 'class A\n  def f\n    "x#{1}"\n  end\nend\n',
  rust: 'fn main() { let s = r#"x"#; }\n',
  scala: 'object A { def f = "x" }\n',
  svelte: '<div>{x}</div>\n',
  swift: 'func f() -> String { return "a\\(1)" }\n',
  tsx: 'const A = () => <div>{1}</div>;\n',
  typescript: 'const s: string = `a${1}`;\n',
  zig: 'pub fn main() void { const s = "x"; }\n',
};
/**
 * Grammars not exercised, with the reason. tree-sitter-vue.wasm throws "resolved is not a function"
 * (a missing import) on `{{ }}`. VueParser does not use it (it parses scripts with the TypeScript
 * grammar and templates itself); only the parse worker's fallback loads it, when VueParser throws
 * (parse-worker.ts), and that fallback then yields no symbols.
 */
const EXCLUDED: Record<string, string> = { vue: 'loaded only by the parse worker fallback; throws on interpolation' };

describe('grammar health (M4-27)', () => {
  const wasmNames = readdirSync(join(__dirname, '..', 'wasm'))
    .filter((f) => /^tree-sitter-.+\.wasm$/.test(f))
    .map((f) => f.replace(/^tree-sitter-|\.wasm$/g, ''));

  it('has a sample, or a stated exclusion, for every bundled grammar', () => {
    expect(wasmNames.filter((n) => !SAMPLES[n] && !EXCLUDED[n])).toEqual([]);
  });

  it('parses every sample three times alike, without errors, after all grammars are loaded', async () => {
    const languages = Object.values(getBuiltinLanguages()).filter((l) => l.grammarWasm);
    const byWasm = new Map(languages.map((l) => [l.grammarWasm.replace(/^.*tree-sitter-|\.wasm$/g, ''), l]));
    const loaded = new Map<string, Awaited<ReturnType<typeof loadLanguage>>>();
    for (const name of wasmNames) if (byWasm.has(name) && !EXCLUDED[name]) loaded.set(name, await loadLanguage(byWasm.get(name)!));
    const failures: string[] = [];
    for (const [name, language] of loaded) {
      const trees = [0, 1, 2].map(() => getPooledParser(language).parse(SAMPLES[name]!)!.rootNode);
      if (trees.some((t) => t.hasError)) failures.push(`${name}: error node`);
      else if (new Set(trees.map((t) => t.toString())).size !== 1) failures.push(`${name}: trees differ`);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it('gives every Lua file its references, whatever was parsed before it', async () => {
    const parser = getParserForFile('src/a.lua');
    const java = getParserForFile('src/A.java');
    const targets = [];
    for (const [path, source] of [['src/a.lua', LUA_A], ['src/a.lua', LUA_A], ['src/b.lua', LUA_B], ['src/A.java', SAMPLES.java!], ['src/a.lua', LUA_A]] as const) {
      const result = await (path.endsWith('.java') ? java : parser).parse(path, source);
      if (path.endsWith('.lua')) targets.push(result.references.map((r) => r.targetName).join(','));
    }
    expect(targets).toEqual(['M.bar', 'M.bar', 'N.stop', 'M.bar']);
  });
});

describe('a scan of several Lua files (M4-27)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'lua', version: '1.0.0' }),
      'src/a.lua': LUA_A,
      'src/b.lua': LUA_B,
      'src/c.lua': 'local C = {}\nfunction C.run() return C.done() end\nfunction C.done() end\nreturn C\n',
    });
    init(root);
    // Main-thread parsing, where the leak showed first; workers parse several files each too.
    mapx(root, 'scan', '.');
  }, 120_000);
  afterAll(() => cleanup(root));

  it('gives each file its call edge', () => {
    const edges = query<{ source_file: string; source_symbol: string; target_symbol: string }>(root,
      "SELECT source_file, source_symbol, target_symbol FROM edges WHERE edge_type = 'call' ORDER BY 1, 2");
    expect(edges.map((e) => `${e.source_file} ${e.source_symbol} -> ${e.target_symbol}`)).toEqual([
      'src/a.lua M.foo -> M.bar',
      'src/b.lua N.go -> N.stop',
      'src/c.lua C.run -> C.done',
    ]);
  });
});
