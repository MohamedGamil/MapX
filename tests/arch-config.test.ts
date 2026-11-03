import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { init, mapx, mapxResult } from './helpers/e2e.js';
import { ConfigError, loadArchitectureConfig, validateArchitectureText } from '../src/arch/config.js';
import { ALLOWANCE_KEYS, LAYER_KEYS, POLICY_KEYS, REPORT_KEYS, SCOPE_KEYS, SELECTOR_KEYS, TOP_LEVEL_KEYS, UNCOVERED_KEYS, VISIBILITY_KEYS } from '../src/arch/schema.js';
import { stripJsonc } from '../src/core/js-aliases.js';

// M5-02: the architecture configuration loader (AR-11, AR-14, AR-05).
const F = resolve(__dirname, 'fixtures/arch-config');
const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected a ConfigError');
};
const doc = (body: object | string) => validateArchitectureText(typeof body === 'string' ? body : JSON.stringify(body), 'arch.jsonc');

describe('validation reports every problem at once, in document order', () => {
  it('four distinct errors give exactly four entries with JSON pointers', () => {
    const issues = validateArchitectureText(readFileSync(join(F, 'documents/four-errors.jsonc'), 'utf8'), 'four-errors.jsonc');
    expect(issues.map((i) => [i.pointer, i.message.split(';')[0]])).toEqual([
      ['/layers/0/selectors/0/paht', 'unknown selector key "paht"'],
      ['/layers/1/selectors/0/layer', 'unknown layer "Htttp"'],
      ['/rules/Http/0', 'unknown layer "Servce"'],
      ['/rules/Service/0', '"+" allowances form a cycle: Service → Repo → Service'],
    ]);
    expect(issues[1]!.message).toContain('did you mean "Http"?');
    expect(issues.every((i) => i.file === 'four-errors.jsonc')).toBe(true);
  });

  it('names a longer "+" cycle once, and a cycle through layer selectors', () => {
    const layers = ['A', 'B', 'C'].map((name) => ({ name, selectors: [{ path: `${name}/**` }] }));
    expect(doc({ layers, rules: { A: ['+B'], B: ['+C'], C: ['+A'] } }).map((i) => i.message)).toEqual(['"+" allowances form a cycle: A → B → C → A']);
    const selfRef = [{ name: 'X', selectors: [{ layer: 'Y' }] }, { name: 'Y', selectors: [{ layer: 'X' }] }];
    expect(doc({ layers: selfRef }).map((i) => [i.pointer, i.message])).toEqual([['/layers/0/selectors/0/layer', 'layer selectors form a cycle: X → Y → X']]);
    // "*", "!" and plain allowances never make a cycle.
    expect(doc({ layers, rules: { A: ['B', '!C'], B: ['A', '*'], '*': ['!C'] } })).toEqual([]);
  });

  it('rejects unknown keys, wrong types and malformed selectors and allowances', () => {
    const issues = doc({
      colour: 'blue',
      policy: { inferred: 'sometimes', uncovered: { builtin: true } },
      scope: { types: ['call', 'calls'] },
      layers: [
        { name: 'A', selectors: [{ path: 'a/**', name: 'X' }] },
        { name: 'A', selectors: [] },
        { name: 'B', selectors: [{ kind: ['class'] }, { name: '(', kind: ['klass'] }, { framework: 'controller' }] },
        { name: 'Old', overlay: true, selectors: [{ docTag: '@deprecated' }] },
        { name: '*', selectors: [] },
      ],
      rules: { Old: ['A'], A: ['+*', { allow: ['B'], to: 'B' }, { to: 'B', severity: 'fatal' }] },
    });
    expect(issues.map((i) => i.pointer)).toEqual([
      '/colour',
      '/policy/inferred',
      '/policy/uncovered/builtin',
      '/scope/types/1',
      '/layers/0/selectors/0',
      '/layers/1/name',
      '/layers/2/selectors/0/kind',
      '/layers/2/selectors/1/name',
      '/layers/2/selectors/1/kind/0',
      '/layers/2/selectors/2/framework',
      '/layers/4/name',
      '/rules/Old',
      '/rules/A/0',
      '/rules/A/1',
      '/rules/A/2/severity',
    ]);
    const by = (p: string) => issues.find((i) => i.pointer === p)!.message;
    expect(by('/layers/0/selectors/0')).toContain('combine them with { "all": [...] }');
    expect(by('/layers/1/name')).toContain('duplicate layer "A"');
    expect(by('/layers/2/selectors/0/kind')).toContain('refines a "name" selector');
    expect(by('/layers/2/selectors/1/name')).toContain('not a valid regular expression');
    expect(by('/rules/Old')).toContain('overlay layer');
    expect(by('/rules/A/1')).toContain('not both');
  });

  it('reports a JSONC syntax error with its line', () => {
    const issues = doc('{\n  "layers": [\n    { "name": "A" "selectors": [] }\n  ]\n}');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/^not valid JSONC at line 3, column \d+/);
  });

  it('accepts comments and trailing commas', () => {
    expect(doc('{\n  // layers\n  "layers": [{ "name": "A", "selectors": [{ "path": "a/**" },], },],\n  /* none */\n}')).toEqual([]);
  });
});

