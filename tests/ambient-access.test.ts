import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';
import { getParserForFile } from '../src/parsers/parser-registry.js';

// M5-24-R1: ambient access (the environment, the command line, browser globals, PHP superglobals) is
// extracted as a file's `ambient` list; the scanner stores each as an external reference of origin
// ambient (tests/external-refs.test.ts holds the labelled fixture rows and the selectors). Here the
// precision rules, one language at a time, on the real parsers: what shadows a global, and what only
// names it.

/** `line element access` of each ambient access of a source text, in a stable order. */
async function ambient(path: string, source: string): Promise<string[]> {
  const result = await getParserForFile(path).parse(path, source);
  return (result.ambient ?? []).map((a) => `${a.line} ${a.name} ${a.text}`).sort();
}
const at = (...expected: string[]) => [...expected].sort();

describe('JS/TS ambient access', () => {
  it('process.env, and the browser globals window, document, globalThis and localStorage', async () => {
    expect(await ambient('a.ts', [
      'export const port = process.env.PORT;', // 1
      'export const { HOME } = process.env;', // 2
      'export const html = document.title + window.name;', // 3
      'export const host = globalThis.location?.host ?? localStorage.getItem("h");', // 4
      'export const both = { window, document };', // 5
    ].join('\n'))).toEqual(at(
      '1 env process.env', '2 env process.env', '3 document document', '3 window window',
      '4 globalThis globalThis', '4 localStorage localStorage', '5 window window', '5 document document',
    ));
  });

  it('a name the file binds is not the global: parameter, local, loop and catch variable, import, function, class', async () => {
    const source = [
      'import { document as page } from "./page";', // 1: the imported name `document` is no use
      'import window from "./win";', // 2: binds window
      'export function a(document: unknown) { return document; }', // 3
      'export function b() { const localStorage = new Map(); return localStorage; }', // 4
      'export function c() { for (const globalThis of []) { return globalThis; } }', // 5
      'export function d() { try { return 1; } catch (document) { return document; } }', // 6
      'export const e = (process: { env: string }) => process.env;', // 7
      'export function f() { var window = 1; { return window; } }', // 8: hoisted var
      'function g() { return page; }', // 9: not an access either
      'export const h = window;', // 10: the import above
      'export class document2 {}', // 11
      'export function i() { function localStorage() {} return localStorage(); }', // 12
      'export function j(...args: unknown[]) { class document {} return new document(); }', // 13
    ].join('\n');
    expect(await ambient('a.ts', source)).toEqual([]);
    // The same name used outside the binding's scope is still the global.
    expect(await ambient('b.ts', [
      'export function a(document: unknown) { return document; }',
      'export const b = document.title;', // 2
      'export function c() { { const window = 1; } return window; }', // 3: block-scoped const
    ].join('\n'))).toEqual(['2 document document', '3 window window']);
  });

  it('process imported from node:process or process is the global module; from another module it is not', async () => {
    expect(await ambient('a.ts', 'import process from "node:process";\nexport const a = process.env.A;')).toEqual(['2 env process.env']);
    expect(await ambient('a.ts', 'import * as process from "process";\nexport const a = process.env.A;')).toEqual(['2 env process.env']);
    expect(await ambient('a.js', 'const process = require("node:process");\nexports.a = process.env.A;')).toEqual(['2 env process.env']);
    expect(await ambient('a.ts', 'import process from "./fake-process";\nexport const a = process.env.A;')).toEqual([]);
    expect(await ambient('a.js', 'const process = loadFake();\nexports.a = process.env.A;')).toEqual([]);
  });

  it('a comment, a string, a template text, a property name, a type position and a declare statement are no use', async () => {
    expect(await ambient('a.ts', [
      '// window, document and process.env',
      'export const a = "window document process.env";',
      'export const b = `the ${1} globalThis`;',
      'export const c = { window: 1, document: 2 }.window;',
      'export const d = foo.localStorage + foo.window;',
      'declare const globalThis2: typeof window;',
      'declare global { const document: Document }',
      'export type T = typeof globalThis;',
    ].join('\n'))).toEqual([]);
    // A template expression is code.
    expect(await ambient('a.ts', 'export const b = `home: ${process.env.HOME}`;')).toEqual(['1 env process.env']);
  });
});

