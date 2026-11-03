import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';
import { jsExportSignature, scanModule } from '../src/core/js-source.js';

// M2-09: a function assigned to a member (`obj.m = function`, `obj.m = () =>`,
// `Foo.prototype.bar = function`) is a method of `obj` / `Foo`; `exports.f = function` is the
// module's function `f`, scope `exports`, reached through the module and never as a lexical `f`.
// Members assigned other values, `this.x = …` and local objects are not symbols. Name lookup ranks
// member-assigned functions below declarations. Labelled synthetic fixtures, written for this test.
type Sym = { name: string; kind: string; scope: string | null; start_line: number };
type Edge = { source_file?: string; source_symbol: string | null; target_file: string; target_symbol: string };
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' });

describe('JS/TS member-assigned functions (real scan)', () => {
  let root: string;
  const symbolsOf = (file: string) =>
    query<Sym>(root, 'SELECT name, kind, scope, start_line FROM symbols WHERE file_path = ? ORDER BY start_line, name', file)
      .map((s) => `${s.start_line} ${s.kind} ${s.scope ? `${s.scope}::` : ''}${s.name}`);
  const callsFrom = (file: string) =>
    query<Edge>(root, `SELECT source_symbol, target_file, target_symbol FROM edges
      WHERE edge_type = 'call' AND source_file = ? ORDER BY 1, 2, 3`, file)
      .map((e) => `${e.source_symbol} -> ${e.target_file}#${e.target_symbol}`);

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'src/api.js': [
        'const api = {};',
        'api.get = function (url) { return fetchJson(url); };',
        'api.post = (url, body) => fetchJson(url, body);',
        'api.stream = function* (url) { yield fetchJson(url); };',
        'api.count = 1;',
        'api.handler = other.fn;',
        'function Foo() { this.x = () => helper(); }',
        'Foo.prototype.bar = function () { return helper(); };',
        'function helper() { return 2; }',
        'function fetchJson(u) { return u; }',
        'module.exports.limit = helper;',
        'exports.ping = function () { return helper(); };',
        'module.exports.pong = () => helper();',
        'function make() { const o = {}; o.run = function () { return 1; }; return o; }',
        'if (api) { api.later = () => 1; }',
        'a.b.c = function () {};',
        "api['computed'] = function () {};",
        '(function () { Baz.prototype.qux = function () { return helper(); }; })();',
        'module.exports = { api, Foo };',
        '',
      ].join('\n'),
      'src/single.js': 'module.exports = function () { return 1; };\n',
      // Declared decoys of the member and imported names, which name lookup would pick (P2-d).
      'src/decoy.js': 'function post() { return 0; }\nfunction ping() { return 0; }\nfunction load() { return 0; }\nfunction fetchData() { return 0; }\nmodule.exports = { post, ping, load, fetchData };\n',
      'src/main.js': [
        "const { api, Foo } = require('./api');",
        "const m = require('./api');",
        "function viaMember() { return api.post('/a', {}); }",
        'function viaPrototype() { const foo = new Foo(); return foo.bar(); }',
        'function viaExports() { return m.ping(); }',
        "function viaInline() { return require('./api').ping(); }",
        'function bareExportName() { return pong(); }',
        'module.exports = { viaMember, viaPrototype, viaExports, viaInline, bareExportName };',
        '',
      ].join('\n'),
      'src/svc.ts': [
        'export const svc: any = {};',
        'svc.load = async function (id: string): Promise<string> { return format(id); };',
        'svc.save = (x: number): number => x;',
        'export class Repo {}',
        'Repo.prototype.lookup = function (this: Repo, id: string) { return format(id); };',
        'svc.size = 3;',
        'function format(s: string) { return s; }',
        '',
      ].join('\n'),
      'src/use.ts': [
        "import { svc, Repo } from './svc';",
        "export function go() { return svc.load('1'); }",
        "export function byId(r: Repo) { return r.lookup('1'); }",
        '',
      ].join('\n'),
      // Review P1-a: `exports.fetchData` binds no lexical `fetchData`.
      'src/lib.js': 'function fetchData(id) { return id; }\nmodule.exports = { fetchData };\n',
      'src/wrapper.js': [
        "const { fetchData } = require('./lib');",
        "const lib = require('./lib');",
        'exports.fetchData = function (id) { return fetchData(id); };',
        'exports.load = function () { return lib.fetchData(1); };',
        'function other() { return fetchData(2); }',
        'module.exports.other = other;',
        '',
      ].join('\n'),
      'src/consumer.js': "const w = require('./wrapper');\nfunction viaWrapper() { return w.fetchData(1); }\nmodule.exports = { viaWrapper };\n",
      'src/fsw.js': "const { readFile } = require('fs');\nexports.readFile = function (p) { return readFile(p, 'utf8'); };\n",
      // Review P2-a: a member-assigned function must not take a call from a declared method.
      'src/svc/user.ts': [
        'export class UserService {',
        '  start(): void { this.connect(); }',
        '  connect(): void {}',
        '}',
        '',
      ].join('\n'),
      'src/svc/Cart.js': 'export class Cart {\n  update(item) { return item; }\n}\n',
      'src/legacy/hooks.js': 'var hooks = {};\nhooks.start = function () { return hooks.stop(); };\nhooks.stop = function () { return 0; };\nmodule.exports = hooks;\n',
      'src/legacy/widget.js': 'function Widget(el) { this.el = el; }\nWidget.prototype.update = function (v) { this.el = v; };\nmodule.exports = Widget;\n',
      'src/ui/admin.ts': "import { UserService } from '../svc/user';\nexport function boot(s: UserService) { s.start(); }\n",
      'src/ui/page.js': [
        "import { Cart } from '../svc/Cart.js';",
        "const hooks = require('../legacy/hooks');",
        'export function mount() {',
        '  const cart = new Cart();',
        '  cart.update({ id: 1 });',
        '  return hooks.start();',
        '}',
        '',
      ].join('\n'),
      // Review P2-b: a member the file already declares, and a repeated assignment.
      'src/dup.js': [
        'const store = { get() { return 1; }, save() { return 2; } };',
        'store.save = function () { return 3; };',
        'class Klass { size() { return 1; } }',
        'Klass.prototype.size = function () { return 2; };',
        'function wrap() { return 1; }',
        'exports.wrap = function () { return wrap(); };',
        'exports.twice = function () { return 1; };',
        'exports.twice = function () { return 2; };',
        '',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120_000);
  afterAll(() => cleanup(root));

  it('gives a method of the object or prototype owner for each function member, and nothing for other members', () => {
    expect(symbolsOf('src/api.js')).toEqual([
      '1 constant api',
      '2 method api::get',
      '3 method api::post',
      '4 method api::stream',
      '7 function Foo',
      '8 method Foo::bar',
      '9 function helper',
      '10 function fetchJson',
      '12 function exports::ping',
      '13 function exports::pong',
      '14 function make',
      '18 method Baz::qux',
    ]);
    expect(symbolsOf('src/single.js')).toEqual([]);
  });

  it('does the same in TypeScript', () => {
    expect(symbolsOf('src/svc.ts')).toEqual([
      '1 constant svc',
      '2 method svc::load',
      '3 method svc::save',
      '4 class Repo',
      '5 method Repo::lookup',
      '7 function format',
    ]);
  });

  it('keeps one symbol per scope and name: the declared member, else the first assignment', () => {
    expect(symbolsOf('src/dup.js')).toEqual([
      '1 method store::get',
      '1 method store::save',
      '1 constant store',
      '3 class Klass',
      '3 method Klass::size',
      '5 function wrap',
      '6 function exports::wrap',
      '7 function exports::twice',
    ]);
  });

  it('signs a member function with its target and its value up to the body', () => {
    const signatures = query<{ scope: string; name: string; signature: string }>(root, `SELECT scope, name, signature FROM symbols
      WHERE file_path IN ('src/api.js', 'src/svc.ts') AND scope IS NOT NULL AND kind IN ('method', 'function')
      ORDER BY file_path, start_line`).map((s) => `${s.scope}::${s.name} ${s.signature}`);
    expect(signatures).toEqual([
      'api::get api.get = function (url)',
      'api::post api.post = (url, body) =>',
      'api::stream api.stream = function* (url)',
      'Foo::bar Foo.prototype.bar = function ()',
      'exports::ping exports.ping = function ()',
      'exports::pong module.exports.pong = () =>',
      'Baz::qux Baz.prototype.qux = function ()',
      'svc::load svc.load = async function (id: string): Promise<string>',
      'svc::save svc.save = (x: number): number =>',
      'Repo::lookup Repo.prototype.lookup = function (this: Repo, id: string)',
    ]);
  });

  it('attributes the calls in a member function\'s body to that member', () => {
    expect(callsFrom('src/api.js')).toEqual([
      'Baz::qux -> src/api.js#helper',
      'Foo -> src/api.js#helper',
      'Foo::bar -> src/api.js#helper',
      'api::get -> src/api.js#fetchJson',
      'api::post -> src/api.js#fetchJson',
      'api::stream -> src/api.js#fetchJson',
      'exports::ping -> src/api.js#helper',
      'exports::pong -> src/api.js#helper',
    ]);
    expect(callsFrom('src/svc.ts')).toEqual([
      'Repo::lookup -> src/svc.ts#format',
      'svc::load -> src/svc.ts#format',
    ]);
  });

  // `api.get()` itself links nothing: `get` is a built-in method name, skipped on an untyped
  // receiver (M0-01-R1), so these calls use other names. src/decoy.js declares `post`, `ping` and
  // `load`, so name lookup alone would pick it: the imports decide.
  it('links obj.method(), a prototype method call and a CommonJS export call from another file through its imports', () => {
    expect(callsFrom('src/main.js')).toEqual([
      'viaExports -> src/api.js#ping',
      // `require('./api').ping()`: the module's export, through the specifier (M2-20).
      'viaInline -> src/api.js#ping',
      'viaMember -> src/api.js#post',
      'viaPrototype -> src/api.js#bar',
    ]);
    expect(callsFrom('src/use.ts')).toEqual([
      'byId -> src/svc.ts#lookup',
      'go -> src/svc.ts#load',
    ]);
  });

  it('never links a bare name to an exports.f function', () => {
    // `pong()` names no lexical binding: exports.pong is reached only through its module. (An inline
    // `require('./api').ping()` had no reference before M2-20; it now links the module's export, above.)
    const main = callsFrom('src/main.js');
    expect(main.filter((e) => e.startsWith('bareExportName'))).toEqual([]);
  });

  it('keeps an imported name over the file\'s own exports.f of that name (review P1-a)', () => {
    expect(callsFrom('src/wrapper.js')).toEqual([
      'exports::fetchData -> src/lib.js#fetchData',
      'exports::load -> src/lib.js#fetchData',
      'other -> src/lib.js#fetchData',
    ]);
    expect(callsFrom('src/consumer.js')).toEqual(['viaWrapper -> src/wrapper.js#fetchData']);
    // `readFile` from a built-in module: no edge at all, never a self-edge.
    expect(callsFrom('src/fsw.js')).toEqual([]);
  });

  it('keeps a declared method over a member-assigned one of the same name (review P2-a)', () => {
    expect(callsFrom('src/ui/admin.ts')).toEqual(['boot -> src/svc/user.ts#start']);
    // `hooks` is the module's `module.exports = hooks`: its assigned member.
    expect(callsFrom('src/ui/page.js')).toEqual([
      'mount -> src/legacy/hooks.js#start',
      'mount -> src/svc/Cart.js#update',
    ]);
    expect(callsFrom('src/legacy/hooks.js')).toEqual(['hooks::start -> src/legacy/hooks.js#stop']);
    // A call in a method is the method's, not its class's.
    expect(callsFrom('src/svc/user.ts')).toEqual(['UserService::start -> src/svc/user.ts#connect']);
  });

  it('opens obj.method, Foo.method and exports.f with mapx node', () => {
    const node = (name: string) => {
      const r = JSON.parse(mapx(root, 'node', name, '--dir', root, '--format', 'json'));
      return `${r.file ?? r.file_path}:${r.startLine ?? r.start_line} ${r.scope ? `${r.scope}::` : ''}${r.name}`;
    };
    expect(node('api.get')).toBe('src/api.js:2 api::get');
    expect(node('Foo.bar')).toBe('src/api.js:8 Foo::bar');
    expect(node('svc::load')).toBe('src/svc.ts:2 svc::load');
    expect(node('exports.ping')).toBe('src/api.js:12 exports::ping');
    expect(node('pong')).toBe('src/api.js:13 exports::pong');
    expect(node('wrap')).toBe('src/dup.js:5 wrap');
  });
});