describe('extends, parameters and views', () => {
  it('resolves a three-document chain depth-first: later documents override layers by name and merge rules', () => {
    const config = loadArchitectureConfig(join(F, 'chain'))!;
    expect(config.files).toEqual(['.mapx/a.jsonc', '.mapx/b.jsonc', '.mapx/architecture.jsonc']);
    expect(config.layers.map((l) => l.name)).toEqual(['Domain', 'Shared', 'App', 'Http']);
    expect(config.layers[1]!.selectors).toEqual([{ path: 'packages/shared/**' }]); // b.jsonc's, in a.jsonc's position
    expect(config.rules).toEqual({ Domain: ['Shared'], App: ['+Domain', 'Shared'], Http: ['App'] });
    expect(config.policy.inferred).toBe('error');
    // Parameters merge first, then apply to every document's selectors.
    expect(config.parameters).toEqual({ App: 'Shop' });
    expect(config.layers[0]!.selectors).toEqual([{ name: '^Shop\\\\Domain\\\\' }]);
    expect(config.layers[3]!.selectors[1]).toEqual({ package: 'Shop/http-*' });
    // Defaults fill what no document sets.
    expect(config.scope.types).toEqual(['import', 'require', 'extends', 'implements', 'call', 'instantiation', 'param_type', 'return_type']);
    expect(config.visibility).toEqual({ internalTags: ['@internal', '@mapx-internal'], nativeMarkers: false });
    expect(config.view).toBeNull();
  });

  it('reports circular extends naming both files', () => {
    expect(issuesOf(() => loadArchitectureConfig(join(F, 'cycle')))).toEqual([
      { file: '.mapx/other.jsonc', pointer: '/extends', message: 'circular extends: .mapx/architecture.jsonc → .mapx/other.jsonc → .mapx/architecture.jsonc' },
    ]);
  });

  it('loads a view that extends the main document, and none when the view does not exist', () => {
    const view = loadArchitectureConfig(join(F, 'views'), { view: 'contexts' })!;
    expect(view.view).toBe('contexts');
    expect(view.files).toEqual(['.mapx/architecture.jsonc', '.mapx/architecture/contexts.jsonc']);
    expect(view.layers.map((l) => l.name)).toEqual(['Billing', 'Shipping', 'SharedKernel']);
    expect(view.rules['*']).toEqual(['SharedKernel']);
    expect(loadArchitectureConfig(join(F, 'views'), { view: 'nope' })).toBeNull();
    expect(loadArchitectureConfig(join(F, 'documents'))).toBeNull(); // no .mapx/architecture.jsonc
  });

  it('substitutes %parameters% in name, path and package values, and reports an unresolved one at its selector', () => {
    const issues = doc({
      parameters: { Root: 'src' },
      layers: [{ name: 'A', selectors: [{ path: '%Root%/a/**' }, { all: [{ name: '^%Ns%\\\\' }, { package: '%Vendor%/*' }] }] }],
    });
    expect(issues.map((i) => [i.pointer, i.message])).toEqual([
      ['/layers/0/selectors/1/all/0/name', 'parameter %Ns% has no value; declare it in "parameters"'],
      ['/layers/0/selectors/1/all/1/package', 'parameter %Vendor% has no value; declare it in "parameters"'],
    ]);
  });

  it('reports a missing extended file and an unknown preset, and resolves a registered preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'mapx-arch-cfg-'));
    try {
      mkdirSync(join(root, '.mapx'));
      writeFileSync(join(root, '.mapx/architecture.jsonc'), JSON.stringify({ extends: ['./nope.jsonc', 'mapx:preset/nothing', 'mapx:preset/mvc'], rules: { Controller: ['Model'] } }));
      const issues = issuesOf(() => loadArchitectureConfig(root, { presets: { mvc: '{ "layers": [{ "name": "Controller", "selectors": [{ "path": "**/controllers/**" }] }, { "name": "Model", "selectors": [{ "path": "**/models/**" }] }] }' } }));
      expect(issues.map((i) => [i.pointer, i.message.split(';')[0]])).toEqual([
        ['/extends/0', 'extended file "./nope.jsonc" not found (.mapx/nope.jsonc)'],
        ['/extends/1', 'unknown preset "mapx:preset/nothing"'],
      ]);
      writeFileSync(join(root, '.mapx/architecture.jsonc'), JSON.stringify({ extends: 'mapx:preset/mvc', rules: { Controller: ['Model'] } }));
      const config = loadArchitectureConfig(root, { presets: { mvc: { layers: [{ name: 'Controller', selectors: [{ path: '**/controllers/**' }] }, { name: 'Model', selectors: [{ path: '**/models/**' }] }] } } })!;
      expect(config.files).toEqual(['mapx:preset/mvc', '.mapx/architecture.jsonc']);
      expect(config.layers.map((l) => l.name)).toEqual(['Controller', 'Model']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a ConfigError message lists every problem', () => {
    const err = (() => { try { loadArchitectureConfig(join(F, 'cycle')); } catch (e) { return e as Error; } })()!;
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain('.mapx/other.jsonc#/extends: circular extends');
  });
});

describe('the AR-11 example document', () => {
  const ar11 = join(F, 'ar11/.mapx/architecture.jsonc');
  const laravel = { layers: [{ name: 'Jobs', selectors: [{ path: 'app/Jobs/**' }] }] };

  it('loads with its base document and preset, as written', () => {
    const config = loadArchitectureConfig(join(F, 'ar11'), { presets: { laravel } })!;
    expect(config.files).toEqual(['.mapx/architecture.base.jsonc', 'mapx:preset/laravel', '.mapx/architecture.jsonc']);
    expect(config.layers.map((l) => l.name)).toEqual(['Http', 'Jobs', 'Domain', 'Infra', 'Models', 'Deprecated', 'Vendor', 'DevOnly', 'Frontend', 'PublicApi']);
    expect(config.layers[0]!.selectors).toEqual([{ path: 'app/Http/**' }]); // the example overrides the base's Http
    expect(config.layers.find((l) => l.name === 'Domain')!.selectors[0]).toEqual({ name: '^App\\\\Domain\\\\', kind: ['class', 'interface', 'enum'] });
    expect(config.scope).toEqual({ types: ['import', 'extends', 'implements', 'call', 'instantiation', 'param_type', 'return_type'], include: [], exclude: ['tests/**', 'database/migrations/**'] });
    expect(config.policy).toEqual({ inferred: 'warn', inheritDependencies: false, uncovered: { externals: true, builtins: false }, strictLayers: false, alsoInferred: false });
    expect(config.rules['Frontend']).toEqual([{ allow: ['PublicApi'], types: ['http'] }]);
    expect(config.rules['*']).toEqual(['!Deprecated', '!DevOnly']);
    expect(config.baseline).toBe('.mapx/architecture.baseline.json');
    expect(config.report).toEqual({ groups: { Entry: ['Http'] }, hidden: ['Vendor'], pointToGroups: false, codeclimate: {} });
  });

  it('the published JSON Schema accepts it, rejects a typo, and covers every key the loader knows', () => {
    const schema = JSON.parse(readFileSync(resolve(__dirname, '../schemas/architecture.schema.json'), 'utf8'));
    const validate = new Ajv({ allErrors: true }).compile(schema);
    const example = JSON.parse(stripJsonc(readFileSync(ar11, 'utf8')));
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ layers: [{ name: 'A', selectors: [{ paht: 'x' }] }] })).toBe(false);
    expect(validate({ rules: { A: [{ allow: ['B'], to: 'C' }] } })).toBe(false);
    const keys = (obj: any) => Object.keys(obj.properties);
    expect(keys(schema).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
    expect(keys(schema.properties.scope).sort()).toEqual([...SCOPE_KEYS].sort());
    expect(keys(schema.properties.policy).sort()).toEqual([...POLICY_KEYS].sort());
    expect(keys(schema.properties.policy.properties.uncovered).sort()).toEqual([...UNCOVERED_KEYS].sort());
    expect(keys(schema.properties.visibility).sort()).toEqual([...VISIBILITY_KEYS].sort());
    expect(keys(schema.properties.report).sort()).toEqual([...REPORT_KEYS].sort());
    expect(keys(schema.definitions.layer).sort()).toEqual([...LAYER_KEYS].sort());
    expect(keys(schema.definitions.selector).sort()).toEqual([...SELECTOR_KEYS].sort());
    expect(Object.keys(schema.definitions.allowance.oneOf[1].properties).sort()).toEqual([...ALLOWANCE_KEYS].sort());
    // And the loader accepts the example document on its own (its extends are resolved elsewhere).
    expect(validateArchitectureText(readFileSync(ar11, 'utf8'))).toEqual([]);
  });
});

