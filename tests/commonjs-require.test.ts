import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-20: a CommonJS `require` of a local module gives a file-to-file import edge and import-bound
// call edges, as an ES import does (found by M5-17-R1: an Express fixture had to use ES imports).
// `module.exports = …`, `module.exports.f = …` and `exports.f = …` are the module's exports; a
// package require stays external (M2-08-R3). decoy.js declares every name the app calls, so name
// lookup would pick it.
type Edge = { source_file: string; edge_type: string; target_file: string; target_symbol: string; verifiability: string };

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'cjs-app', version: '1.0.0', dependencies: { express: '^4.0.0' } }),
  'src/math.js': 'function sum(a, b) { return a + b; }\nfunction diff(a, b) { return a - b; }\nfunction mul(a, b) { return a * b; }\n'
    + 'module.exports = { sum, diff, times: mul, twice: function (x) { return 2 * x; }, half(x) { return x / 2; } };\n',
  'src/util.js': 'exports.formatName = function (x) { return String(x); };\nmodule.exports.parseQty = function parseQty(s) { return Number(s); };\n',
  'src/logger.js': 'class Logger {\n  write(m) { return m; }\n}\nmodule.exports = Logger;\n',
  'src/make.js': 'module.exports = function makeThing() { return 1; };\n',
  'src/widget.js': 'module.exports = class Widget {\n  spin() { return 1; }\n};\n',
  'src/decoy.js': ['sum', 'mul', 'twice', 'half', 'formatName', 'parseQty', 'write', 'spin', 'join', 'readFileSync', 'Router', 'makeThing', 'make', 'esmHelper', 'only', 'pick', 'diff', 'json']
    .map((n) => `function ${n}() { return 0; }\n`).join('') + 'class Logger {}\nclass Widget {}\nmodule.exports = { sum };\n',
  'src/app.js': `const express = require('express');
const fs = require('node:fs');
const { join } = require('node:path');
const { Router } = require('express');
const math = require('./math');
const { formatName } = require('../src/util');
const Logger = require('./logger');
const make = require('./make');
const Widget = require('./widget');
const pick = require('./math').diff;

function main(name) {
  const r = math.sum(1, 2);
  math.times(1, 2);
  math.twice(1);
  math.half(1);
  formatName(r);
  require('./util').parseQty('3');
  pick('4');
  require('express').json();
  join('a', 'b');
  Router();
  fs.readFileSync('x');
  new Logger().write('x');
  make();
  new Widget().spin();
  require(name);
  require('./' + name).only();
  load('./decoy');
  return express();
}
function load(path) { return path; }
module.exports = { main };
`,
  // A .cjs pair.
  'lib/a.cjs': "const { only } = require('./b.cjs');\nfunction runA() { return only(); }\nmodule.exports = { runA };\n",
  'lib/b.cjs': 'exports.only = () => 1;\n',
  // Mixed: an ES module importing CommonJS, and CommonJS requiring an ES module.
  'mixed/esm-lib.mjs': 'export function esmHelper() { return 1; }\n',
  'mixed/esm.mjs': "import Logger from '../src/logger.js';\nimport { formatName } from '../src/util.js';\nexport function viaEsm() { new Logger(); return formatName(1); }\n",
  'mixed/cjs.js': "const { esmHelper } = require('./esm-lib.mjs');\nfunction viaCjs() { return esmHelper(); }\nmodule.exports = { viaCjs };\n",
  // A require in TypeScript.
  'mixed/req.ts': "const { esmHelper } = require('./esm-lib.mjs');\nexport function viaTs() { return esmHelper(); }\n",
  // Barrels: a whole-module re-export, and a required name passed on.
  'barrel/index.js': "module.exports = require('../src/math');\n",
  'barrel/names.js': "const { formatName } = require('../src/util');\nconst Logger = require('../src/logger');\nmodule.exports = { formatName, Logger };\n",
  'barrel/use.js': "const lib = require('./index');\nconst { formatName: fmt, Logger } = require('./names');\nfunction viaBarrel() { lib.sum(1, 2); fmt(1); return new Logger(); }\nmodule.exports = { viaBarrel };\n",
};

const imports = (root: string, file: string) => query<Edge>(root,
  "SELECT DISTINCT target_file FROM edges WHERE source_file = ? AND edge_type IN ('import', 'require') ORDER BY 1", file).map((e) => e.target_file);

const calls = (root: string, file: string) => query<Edge>(root,
  "SELECT edge_type, target_file, target_symbol FROM edges WHERE source_file = ? AND edge_type NOT IN ('import', 'require') ORDER BY 1, 2, 3", file)
  .map((e) => `${e.edge_type} ${e.target_file}#${e.target_symbol}`);

