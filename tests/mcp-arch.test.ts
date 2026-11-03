import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { init, mapx, mapxResult } from './helpers/e2e.js';
import { Store } from '../src/core/store.js';
import { isAllowed, openArchitecture } from '../src/arch/introspect.js';
import { stripJsonc } from '../src/core/js-aliases.js';

// M5-14 (AR-19): the mapx_arch_* MCP tools, through a real MCP client, on scanned temp copies of
// tests/fixtures/arch-mcp/ts (synthetic; its architecture.jsonc names the expected decisions) and
// of the M5-01 TypeScript app. Each tool wraps the function behind a CLI command, so each test
// compares the tool's JSON with the CLI's on the same workspace. Fixture directories are never
// served: the server logs tool calls into the first workspace's .mapx/.
const MCP_FIXTURE = resolve(__dirname, 'fixtures/arch-mcp/ts');
const RULES_FIXTURE = resolve(__dirname, 'fixtures/arch-rules/ts');
const SLOW = { timeout: 180_000 };

let tmp = '';
let app = ''; // arch-mcp, with a git history: the second commit touches OrderController.ts
let rules = ''; // arch-rules/ts
let bare = ''; // arch-mcp without an architecture configuration, for mapx_arch_init
let internal = ''; // arch-mcp with OrderRepository marked @internal (M5-11)
let client: Client;

type Result = { isError?: boolean; content: Array<{ type: string; text: string }> };
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
const body = (r: Result) => JSON.parse(r.content[0]!.text);
/** The CLI's JSON answer and exit code. */
const cli = (cwd: string, ...args: string[]) => {
  const r = mapxResult(cwd, ...args);
  return { status: r.status, json: JSON.parse(r.stdout) };
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });

/** Every file under `root` (`.git` aside) with a hash of its content: any write shows. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (name === '.git') continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

const cls = (path: string, name: string, symbolKind = 'class') => ({ element: `${path}#${name}`, kind: 'symbol', symbolKind, file: path });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mapx-mcp-arch-'));
  app = join(tmp, 'app');
  rules = join(tmp, 'rules');
  bare = join(tmp, 'bare');
  cpSync(MCP_FIXTURE, app, { recursive: true });
  git(app, 'init', '-q');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'one');
  appendFileSync(join(app, 'src/controller/OrderController.ts'), '// touched by the second commit\n');
  git(app, 'commit', '-q', '-am', 'two');
  cpSync(RULES_FIXTURE, rules, { recursive: true });
  cpSync(MCP_FIXTURE, bare, { recursive: true });
  rmSync(join(bare, '.mapx'), { recursive: true });
  internal = join(tmp, 'internal');
  cpSync(MCP_FIXTURE, internal, { recursive: true });
  const repo = join(internal, 'src/domain/OrderRepository.ts');
  writeFileSync(repo, readFileSync(repo, 'utf8').replace('export interface OrderRepository', '/** @internal */\nexport interface OrderRepository'));
  for (const root of [app, rules, bare, internal]) {
    init(root);
    mapx(root, 'scan');
  }
  // No call before the first describe: it checks what the server's first calls write.
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
}, 300_000);
afterAll(async () => {
  await client?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// The first calls of a fresh server (review of M5-14: the earlier no-write test made its first call
// elsewhere, so the tool-call log could never land in the workspace it watched).
describe('the server\'s first calls write nothing', SLOW, () => {
  it('a call on a missing folder creates nothing; mapx_arch_init dry runs leave the workspace byte-identical, log included', async () => {
    const missing = join(tmp, 'nx/a/b');
    const r = await call('mapx_arch_layers', { dir: missing });
    expect([r.isError, body(r).exitCode]).toEqual([true, 4]);
    expect(existsSync(join(tmp, 'nx'))).toBe(false);
    const before = snapshot(bare);
    for (const args of [{}, { write: false }, { view: 'proposed' }]) {
      const dry = await call('mapx_arch_init', { dir: bare, ...args });
      expect(dry.isError).toBeFalsy();
      expect(body(dry).written).toBe(false);
    }
    expect(snapshot(bare)).toEqual(before);
    expect(existsSync(join(bare, '.mapx/tool-calls.jsonl'))).toBe(false);
  });
});

describe('the tool list', () => {
  it('has the five architecture tools, 39 tools in all', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['mapx_arch_check', 'mapx_arch_layers', 'mapx_arch_allowed', 'mapx_arch_explain', 'mapx_arch_init', 'mapx_arch_validate_config']));
    expect(names).toHaveLength(39);
  });
});