// M5-02-R1 (review 2026-11-02): inputs the loader crashed on or let through, and parameters in
// every selector key. Synthetic fixtures in tests/fixtures/arch-config/robustness/; the symlink and
// permission cases are built in temporary workspaces.
const R = join(F, 'robustness');
const canSymlink = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** A temporary workspace with these files (a JSON value is written as JSON), removed afterwards. */
function withWorkspace<T>(files: Record<string, unknown>, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'mapx-arch-cfg-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const loadDoc = (body: object) => withWorkspace({ '.mapx/architecture.jsonc': body }, (root) => loadArchitectureConfig(root)!);
const issuesOfDoc = (body: object) => withWorkspace({ '.mapx/architecture.jsonc': body }, (root) => issuesOf(() => loadArchitectureConfig(root)));
const APP = { name: 'App', selectors: [{ path: 'src/**' }] };

describe('loader robustness (M5-02-R1)', () => {
  it('loads documents saved with a UTF-8 BOM, the extended one too', () => {
    expect(readFileSync(join(R, 'bom/.mapx/architecture.jsonc'))[0]).toBe(0xef);
    expect(readFileSync(join(R, 'bom/.mapx/base.jsonc'))[0]).toBe(0xef);
    const config = loadArchitectureConfig(join(R, 'bom'))!;
    expect(config.files).toEqual(['.mapx/base.jsonc', '.mapx/architecture.jsonc']);
    expect(config.layers.map((l) => l.name)).toEqual(['Core', 'Api']);
    expect(config.rules).toEqual({ Api: ['Core'] });
    expect(doc('﻿{ "layers": [] }')).toEqual([]);
  });

  it('reports extends naming a directory at its pointer instead of throwing EISDIR', () => {
    expect(issuesOf(() => loadArchitectureConfig(join(R, 'extends-dir')))).toEqual([
      { file: '.mapx/architecture.jsonc', pointer: '/extends', message: 'extended path "./architecture" is a directory, not a file (.mapx/architecture)' },
    ]);
  });

  it('reports a configuration path that is a directory instead of throwing EISDIR', () => {
    withWorkspace({}, (root) => {
      mkdirSync(join(root, '.mapx/architecture.jsonc'), { recursive: true });
      expect(issuesOf(() => loadArchitectureConfig(root))).toEqual([
        { file: '.mapx/architecture.jsonc', pointer: '', message: 'cannot be read: it is a directory, not a file (EISDIR)' },
      ]);
    });
  });

  it('reports extends through a path whose parent is a file (ENOTDIR) at its pointer, as not found', () => {
    expect(issuesOfDoc({ extends: ['./architecture.jsonc/base.jsonc'], layers: [APP] })).toEqual([
      { file: '.mapx/architecture.jsonc', pointer: '/extends/0', message: 'extended file "./architecture.jsonc/base.jsonc" not found (.mapx/architecture.jsonc/base.jsonc)' },
    ]);
  });

  it.skipIf(!canSymlink)('reports a symlink loop (ELOOP) in extends and as the configuration itself', () => {
    withWorkspace({ '.mapx/architecture.jsonc': { extends: './loop.jsonc', layers: [APP] } }, (root) => {
      symlinkSync('loop.jsonc', join(root, '.mapx/loop.jsonc'));
      expect(issuesOf(() => loadArchitectureConfig(root))).toEqual([
        { file: '.mapx/architecture.jsonc', pointer: '/extends', message: 'extended path "./loop.jsonc" cannot be read: too many symbolic links (a symlink loop) (ELOOP) (.mapx/loop.jsonc)' },
      ]);
      rmSync(join(root, '.mapx/architecture.jsonc'));
      symlinkSync('architecture.jsonc', join(root, '.mapx/architecture.jsonc'));
      expect(issuesOf(() => loadArchitectureConfig(root))).toEqual([
        { file: '.mapx/architecture.jsonc', pointer: '', message: 'cannot be read: too many symbolic links (a symlink loop) (ELOOP)' },
      ]);
    });
  });

  it.skipIf(isRoot || process.platform === 'win32')('reports extends into an unreadable directory (EACCES) at its pointer', () => {
    withWorkspace({ '.mapx/architecture.jsonc': { extends: './locked/base.jsonc', layers: [APP] }, '.mapx/locked/base.jsonc': { layers: [] } }, (root) => {
      chmodSync(join(root, '.mapx/locked'), 0o000);
      try {
        expect(issuesOf(() => loadArchitectureConfig(root))).toEqual([
          { file: '.mapx/architecture.jsonc', pointer: '/extends', message: 'extended path "./locked/base.jsonc" cannot be read: permission denied (EACCES) (.mapx/locked/base.jsonc)' },
        ]);
      } finally {
        chmodSync(join(root, '.mapx/locked'), 0o755);
      }
    });
  });

  it('refuses a view whose file lies outside .mapx/architecture/', () => {
    expect(issuesOf(() => loadArchitectureConfig(join(R, 'view-escape'), { view: '../../outside' }))).toEqual([
      { file: '.mapx/architecture', pointer: '', message: 'view "../../outside" is outside .mapx/architecture/: a view is a file name there, such as "contexts" for .mapx/architecture/contexts.jsonc' },
    ]);
    expect(issuesOf(() => loadArchitectureConfig(join(R, 'view-escape'), { view: '../architecture' }))[0]!.message).toContain('is outside .mapx/architecture/');
    // A view inside the directory still loads, including a name that merely starts with "..".
    expect(loadArchitectureConfig(join(F, 'views'), { view: 'contexts' })!.view).toBe('contexts');
    withWorkspace({ '.mapx/architecture/..legacy.jsonc': { layers: [APP] } }, (root) => {
      expect(loadArchitectureConfig(root, { view: '..legacy' })!.layers.map((l) => l.name)).toEqual(['App']);
    });
  });

  it('never reads the file an escaping view names', () => {
    // Were outside.jsonc read, it would be reported as a directory; only the view is reported.
    withWorkspace({ '.mapx/architecture.jsonc': { layers: [APP] } }, (root) => {
      mkdirSync(join(root, 'outside.jsonc'));
      expect(issuesOf(() => loadArchitectureConfig(root, { view: '../../outside' })).map((i) => i.message)).toEqual([
        'view "../../outside" is outside .mapx/architecture/: a view is a file name there, such as "contexts" for .mapx/architecture/contexts.jsonc',
      ]);
    });
  });

  it.skipIf(!canSymlink)('refuses a view that is a symlink to a file outside .mapx/architecture/', () => {
    withWorkspace({ 'outside.jsonc': { layers: [{ name: 'Outside', selectors: [{ path: '**' }] }] }, '.mapx/architecture/inside.jsonc': { layers: [APP] } }, (root) => {
      symlinkSync('../../outside.jsonc', join(root, '.mapx/architecture/linked.jsonc'));
      expect(issuesOf(() => loadArchitectureConfig(root, { view: 'linked' }))[0]!.message).toBe(
        'view "linked" is outside .mapx/architecture/: a view is a file name there, such as "contexts" for .mapx/architecture/contexts.jsonc',
      );
      // A symlink that stays inside is a view like any other.
      symlinkSync('inside.jsonc', join(root, '.mapx/architecture/alias.jsonc'));
      expect(loadArchitectureConfig(root, { view: 'alias' })!.layers.map((l) => l.name)).toEqual(['App']);
    });
  });

  it('an empty view name is an error, not the main configuration', () => {
    for (const view of ['', '  ']) {
      expect(issuesOf(() => loadArchitectureConfig(join(F, 'views'), { view }))).toEqual([
        { file: '.mapx/architecture', pointer: '', message: 'empty view name: a view is a file name in .mapx/architecture/, such as "contexts" for .mapx/architecture/contexts.jsonc' },
      ]);
    }
  });
});

describe('parameters in every selector key (M5-02-R1)', () => {
  it('substitutes path (glob and regex), name, package, repo, cluster, workspacePackage, role, language, extends and docTag', () => {
    const config = loadArchitectureConfig(join(R, 'params'))!;
    expect(config.layers.map((l) => [l.name, l.selectors])).toEqual([
      ['Paths', [{ path: 'src/http/**' }, { path: '/^src\\/jobs\\//' }]],
      ['Names', [{ name: '^Shop\\\\Domain\\\\' }, { package: 'acme/*' }]],
      ['Places', [{ repo: 'api' }, { cluster: 'billing' }, { workspacePackage: '@acme/core' }]],
      ['Kinds', [{ role: 'controller', confidence: 0.5 }, { language: 'php' }, { extends: 'Model' }, { docTag: '@api' }]],
    ]);
  });

  it('an undefined parameter is an error in name, path and package, at its pointer', () => {
    const keys = ['path', 'name', 'package'];
    expect(issuesOfDoc({ layers: [{ name: 'A', selectors: keys.map((k) => ({ [k]: `%Nope%-${k}` })) }] }).map((i) => [i.pointer, i.message])).toEqual(
      keys.map((k, i) => [`/layers/0/selectors/${i}/${k}`, 'parameter %Nope% has no value; declare it in "parameters"']),
    );
  });

  it('in the other keys an undefined %x% stays literal text, so documents that loaded before still load', () => {
    const keys = ['repo', 'cluster', 'workspacePackage', 'role', 'language', 'extends', 'implements', 'inherits', 'mixes', 'decorator', 'docTag', 'member', 'builtin', 'ambient'];
    const selectors = [...keys.map((k) => ({ [k]: `%Nope%-${k}` })), { docTag: 'format', value: '%s%s' }, { member: '/^%d%x$/' }, { decorator: '%Route%' }];
    const config = loadDoc({ parameters: { Defined: 'x' }, layers: [{ name: 'A', selectors }] });
    expect(config.layers[0]!.selectors).toEqual(selectors);
  });

  it('%% is a literal % in every key, and a defined parameter is substituted in every key', () => {
    const config = loadDoc({
      parameters: { Fmt: 'printf' },
      layers: [{ name: 'A', selectors: [{ name: '^100%%' }, { path: 'a%%b/**' }, { docTag: '@x', value: '%%d %Fmt%' }, { member: '/^%%%Fmt%$/' }, { decorator: '%%Route%%' }] }],
    });
    expect(config.layers[0]!.selectors).toEqual([{ name: '^100%' }, { path: 'a%b/**' }, { docTag: '@x', value: '%d printf' }, { member: '/^%printf$/' }, { decorator: '%Route%' }]);
  });

  it('resolves parameters named inside parameter values, and reports undefined ones and cycles', () => {
    const config = loadDoc({ parameters: { base: 'src', root: '%base%/app', http: '%root%/Http' }, layers: [{ name: 'A', selectors: [{ path: '%http%/**' }] }] });
    expect(config.parameters).toEqual({ base: 'src', root: 'src/app', http: 'src/app/Http' });
    expect(config.layers[0]!.selectors).toEqual([{ path: 'src/app/Http/**' }]);
    expect(issuesOfDoc({ parameters: { root: '%nope%/app' }, layers: [APP] })).toEqual([
      { file: '.mapx/architecture.jsonc', pointer: '/parameters/root', message: 'parameter %nope% has no value; declare it in "parameters"' },
    ]);
    expect(issuesOfDoc({ parameters: { a: 'x/%b%', b: '%c%', c: '%a%', d: '%d%' }, layers: [APP] })).toEqual([
      { file: '.mapx/architecture.jsonc', pointer: '/parameters/a', message: 'parameters form a cycle: %a% → %b% → %c% → %a%' },
      { file: '.mapx/architecture.jsonc', pointer: '/parameters/d', message: 'parameters form a cycle: %d% → %d%' },
    ]);
  });

  it('a framework part may be a parameter: checked once substituted', () => {
    expect(loadDoc({ parameters: { Fw: 'job' }, layers: [{ name: 'A', selectors: [{ framework: '%Fw%' }] }] }).layers[0]!.selectors).toEqual([{ framework: 'job' }]);
    const issues = issuesOfDoc({ parameters: { Fw: 'jobs' }, layers: [{ name: 'A', selectors: [{ framework: '%Fw%' }, { framework: '%Nope%' }, { framework: 'jobz' }] }] });
    expect(issues.map((i) => [i.pointer, i.message.split(';')[0]])).toEqual([
      ['/layers/0/selectors/0/framework', 'unknown framework part "jobs"'],
      ['/layers/0/selectors/1/framework', 'unknown framework part "%Nope%"'],
      ['/layers/0/selectors/2/framework', 'unknown framework part "jobz"'],
    ]);
  });
});

// Filesystem errors through the CLI and MCP: a configuration error (exit 3, isError), never a crash.
describe.skipIf(!canSymlink)('filesystem errors are configuration errors on every surface (M5-02-R1)', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mapx-arch-fs-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    init(root);
    mapx(root, 'scan');
  });
  afterAll(() => {
    if (existsSync(join(root, '.mapx/locked'))) chmodSync(join(root, '.mapx/locked'), 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  const cases: Array<[string, () => void, string, boolean]> = [
    ['ELOOP', () => {
      writeFileSync(join(root, '.mapx/architecture.jsonc'), JSON.stringify({ extends: './loop.jsonc', layers: [APP] }));
      if (!existsSync(join(root, '.mapx/loop.jsonc'))) symlinkSync('loop.jsonc', join(root, '.mapx/loop.jsonc'));
    }, '(ELOOP)', false],
    ['EACCES', () => {
      mkdirSync(join(root, '.mapx/locked'), { recursive: true });
      writeFileSync(join(root, '.mapx/locked/base.jsonc'), '{}');
      chmodSync(join(root, '.mapx/locked'), 0o000);
      writeFileSync(join(root, '.mapx/architecture.jsonc'), JSON.stringify({ extends: './locked/base.jsonc', layers: [APP] }));
    }, '(EACCES)', isRoot],
  ];
  for (const [code, arrange, marker, skip] of cases) {
    it.skipIf(skip)(`${code}: arch validate-config and mapx check exit 3, mapx_arch_validate_config is a tool error`, async () => {
      arrange();
      const validate = mapxResult(root, 'arch', 'validate-config');
      expect(validate.status, validate.stderr).toBe(3);
      expect(validate.stdout).toContain(`.mapx/architecture.jsonc#/extends: extended path`);
      expect(validate.stdout).toContain(marker);
      const check = mapxResult(root, 'check', '--format', 'json');
      expect(check.status, check.stderr).toBe(3);
      expect(JSON.parse(check.stdout).configErrors.join('\n')).toContain(marker);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await buildServer().connect(serverSide);
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(clientSide);
      try {
        const res = (await client.callTool({ name: 'mapx_arch_validate_config', arguments: { dir: root } })) as { isError?: boolean; content: Array<{ text: string }> };
        expect(res.isError).toBe(true);
        expect(JSON.parse(res.content[0]!.text).issues[0].message).toContain(marker);
      } finally {
        await client.close();
      }
    });
  }
});

// AC1: every configuration error with its JSON pointer, and a failing exit (CLI) or isError (MCP).
const INVALID = [
  ['/layers/0/selectors/0/paht', 'unknown selector key "paht"'],
  ['/layers/1/selectors/0/path', 'parameter %Src% has no value'],
  ['/rules/Http/0', 'unknown layer "Servce"'],
];

describe('mapx arch validate-config (M5-02-R1)', () => {
  it('prints every error with its file and pointer and exits 3', () => {
    const r = mapxResult(F, 'arch', 'validate-config', join(R, 'invalid'));
    expect(r.status, r.stderr).toBe(3);
    const lines = r.stdout.trim().split('\n');
    expect(lines.slice(0, 3).map((l) => l.split(';')[0])).toEqual(INVALID.map(([p, m]) => `.mapx/architecture.jsonc#${p}: ${m}`));
    expect(lines[3]).toBe('3 problems in .mapx/architecture.jsonc.');
  });

  it('--format json gives the issues, and --dir works after the subcommand', () => {
    const r = mapxResult(F, 'arch', 'validate-config', '--format', 'json', '--dir', join(R, 'invalid'));
    expect(r.status, r.stderr).toBe(3);
    const report = JSON.parse(r.stdout);
    expect(report.valid).toBe(false);
    expect(report.files).toEqual(['.mapx/architecture.jsonc']);
    expect(report.issues.map((i: any) => [i.pointer, i.message.split(';')[0]])).toEqual(INVALID);
    expect(report.issues.every((i: any) => i.file === '.mapx/architecture.jsonc')).toBe(true);
  });

  it('exits 0 on a valid chain and a valid view, and needs no index', () => {
    const r = mapxResult(F, 'arch', 'validate-config', join(F, 'chain'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('Valid: .mapx/a.jsonc, .mapx/b.jsonc, .mapx/architecture.jsonc (4 layers).\n');
    const v = mapxResult(F, 'arch', 'validate-config', join(F, 'views'), '--view', 'contexts', '--format', 'json');
    expect(v.status, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout)).toEqual({ valid: true, view: 'contexts', files: ['.mapx/architecture.jsonc', '.mapx/architecture/contexts.jsonc'], issues: [] });
  });

  it('exits 3 when there is no configuration, or the view escapes .mapx/architecture/', () => {
    const none = mapxResult(F, 'arch', 'validate-config', join(F, 'documents'));
    expect(none.status).toBe(3);
    expect(none.stdout).toContain('.mapx/architecture.jsonc: not found');
    const escape = mapxResult(F, 'arch', 'validate-config', join(R, 'view-escape'), '--view', '../../outside');
    expect(escape.status).toBe(3);
    expect(escape.stdout).toContain('is outside .mapx/architecture/');
    const empty = mapxResult(F, 'arch', 'validate-config', join(F, 'views'), '--view', '', '--format', 'json');
    expect(empty.status).toBe(3);
    expect(JSON.parse(empty.stdout).issues.map((i: any) => i.message.split(':')[0])).toEqual(['empty view name']);
  });
});

describe('mapx_arch_validate_config (M5-02-R1)', () => {
  let client: Client;
  // Copies: the MCP server logs tool calls into the first project's .mapx/, never into a fixture.
  let tmp: string;
  const copy = (from: string) => { const to = join(tmp, from.replace(/\//g, '-')); cpSync(join(F, from), to, { recursive: true }); return to; };
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mapx-arch-mcp-'));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
  });
  afterAll(async () => { await client.close(); rmSync(tmp, { recursive: true, force: true }); });
  const call = async (args: Record<string, unknown>) =>
    (await client.callTool({ name: 'mapx_arch_validate_config', arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

  it('is listed', async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('mapx_arch_validate_config');
  });

  it('returns every error with its pointer as JSON, as a tool error', async () => {
    const res = await call({ dir: copy('robustness/invalid') });
    expect(res.isError).toBe(true);
    const report = JSON.parse(res.content[0]!.text);
    expect(report.valid).toBe(false);
    expect(report.issues.map((i: any) => [i.pointer, i.message.split(';')[0]])).toEqual(INVALID);
  });

  it('text format matches the CLI; a valid view is not an error; a missing one is', async () => {
    const text = await call({ dir: copy('robustness/invalid'), format: 'text' });
    expect(text.isError).toBe(true);
    expect(text.content[0]!.text).toBe(mapxResult(F, 'arch', 'validate-config', join(R, 'invalid')).stdout.trimEnd());
    const views = copy('views');
    const ok = await call({ dir: views, view: 'contexts' });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0]!.text).valid).toBe(true);
    const missing = await call({ dir: views, view: 'nope' });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0]!.text).issues).toEqual([{ file: '.mapx/architecture/nope.jsonc', pointer: '', message: 'not found: no view "nope"' }]);
    const empty = await call({ dir: views, view: '' });
    expect(empty.isError).toBe(true);
    expect(JSON.parse(empty.content[0]!.text).issues.map((i: any) => i.message.split(':')[0])).toEqual(['empty view name']);
  });
});