describe('JS/TS ambient access (review of M5-24-R1)', () => {
  it('a parameter name in an overload, an abstract method or a signature is a declaration, and so is export * as window', async () => {
    expect(await ambient('a.ts', [
      'export abstract class A { abstract m(document: string): void }',
      'export class B { m(document: string): void; m(document: number): void; m(document: any) { return document } }',
      'export function f(document: string): void;',
      'export function f(document: number): void;',
      'export function f(document: any) { return 1 }',
      'export class C { constructor(window: string); constructor(window: any) { } }',
      'export interface I { new (window: Window): I; (document: Document): void; [window: string]: any }',
      'export * as window from "./w";',
    ].join('\n'))).toEqual([]);
  });

  it('process["env"], const { env } = process and import { env } from "node:process" are the environment', async () => {
    expect(await ambient('a.ts', 'export const a = process["env"].A;')).toEqual(['1 env process.env']);
    expect(await ambient('a.ts', 'export const { env } = process;')).toEqual(['1 env process.env']);
    expect(await ambient('a.ts', 'export const { env: e } = process;')).toEqual(['1 env process.env']);
    expect(await ambient('a.ts', 'import { env } from "node:process";\nexport const a = env.A;')).toEqual(['1 env process.env']);
    expect(await ambient('a.ts', 'import { env } from "./env";\nexport const a = env.A;')).toEqual([]);
    expect(await ambient('a.ts', 'export const { cwd } = process;')).toEqual([]);
    expect(await ambient('a.ts', 'export function f(process: any) { const { env } = process; return env; }')).toEqual([]);
  });
});

describe('PHP ambient access', () => {
  it('the superglobals and getenv(); $_ENV and getenv() are the env element', async () => {
    expect(await ambient('a.php', [
      '<?php',
      'function f() {',
      '  $a = $_GET["a"] ?? $_POST["a"];', // 3
      '  $b = $_SERVER["HOST"] . $_COOKIE["c"] . $_FILES["f"];', // 4
      '  $_SESSION["s"] = $GLOBALS["g"];', // 5
      '  return [$a, $b, $_ENV["E"], getenv("X"), \\getenv("Y"), $_REQUEST["r"]];', // 6
      '}',
    ].join('\n'))).toEqual(at(
      '3 $_GET $_GET', '3 $_POST $_POST', '4 $_SERVER $_SERVER', '4 $_COOKIE $_COOKIE', '4 $_FILES $_FILES',
      '5 $_SESSION $_SESSION', '5 $GLOBALS $GLOBALS', '6 env $_ENV', '6 env getenv', '6 env getenv', '6 $_REQUEST $_REQUEST',
    ));
  });

  it('a superglobal in a comment, a single-quoted string or a nowdoc, and a method named getenv, are no access', async () => {
    expect(await ambient('a.php', [
      '<?php',
      '// $GLOBALS and $_GET',
      '/* $_POST */',
      'class C {',
      '  function f($o) {',
      '    $a = \'$GLOBALS\';',
      '    $b = "the \\$_GET array";',
      "    $d = <<<'EOT'",
      '    $_FILES',
      'EOT;',
      '    return $o->getenv("X") . self::getenv("Y") . $this->_GET;',
      '  }',
      '}',
    ].join('\n'))).toEqual([]);
  });

  it('PHP reads a superglobal in a double-quoted string, a heredoc and a backtick string', async () => {
    expect(await ambient('a.php', [
      '<?php',
      '$a = "id=$_GET[id]";', // 2
      '$b = "{$_SERVER[\'HOST\']}";', // 3
      '$c = <<<EOT',
      'x $_POST[x] y', // 5
      'EOT;',
      '$d = `ls $_COOKIE[x]`;', // 7
      '$e = "the \\$_FILES array and $GLOBALS";', // 8: the escaped one is text
    ].join('\n'))).toEqual(at('2 $_GET $_GET', '3 $_SERVER $_SERVER', '5 $_POST $_POST', '7 $_COOKIE $_COOKIE', '8 $GLOBALS $GLOBALS'));
  });

  it('getenv() is the global function: not a namespace\'s own, not a use function of another', async () => {
    expect(await ambient('a.php', '<?php\nnamespace App;\n$a = getenv("X");\n$b = \\getenv("Y");')).toEqual(at('3 env getenv', '4 env getenv'));
    expect(await ambient('a.php', '<?php\nnamespace App;\nuse function Acme\\getenv;\n$a = getenv("X");\n$b = \\getenv("Y");')).toEqual(at('5 env getenv'));
    expect(await ambient('a.php', '<?php\nnamespace A { $a = getenv("X"); }\nnamespace B { $b = getenv("Y"); }')).toEqual(at('2 env getenv', '3 env getenv'));
  });
});