describe('mapx_arch_check', SLOW, () => {
  const violation = (source: string, target: string, edgeType: string) => ({ rule: 'disallowed-layer', source, target, edgeType });
  const ids = (b: { findings: Array<{ rule?: string; source?: { element: string }; target?: { element: string }; edgeType?: string }> }) =>
    b.findings.map((f) => ({ rule: f.rule, source: f.source?.element, target: f.target?.element, edgeType: f.edgeType }));

  it('returns the report `mapx check --format json` prints, with exitCode, total and truncation', async () => {
    const r = await call('mapx_arch_check', { dir: app, limit: 0 });
    expect(r.isError).toBeFalsy();
    const { exitCode, total, limit, truncated, ...report } = body(r);
    expect({ exitCode, total, limit, truncated }).toEqual({ exitCode: 1, total: 3, limit: 0, truncated: false });
    const c = cli(app, 'check', '--format', 'json');
    expect(c.status).toBe(1);
    expect(report).toEqual(c.json);
    expect(ids(report)).toEqual([
      violation('src/application/PlaceOrder.ts#PlaceOrder', 'src/infrastructure/SqlOrderRepository.ts#SqlOrderRepository', 'import'),
      violation('src/application/PlaceOrder.ts#PlaceOrder', 'src/infrastructure/SqlOrderRepository.ts#SqlOrderRepository', 'instantiation'),
      violation('src/controller/OrderController.ts#OrderController', 'src/domain/Order.ts#Order', 'import'),
    ]);
  });

  it('layer and rule filter as --layer and --rule do; the text format is the table', async () => {
    const r = body(await call('mapx_arch_check', { dir: rules, layer: 'Domain', rule: 'disallowed-layer', reportAllowed: true, limit: 0 }));
    const c = cli(rules, 'check', '--format', 'json', '--layer', 'Domain', '--rule', 'disallowed-layer', '--report-allowed');
    const { exitCode, total, limit, truncated, ...report } = r;
    expect(report).toEqual(c.json);
    expect(exitCode).toBe(c.status);
    // Whole: the table's summary counts errors among the findings it lists.
    const text = await call('mapx_arch_check', { dir: app, format: 'text', limit: 1 });
    expect(text.content[0]!.text).toBe(mapxResult(app, 'check').stdout);
  });

  it('caps the findings and reports the total', async () => {
    const b = body(await call('mapx_arch_check', { dir: app, limit: 1 }));
    expect({ n: b.findings.length, total: b.total, limit: b.limit, truncated: b.truncated, exitCode: b.exitCode, counts: b.counts.violation }).toEqual({ n: 1, total: 3, limit: 1, truncated: true, exitCode: 1, counts: 3 });
  });

  it('file keeps the findings with an end in that file or folder; since, those of the files changed since a ref', async () => {
    const byFile = body(await call('mapx_arch_check', { dir: app, file: 'src/controller' }));
    expect(ids(byFile)).toEqual([violation('src/controller/OrderController.ts#OrderController', 'src/domain/Order.ts#Order', 'import')]);
    expect(byFile.exitCode).toBe(1);
    const byGlob = body(await call('mapx_arch_check', { dir: app, file: 'src/**/SqlOrderRepository.ts' }));
    expect(ids(byGlob).map((f) => f.edgeType)).toEqual(['import', 'instantiation']);
    const since = body(await call('mapx_arch_check', { dir: app, since: 'HEAD~1' }));
    expect(ids(since)).toEqual([violation('src/controller/OrderController.ts#OrderController', 'src/domain/Order.ts#Order', 'import')]);
    const none = body(await call('mapx_arch_check', { dir: app, since: 'HEAD' }));
    expect({ findings: none.findings, exitCode: none.exitCode }).toEqual({ findings: [], exitCode: 0 });
  });

  it('usage and configuration problems are tool errors with exitCode 3', async () => {
    const layer = await call('mapx_arch_check', { dir: app, layer: 'Nope' });
    expect([layer.isError, body(layer).exitCode, body(layer).error]).toEqual([true, 3, 'layer "Nope" is not a layer of this configuration (Controller, Application, Domain, Infrastructure)']);
    const file = await call('mapx_arch_check', { dir: app, file: 'src/nosuch' });
    expect([file.isError, body(file)]).toEqual([true, { error: 'file "src/nosuch" matches no indexed file', exitCode: 3 }]);
    const ref = await call('mapx_arch_check', { dir: app, since: 'no-such-ref' });
    expect([ref.isError, body(ref).exitCode]).toEqual([true, 3]);
  });

  // Review of M5-14 (P0): `since` reached a shell. A valid revision (`^{/.}` matches any commit
  // message) carrying a command substitution must run nothing; an option-like ref is refused.
  it('since never runs a command and is never an option: both are exit 3', async () => {
    for (const since of ['HEAD^{/.|$(touch PWNED)}', 'HEAD^{/.|`touch PWNED`}', '-n', '--output=PWNED', 'HEAD; touch PWNED']) {
      const r = await call('mapx_arch_check', { dir: app, since });
      expect([since, r.isError, body(r).exitCode]).toEqual([since, true, 3]);
    }
    for (const where of [app, process.cwd(), tmp]) expect(existsSync(join(where, 'PWNED'))).toBe(false);
    const missing = await call('mapx_arch_check', { dir: bare });
    expect([missing.isError, body(missing).exitCode]).toEqual([true, 3]);
    expect(body(missing).error).toContain('No architecture configuration');
    expect(mapxResult(bare, 'check').status).toBe(3);
  });
});