describe('export signature of member assignments (M2-08-R1 interaction)', () => {
  const sig = (text: string) => jsExportSignature(scanModule('src/api.js', text));
  const base = 'const api = {};\napi.get = function (url) { return fetchJson(url); };\nexports.ping = () => { return 1; };\n';
  const iife = 'export function Baz() {}\n(function () { Baz.prototype.one = function () { return 1; }; })();\n';

  it('changes when a member function is added or renamed, and not when only its body changes', () => {
    expect(sig(base.replace('fetchJson(url)', 'fetchJson(url, 1)'))).toBe(sig(base));
    expect(sig(base.replace('return 1', 'return 2'))).toBe(sig(base));
    expect(sig(base.replace('api.get', 'api.fetch'))).not.toBe(sig(base));
    expect(sig(`${base}api.put = () => 1;\n`)).not.toBe(sig(base));
    expect(sig(base.replace('exports.ping', 'exports.pong'))).not.toBe(sig(base));
  });

  it('changes when a function body (an IIFE) gains a member function (review P1-b)', () => {
    expect(sig(iife.replace('return 1', 'return 2'))).toBe(sig(iife));
    expect(sig(iife.replace('})();', 'Baz.prototype.quux = function () { return 2; }; })();'))).not.toBe(sig(iife));
    expect(sig(iife.replace('})();', 'Baz.prototype.quux = async (a) => a; })();'))).not.toBe(sig(iife));
  });
});