describe('Python ambient access', () => {
  it('os.environ, os.getenv and sys.argv, by the import that binds os and sys, under any alias', async () => {
    expect(await ambient('a.py', [
      'import os',
      'import sys as system',
      'import os.path',
      'from os import environ as env_map, getenv',
      'from sys import argv',
      'def f():',
      '    a = os.environ["A"] + os.getenv("B", "")', // 7
      '    return system.argv[1:], env_map["C"], getenv("D"), argv', // 8
    ].join('\n'))).toEqual(at(
      '7 env os.environ', '7 env os.getenv', '8 argv sys.argv', '8 env os.environ', '8 env os.getenv', '8 argv sys.argv',
    ));
  });

  it('os and sys must be the modules: a parameter, a local, no import, an attribute or a string is not', async () => {
    expect(await ambient('a.py', [
      'import os',
      'import sys',
      'def a(os):',
      '    return os.environ',
      'def b():',
      '    sys = object()',
      '    return sys.argv',
      'class C:',
      '    environ = {}',
      '    def m(self):',
      '        return self.environ, self.os.environ',
      'def c():',
      '    return "os.environ sys.argv"  # os.getenv',
      'def getenv():',
      '    return 1',
      'x = getenv()',
    ].join('\n'))).toEqual([]);
    expect(await ambient('b.py', 'def f():\n    return os.environ, sys.argv')).toEqual([]);
    // A function-scope import counts in that function only.
    expect(await ambient('c.py', 'def f():\n    import os\n    return os.environ\ndef g():\n    return os.environ')).toEqual(['3 env os.environ']);
  });
});

describe('Python ambient access (review of M5-24-R1)', () => {
  it('a comprehension variable named os belongs to the comprehension; os = None after a failed import binds nothing', async () => {
    expect(await ambient('a.py', 'import os\nx = [os for os in range(3)]\ny = os.environ')).toEqual(['3 env os.environ']);
    expect(await ambient('a.py', 'import os\nx = [os.environ for os in range(3)]')).toEqual([]);
    expect(await ambient('a.py', 'try:\n    import os\nexcept ImportError:\n    os = None\nx = os.environ')).toEqual(['5 env os.environ']);
    expect(await ambient('a.py', 'import os\nos = {}\nx = os.environ')).toEqual([]);
  });
});

describe('Go ambient access', () => {
  it('os.Getenv, os.LookupEnv, os.Environ and os.Args, under the import alias', async () => {
    expect(await ambient('a.go', [
      'package p',
      'import system "os"',
      'func f() {',
      '\t_ = system.Getenv("A")', // 4
      '\t_, _ = system.LookupEnv("B")', // 5
      '\t_ = system.Environ()', // 6
      '\t_ = system.Args', // 7
      '}',
    ].join('\n'))).toEqual(['4 env os.Getenv', '5 env os.LookupEnv', '6 env os.Environ', '7 argv os.Args']);
  });

  it('os must be the import of "os": a parameter, a local, another package, a dot or blank import, a string is not', async () => {
    expect(await ambient('a.go', [
      'package p',
      'import "os"',
      'type t struct{}',
      'func (t) Getenv(string) string { return "" }',
      'func a(os t) string { return os.Getenv("A") }',
      'func b() string { os := t{}; return os.Getenv("B") }',
      'func c() string { return "os.Args" } // os.Getenv',
      'func d() int { return os.Getpid() }',
    ].join('\n'))).toEqual([]);
    expect(await ambient('b.go', 'package p\nimport "example.com/os"\nfunc f() { _ = os.Getenv("A") }')).toEqual([]);
    expect(await ambient('c.go', 'package p\nimport _ "os"\nimport . "os"\nfunc f() { _ = Getenv("A") }')).toEqual([]);
    expect(await ambient('d.go', 'package p\nfunc f() { _ = os.Getenv("A") }')).toEqual([]);
  });
});