describe('mapx_arch_layers', SLOW, () => {
  it('lists the layers, a layer\'s members with --why, and the unassigned elements, as the CLI does', async () => {
    expect(body(await call('mapx_arch_layers', { dir: app }))).toEqual(cli(app, 'arch', 'layers', '--json').json);
    const domain = body(await call('mapx_arch_layers', { dir: app, layer: 'Domain', why: true }));
    const { truncated, ...members } = domain;
    expect(truncated).toBe(false);
    expect(members).toEqual(cli(app, 'arch', 'layers', 'Domain', '--why', '--json').json);
    expect(members.members.map((m: { element: string; selector: string }) => [m.element, m.selector])).toEqual([
      ['src/domain/Order.ts', 'selectors[0].path'], ['src/domain/Order.ts#Order', 'selectors[0].path'],
      ['src/domain/OrderRepository.ts', 'selectors[0].path'], ['src/domain/OrderRepository.ts#OrderRepository', 'selectors[0].path'],
    ]);
    const unassigned = body(await call('mapx_arch_layers', { dir: rules, unassigned: true }));
    const c = cli(rules, 'arch', 'unassigned', '--json');
    expect(c.status).toBe(2);
    expect(unassigned).toEqual({ ...c.json, truncated: false });
    expect(unassigned.elements.map((e: { element: string }) => e.element)).toEqual(['src/support/Clock.ts', 'src/support/Clock.ts#Clock', 'src/support/Uuid.ts', 'src/support/Uuid.ts#Uuid']);
  });

  it('caps the lists with a total', async () => {
    const b = body(await call('mapx_arch_layers', { dir: app, layer: 'Domain', limit: 1 }));
    expect({ total: b.total, members: b.members.map((m: { element: string }) => m.element), truncated: b.truncated }).toEqual({ total: 4, members: ['src/domain/Order.ts'], truncated: true });
    const u = body(await call('mapx_arch_layers', { dir: rules, unassigned: true, limit: 3 }));
    expect([u.total, u.elements.length, u.truncated]).toEqual([4, 3, true]);
  });

  it('an unknown layer is a tool error naming the layers', async () => {
    const r = await call('mapx_arch_layers', { dir: app, layer: 'Nope' });
    expect(r.isError).toBe(true);
    expect(body(r)).toEqual({
      error: '"Nope" is not a layer of this configuration (Controller, Application, Domain, Infrastructure)',
      candidates: ['Controller', 'Application', 'Domain', 'Infrastructure'], exitCode: 3,
    });
  });
});