// Review P1-b (D032): a member function added inside an IIFE re-links the module's importers on sync.
describe.each([['git', true], ['hash', false]])('%s sync of a member function added in an IIFE', (_mode, useGit) => {
  let root: string;
  beforeEach(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'src/a.js': 'export function Baz() {}\n(function () { Baz.prototype.one = function () { return 1; }; })();\n',
      'src/b.js': "import { Baz } from './a';\nexport function u() { const b = new Baz(); return b.quux(); }\n",
    });
    if (useGit) {
      git(root, 'init', '-q');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
    }
    init(root);
    mapx(root, 'scan', '.');
  }, 120_000);
  afterEach(() => cleanup(root));

  const all = () => query<Edge>(root, `SELECT source_file, source_symbol, target_file, target_symbol FROM edges
    WHERE edge_type IN ('call', 'instantiation') ORDER BY 1, 2, 3, 4`);

  it('links the importer\'s call to the new member and ends equal to scan --force', () => {
    const quux = () => all().filter((e) => e.target_symbol === 'quux').map((e) => `${e.source_file}#${e.source_symbol} -> ${e.target_file}`);
    expect(quux()).toEqual([]);
    writeFileSync(join(root, 'src/a.js'), 'export function Baz() {}\n(function () {\n  Baz.prototype.one = function () { return 1; };\n  Baz.prototype.quux = function () { return 2; };\n})();\n');
    // The edited module and its importer.
    expect(/Updated (\d+) files/.exec(mapx(root, 'sync', '.'))?.[1]).toBe('2');
    expect(quux()).toEqual(['src/b.js#u -> src/a.js']);
    const synced = all();
    mapx(root, 'scan', '.', '--force');
    expect(synced).toEqual(all());
  }, 120_000);
});