describe('Go ambient access (review of M5-24-R1)', () => {
  it('os.Setenv, Unsetenv, ExpandEnv and Clearenv are the environment; a block-scoped os hides only its block', async () => {
    expect(await ambient('a.go', [
      'package p',
      'import "os"',
      'func f() {',
      '\t_ = os.Setenv("A", "b")', // 4
      '\t_ = os.Unsetenv("A")', // 5
      '\t_ = os.ExpandEnv("$A")', // 6
      '\tos.Clearenv()', // 7
      '}',
    ].join('\n'))).toEqual(at('4 env os.Setenv', '5 env os.Unsetenv', '6 env os.ExpandEnv', '7 env os.Clearenv'));
    expect(await ambient('a.go', [
      'package p',
      'import "os"',
      'type t struct{ Args int }',
      'func f(c bool) int {',
      '\tif c {',
      '\t\tos := t{}', // 6
      '\t\t_ = os.Args', // 7: the local
      '\t}',
      '\tfor _, os := range []t{} {', // 9
      '\t\t_ = os.Args', // 10: the loop variable
      '\t}',
      '\t_ = os.Args', // 12: the package
      '\treturn len(os.Args)', // 13
      '}',
    ].join('\n'))).toEqual(at('12 argv os.Args', '13 argv os.Args'));
    // A declaration shadows only after it.
    expect(await ambient('b.go', 'package p\nimport "os"\nfunc f() {\n\t_ = os.Args\n\tos := 1\n\t_ = os\n}')).toEqual(['4 argv os.Args']);
  });
});

describe('ambient access in the index (e2e)', () => {
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) cleanup(r); });
  const rows = (root: string) => query<{ file_path: string; line: number; source_symbol: string | null; specifier: string; symbol: string | null; kind: string; package: string; origin: string; direct: number | null; dev: number | null; attribution: string | null }>(
    root, "SELECT file_path, line, source_symbol, specifier, symbol, kind, package, origin, direct, dev, attribution FROM external_refs WHERE origin = 'ambient' ORDER BY file_path, line, specifier")
    .map((r) => `${r.file_path}:${r.line} ${r.source_symbol} ${r.specifier} ${r.kind} -> ${r.package} ${r.origin} ${r.direct} ${r.dev} ${r.attribution}`);

  it('is an external reference of origin ambient, never an edge; sync adds, moves and drops it with the file', () => {
    const root = workspace({
      'package.json': '{"name":"a","dependencies":{}}',
      'src/config.ts': 'export function port(): number {\n  return Number(process.env.PORT);\n}\n',
      'src/page.ts': 'export function title(): string {\n  return document.title;\n}\n',
      'app.php': '<?php\nfunction request() {\n  return $_GET["q"];\n}\n',
      'tool.py': 'import os\n\ndef home():\n    return os.environ["HOME"]\n',
      'main.go': 'package main\n\nimport "os"\n\nfunc args() []string {\n\treturn os.Args\n}\n',
    });
    roots.push(root);
    init(root);
    mapx(root, 'scan');
    expect(rows(root)).toEqual([
      'app.php:3 request $_GET call -> $_GET ambient null null null',
      'main.go:6 args os.Args call -> argv ambient null null null',
      'src/config.ts:2 port process.env call -> env ambient null null null',
      'src/page.ts:2 title document call -> document ambient null null null',
      'tool.py:4 home os.environ call -> env ambient null null null',
    ]);
    // Ambient access is not an edge: every edge stays between indexed files.
    expect(query(root, 'SELECT source_file, target_file FROM edges WHERE target_file NOT IN (SELECT path FROM files)')).toEqual([]);

    // The file moves the access down a line and gains one; another loses its access.
    writeFileSync(`${root}/src/config.ts`, '// config\nexport function port(): number {\n  return Number(process.env.PORT) || Number(process.env.FALLBACK);\n}\n');
    writeFileSync(`${root}/src/page.ts`, 'export function title(): string {\n  const document = { title: "x" };\n  return document.title;\n}\n');
    mapx(root, 'sync');
    expect(rows(root)).toEqual([
      'app.php:3 request $_GET call -> $_GET ambient null null null',
      'main.go:6 args os.Args call -> argv ambient null null null',
      'src/config.ts:3 port process.env call -> env ambient null null null',
      'tool.py:4 home os.environ call -> env ambient null null null',
    ]);
  }, 240000);

  it('a PHP getenv() is the global function unless the namespace declares its own', () => {
    const root = workspace({
      'composer.json': '{"autoload":{"psr-4":{"App\\\\":"app/"}}}',
      'app/helpers.php': '<?php\nnamespace App;\nfunction getenv($k) { return $k; }\n',
      'app/Own.php': '<?php\nnamespace App;\nclass Own {\n  function a() { return getenv("X"); }\n  function b() { return \\getenv("Y"); }\n}\n',
      'lib/Plain.php': '<?php\nnamespace Lib;\nclass Plain {\n  function a() { return getenv("X"); }\n}\n',
    });
    roots.push(root);
    init(root);
    mapx(root, 'scan');
    expect(rows(root)).toEqual([
      'app/Own.php:5 Own::b getenv call -> env ambient null null null',
      'lib/Plain.php:4 Plain::a getenv call -> env ambient null null null',
    ]);
  }, 240000);
});