describe('mapx_arch_allowed', SLOW, () => {
  it('refuses a disallowed pair with its rule, the allowed layers and the alternatives there', async () => {
    const r = await call('mapx_arch_allowed', { dir: app, from: 'PlaceOrder', to: 'SqlOrderRepository' });
    expect(r.isError).toBeFalsy(); // a refusal is an answer
    const b = body(r);
    expect(b).toMatchObject({ allowed: false, rule: 'disallowed-layer', severity: 'error', exitCode: 1, allowedTypes: [], allowedLayers: ['Domain'] });
    expect(b.reason).toBe('Application may not depend on Infrastructure over import: no rule allows it');
    expect(b.alternatives).toEqual([
      { layer: 'Domain', total: 1, symbols: [{ ...cls('src/domain/OrderRepository.ts', 'OrderRepository', 'interface'), match: 'supertype' }] },
    ]);
    const c = cli(app, 'arch', 'allowed', 'PlaceOrder', 'SqlOrderRepository', '--json');
    expect(c.status).toBe(1);
    expect(b).toEqual(c.json);
    // The CLI's text names them too.
    expect(mapxResult(app, 'arch', 'allowed', 'PlaceOrder', 'SqlOrderRepository').stdout).toContain('instead, in Domain: src/domain/OrderRepository.ts#OrderRepository (supertype)');
  });

  it('a file target stands for its symbols; an allowed pair has no alternatives; answers match the CLI on the M5-01 app', async () => {
    const file = body(await call('mapx_arch_allowed', { dir: app, from: 'src/application/PlaceOrder.ts', to: 'src/infrastructure/SqlOrderRepository.ts', type: 'import' }));
    expect(file).toMatchObject({ allowed: false, edgeType: 'import', alternatives: [{ layer: 'Domain', total: 1, symbols: [{ element: 'src/domain/OrderRepository.ts#OrderRepository', match: 'supertype' }] }] });
    const ok = body(await call('mapx_arch_allowed', { dir: app, from: 'OrderController', to: 'PlaceOrder' }));
    expect(ok).toMatchObject({ allowed: true, rule: 'allowed', exitCode: 0, alternatives: [] });
    for (const [from, to] of [['Controller', 'Domain'], ['OrderController', 'PricingRules'], ['Order', 'SqlOrderRepository'], ['Application', 'Clock']]) {
      expect(body(await call('mapx_arch_allowed', { dir: rules, from, to }))).toEqual(cli(rules, 'arch', 'allowed', from!, to!, '--json').json);
    }
  });

  it('an unknown element, an ambiguous one, a bad type or a missing argument is a tool error (exitCode 3)', async () => {
    for (const args of [{ from: 'Nope', to: 'Domain' }, { from: 'Controller', to: 'save' }, { from: 'Controller', to: 'Domain', type: 'nope' }, { from: 'Controller' }]) {
      const r = await call('mapx_arch_allowed', { dir: app, ...args });
      expect([r.isError, body(r).exitCode]).toEqual([true, 3]);
    }
    expect(body(await call('mapx_arch_allowed', { dir: app, from: 'Controller', to: 'save' })).candidates).toEqual([
      'src/domain/OrderRepository.ts#OrderRepository.save', 'src/infrastructure/SqlOrderRepository.ts#SqlOrderRepository.save',
    ]);
    // A non-string dir is a tool error too, not a JSON-RPC error.
    const dir = await call('mapx_arch_allowed', { dir: 5, from: 'Controller', to: 'Domain' });
    expect([dir.isError, body(dir)]).toEqual([true, { error: '"dir" must be a string', exitCode: 3 }]);
  });

  // Review of M5-14 (P1): an alternative was suggested that the rules refuse (an @internal interface).
  it('never suggests an element the rules refuse: an @internal supertype is no alternative', async () => {
    const direct = body(await call('mapx_arch_allowed', { dir: internal, from: 'PlaceOrder', to: 'OrderRepository' }));
    expect(direct).toMatchObject({ allowed: false, rule: 'internal-element', exitCode: 1 });
    const refused = body(await call('mapx_arch_allowed', { dir: internal, from: 'PlaceOrder', to: 'SqlOrderRepository' }));
    expect(refused).toMatchObject({ allowed: false, rule: 'disallowed-layer', allowedLayers: ['Domain'], alternatives: [] });
  });

  it('every alternative is itself allowed from the source (property over every pair of top-level symbols of the fixtures)', () => {
    let checked = 0;
    for (const root of [app, rules, internal]) {
      const store = new Store(join(root, '.mapx/mapx.db'));
      try {
        const repos = (JSON.parse(readFileSync(join(root, '.mapx/config.json'), 'utf8')).repos ?? []) as Array<{ name: string; path: string }>;
        const ctx = openArchitecture(root, store, { repoPaths: Object.fromEntries(repos.map((r) => [r.name, r.path])) })!;
        const tops = ctx.membership.view.elements.filter((e) => e.kind === 'symbol' && e.topLevel).map((e) => e.id);
        for (const from of tops) {
          for (const to of tops) {
            if (from === to) continue;
            for (const edgeType of [undefined, 'import']) {
              for (const alt of isAllowed(ctx, from, to, { edgeType }).alternatives) {
                for (const s of alt.symbols) {
                  const a = isAllowed(ctx, from, s.element, { edgeType });
                  expect({ from, to, edgeType, alternative: s.element, allowed: a.allowed }).toEqual({ from, to, edgeType, alternative: s.element, allowed: true });
                  checked++;
                }
              }
            }
          }
        }
      } finally {
        store.close();
      }
    }
    expect(checked).toBeGreaterThan(0); // not vacuous: PlaceOrder → SqlOrderRepository at least
  });
});