describe('CommonJS require of a local module (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace(FILES);
    init(root);
    mapx(root, 'scan', root);
  }, 120_000);
  afterAll(() => cleanup(root));

  it('gives an import edge to each required project module, and none for a package or a computed specifier', () => {
    expect(imports(root, 'src/app.js')).toEqual(['src/logger.js', 'src/make.js', 'src/math.js', 'src/util.js', 'src/widget.js']);
    expect(imports(root, 'lib/a.cjs')).toEqual(['lib/b.cjs']);
    expect(imports(root, 'mixed/cjs.js')).toEqual(['mixed/esm-lib.mjs']);
    expect(imports(root, 'mixed/req.ts')).toEqual(['mixed/esm-lib.mjs']);
    expect(imports(root, 'barrel/index.js')).toEqual(['src/math.js']);
    // A top-level require is the file's, as an import is; one in a function is that function's.
    expect(query<{ s: string | null }>(root, "SELECT DISTINCT source_symbol AS s FROM edges WHERE source_file = 'src/app.js' AND edge_type = 'import' ORDER BY 1").map((r) => r.s))
      .toEqual([null, 'main']);
  });

  it('links destructured, whole-module, member and inline requires to the required module', () => {
    const app = calls(root, 'src/app.js');
    for (const edge of [
      'call src/math.js#sum', // math.sum(): module.exports = { sum }
      'call src/math.js#mul', // math.times(): { times: mul }
      'call src/math.js#half', // an object-literal method
      'call src/util.js#formatName', // const { formatName } = require(…): exports.formatName = …
      'call src/util.js#parseQty', // require('./util').parseQty()
      'call src/math.js#diff', // const pick = require('./math').diff
      'instantiation src/logger.js#Logger', // const Logger = require(…): module.exports = Logger
      'call src/logger.js#write', // new Logger().write() (M2-12)
      'call src/make.js#makeThing', // module.exports = function makeThing
      'call src/widget.js#spin', // module.exports = class Widget
    ]) expect(app).toContain(edge);
    // No same-named declaration elsewhere, and not the requiring file's own `const X = require(…)`.
    expect(app.filter((e) => e.includes('src/decoy.js') || /src\/app\.js#(Logger|make|Widget|math|pick)$/.test(e))).toEqual([]);
  });

  it('keeps a package or builtin require external', () => {
    expect(calls(root, 'src/app.js').filter((e) => /#(join|Router|readFileSync|express|json)$/.test(e))).toEqual([]);
    const rows = query<{ specifier: string; symbol: string | null; kind: string }>(root,
      "SELECT specifier, symbol, kind FROM external_refs WHERE file_path = 'src/app.js' ORDER BY line, kind").map((r) => `${r.kind} ${r.specifier}#${r.symbol}`);
    expect(rows).toEqual(expect.arrayContaining(['require express#Router', 'call express#Router', 'call node:path#join', 'call node:fs#readFileSync', 'call express#json']));
    expect(rows.some((r) => r.includes('./'))).toBe(false);
  });

  it('handles .cjs files and mixed ES and CommonJS modules', () => {
    expect(calls(root, 'lib/a.cjs')).toEqual(['call lib/b.cjs#only']);
    expect(calls(root, 'mixed/cjs.js')).toEqual(['call mixed/esm-lib.mjs#esmHelper']);
    expect(calls(root, 'mixed/req.ts')).toEqual(['call mixed/esm-lib.mjs#esmHelper']);
    // An ES default import of a CommonJS module is what `module.exports = X` exports.
    expect(calls(root, 'mixed/esm.mjs')).toEqual(['call src/util.js#formatName', 'instantiation src/logger.js#Logger']);
  });

  it('follows CommonJS re-export barrels', () => {
    expect(imports(root, 'barrel/use.js')).toEqual(['barrel/index.js', 'barrel/names.js']);
    expect(calls(root, 'barrel/use.js')).toEqual(['call src/math.js#sum', 'call src/util.js#formatName', 'instantiation src/logger.js#Logger']);
  });
});

describe('CommonJS require: sync re-links requirers (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'src/logger.js': 'class Logger {\n  write(m) { return m; }\n}\nmodule.exports = Logger;\n',
      'src/index.js': "module.exports = require('./logger');\n",
      'src/app.js': "const Logger = require('./logger');\nfunction main() { return new Logger(); }\nmodule.exports = { main };\n",
      'src/via.js': "const Log = require('./index');\nfunction viaBarrel() { return new Log(); }\nmodule.exports = { viaBarrel };\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120_000);
  afterAll(() => cleanup(root));

  const all = () => query<Edge>(root, 'SELECT source_file, edge_type, target_file, target_symbol FROM edges ORDER BY 1, 2, 3, 4')
    .map((e) => `${e.source_file} ${e.edge_type} ${e.target_file}#${e.target_symbol}`);

  it('re-links a requirer when the module it requires changes its exports, as scan --force does', () => {
    expect(calls(root, 'src/app.js')).toEqual(['instantiation src/logger.js#Logger']);
    expect(calls(root, 'src/via.js')).toEqual(['instantiation src/logger.js#Logger']);
    // The required module exports another class, keeping the first: its requirer, and the one behind
    // the barrel, re-link (no edge's target symbol disappears, so only the barrel walk finds via.js).
    writeFileSync(join(root, 'src/logger.js'), 'class Logger {\n  write(m) { return m; }\n}\nclass Journal {\n  write(m) { return m; }\n}\nmodule.exports = Journal;\n');
    mapx(root, 'sync', root);
    const synced = all();
    expect(calls(root, 'src/app.js')).toEqual(['instantiation src/logger.js#Journal']);
    expect(calls(root, 'src/via.js')).toEqual(['instantiation src/logger.js#Journal']);
    mapx(root, 'scan', root, '--force');
    expect(synced).toEqual(all());
  });
});
