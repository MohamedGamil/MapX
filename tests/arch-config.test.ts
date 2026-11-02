import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
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
    expect(config.policy).toEqual({ inferred: 'warn', inheritDependencies: false, uncovered: { externals: true, builtins: false }, strictLayers: false });
    expect(config.rules['Frontend']).toEqual([{ allow: ['PublicApi'], types: ['http'] }]);
    expect(config.rules['*']).toEqual(['!Deprecated', '!DevOnly']);
    expect(config.baseline).toBe('.mapx/architecture.baseline.json');
    expect(config.report).toEqual({ groups: { Entry: ['Http'] }, hidden: ['Vendor'] });
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