describe('mapx_arch_explain', SLOW, () => {
  it('gives the selector trace of `mapx arch which`, membership of a layer, and the rule trace of `mapx arch allowed`', async () => {
    const b = body(await call('mapx_arch_explain', { dir: app, element: 'SqlOrderRepository', layer: 'Domain', to: 'OrderRepository' }));
    expect(b.element).toEqual(cli(app, 'arch', 'which', 'SqlOrderRepository', '--json').json);
    expect(b.element.matches[0].trace).toEqual([{ layer: 'Infrastructure', selector: 'selectors[0].path', via: 'self' }]);
    expect(b.layer).toEqual({ name: 'Domain', matches: [{ element: 'src/infrastructure/SqlOrderRepository.ts#SqlOrderRepository', inLayer: false }] });
    expect(b.dependency).toEqual(cli(app, 'arch', 'allowed', 'SqlOrderRepository', 'OrderRepository', '--json').json);
    expect(b.dependency).toMatchObject({ allowed: true, rule: 'allowed' });
    const inLayer = body(await call('mapx_arch_explain', { dir: app, element: 'src/domain/Order.ts', layer: 'Domain' }));
    expect(inLayer.layer).toEqual({ name: 'Domain', matches: [{ element: 'src/domain/Order.ts', inLayer: true, selector: 'selectors[0].path', via: 'self' }] });
    expect(inLayer.dependency).toBeUndefined();
    const violation = body(await call('mapx_arch_explain', { dir: app, element: 'OrderController', to: 'Order' }));
    expect(violation.dependency).toMatchObject({ allowed: false, rule: 'disallowed-layer', reason: 'Controller may not depend on Domain over import: no rule allows it' });
  });

  it('an element nothing resolves is a tool error', async () => {
    const r = await call('mapx_arch_explain', { dir: app, element: 'NoSuchThing' });
    expect([r.isError, body(r)]).toEqual([true, { error: '"NoSuchThing" is not an indexed file or symbol', exitCode: 3 }]);
  });
});

describe('mapx_arch_init', SLOW, () => {
  it('proposes a configuration (the dry runs are the first describe\'s)', async () => {
    const dry = await call('mapx_arch_init', { dir: bare });
    const explicit = await call('mapx_arch_init', { dir: bare, write: false });
    const view = await call('mapx_arch_init', { dir: bare, view: 'proposed' });
    expect(existsSync(join(bare, '.mapx/architecture.jsonc'))).toBe(false);
    expect(dry.isError).toBeFalsy();
    const b = body(dry);
    expect(b).toMatchObject({ path: '.mapx/architecture.jsonc', view: null, exists: false, written: false, issues: [] });
    expect(body(explicit)).toEqual(b);
    expect(body(view)).toMatchObject({ path: '.mapx/architecture/proposed.jsonc', view: 'proposed', written: false });
    // Roles the scan assigned, in the archetype's order, each allowed to depend on the ones below.
    const layers = b.layers.map((l: { name: string; role: string }) => [l.name, l.role]);
    expect(layers.length).toBeGreaterThan(0);
    const doc = JSON.parse(stripJsonc(b.config)); // comments explain each layer and rule (M5-17)
    expect(doc.layers).toEqual(b.layers.map((l: { name: string; role: string }) => ({ name: l.name, selectors: [{ role: l.role }] })));
    expect(doc.rules).toEqual(Object.fromEntries(layers.map(([name]: string[], i: number) => [name, layers.slice(i + 1).map(([n]: string[]) => n)])));
  });

  it('write: true writes the proposal, which `mapx check` loads without a configuration error; never over an existing file', async () => {
    const r = await call('mapx_arch_init', { dir: bare, write: true });
    expect(r.isError).toBeFalsy();
    const b = body(r);
    expect(b).toMatchObject({ written: true, exists: false, path: '.mapx/architecture.jsonc' });
    const path = join(bare, '.mapx/architecture.jsonc');
    expect(readFileSync(path, 'utf8')).toBe(b.config);
    expect(mapxResult(bare, 'arch', 'validate-config').status).toBe(0);
    const check = cli(bare, 'check', '--format', 'json');
    expect(check.status).not.toBe(3);
    expect(check.json.counts.error).toBe(0);
    expect(check.json.configErrors).toEqual([]);
    // The MCP check agrees.
    expect(body(await call('mapx_arch_check', { dir: bare })).exitCode).toBe(check.status);
    // The server logs this call (a write call) into bare/.mapx/, the first .mapx/ it was called
    // on: only that log may change.
    const unlogged = () => { const s = snapshot(bare); delete s['.mapx/tool-calls.jsonl']; return s; };
    const before = unlogged();
    const again = await call('mapx_arch_init', { dir: bare, write: true });
    expect([again.isError, body(again).exitCode]).toEqual([true, 3]);
    expect(body(again).error).toContain('already exists');
    expect(unlogged()).toEqual(before);
  });
});

describe('the index gate (exitCode 4)', SLOW, () => {
  it('a stale index is a tool error unless sync: true; a workspace without an index too', async () => {
    appendFileSync(join(app, 'src/domain/Order.ts'), '// changed after the scan\n');
    const stale = await call('mapx_arch_allowed', { dir: app, from: 'Controller', to: 'Domain' });
    expect([stale.isError, body(stale).exitCode]).toEqual([true, 4]);
    expect(body(stale).error).toBe('The index is stale: 1 file(s) changed since the last scan (src/domain/Order.ts). Run `mapx_sync`, or `sync: true`.');
    // Arguments are checked before the index, as the CLI parses its options first: 3, not 4.
    for (const [name, args, cliArgs] of [
      ['mapx_arch_check', { failOn: 'bogus' }, ['check', '--fail-on', 'bogus']],
      ['mapx_arch_check', { format: 'bogus' }, ['check', '--format', 'bogus']],
      ['mapx_arch_explain', { element: 'Order', type: 'bogus' }, null],
      ['mapx_arch_layers', { limit: -1 }, null],
    ] as Array<[string, Record<string, unknown>, string[] | null]>) {
      const r = await call(name, { dir: app, ...args });
      expect([name, args, r.isError, body(r).exitCode]).toEqual([name, args, true, 3]);
      if (cliArgs) expect(mapxResult(app, ...cliArgs).status).toBe(3);
    }
    const synced = await call('mapx_arch_check', { dir: app, sync: true });
    expect(synced.isError).toBeFalsy();
    expect(body(synced).exitCode).toBe(1);
    expect((await call('mapx_arch_layers', { dir: app })).isError).toBeFalsy(); // synced
    const none = mkdtempSync(join(tmpdir(), 'mapx-mcp-arch-none-'));
    try {
      const r = await call('mapx_arch_layers', { dir: none });
      expect([r.isError, body(r)]).toEqual([true, { error: `No MapX index in ${none}: run \`mapx init\` and \`mapx scan\` first.`, exitCode: 4 }]);
      expect(readdirSync(none)).toEqual([]);
    } finally {
      rmSync(none, { recursive: true, force: true });
    }
  });
});
