import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workspace, init, mapx, query, cleanup } from './helpers/e2e.js';

// M5-25: a package-qualified Go composite literal (`domain.Order{}`) is an instantiation edge to the
// type in the imported project package, never a homonym elsewhere and never a library type.
interface Row { id: string; app: string; edgeType?: string; from?: { file: string; symbol?: string }; to?: { file: string; symbol?: string } }
interface Edge { source_file: string; target_file: string; target_symbol: string; edge_type: string }

const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');
const rows = (JSON.parse(readFileSync(join(FIXTURE, 'expected-findings.json'), 'utf8')).rows as Row[])
  .filter((r) => r.app === 'go' && r.edgeType === 'instantiation' && r.from && r.to);

let app = '';
let ws = '';
beforeAll(() => {
  app = mkdtempSync(join(tmpdir(), 'mapx-go-qualified-'));
  cpSync(join(FIXTURE, 'go'), app, { recursive: true });
  init(app);
  mapx(app, 'scan');

  ws = workspace({
    'go.mod': 'module example.com/shop\n\nrequire github.com/acme/money v1.0.0\n',
    'domain/order.go': 'package domain\n\ntype Order struct{}\n',
    // A homonym in another package: an unrelated `Order` the qualified literal must not reach.
    'legacy/order.go': 'package legacy\n\ntype Order struct{}\n',
    // Third-party (not in the workspace) and standard-library types named like project ones.
    'billing/time.go': 'package billing\n\ntype Time struct{}\n\ntype Amount struct{}\n',
    'app/use.go': [
      'package app',
      '',
      'import (',
      '\td "example.com/shop/domain"',
      '\t"github.com/acme/money"',
      '\t"time"',
      ')',
      '',
      'func Use() {',
      '\t_ = d.Order{}',
      '\t_ = time.Time{}',
      '\t_ = money.Amount{}',
      '}',
      '',
    ].join('\n'),
  });
  init(ws);
  mapx(ws, 'scan');
}, 120_000);
afterAll(() => { cleanup(app); cleanup(ws); });

describe('Go package-qualified composite literals (M5-25)', () => {
  it('the fixture app has an instantiation edge for every labelled cross-package literal', () => {
    const edges = query<Edge>(app, "SELECT source_file, target_file, target_symbol, edge_type FROM edges WHERE edge_type = 'instantiation'");
    const crossPackage = rows.filter((r) => r.from!.file.split('/').slice(0, -1).join('/') !== r.to!.file.split('/').slice(0, -1).join('/'));
    expect(crossPackage.map((r) => r.id)).toEqual(expect.arrayContaining(['go-05', 'go-06', 'go-07', 'go-08', 'go-16', 'go-17', 'go-22', 'go-23']));
    for (const r of crossPackage) {
      expect(edges.some((e) => e.source_file === r.from!.file && e.target_file === r.to!.file && e.target_symbol === r.to!.symbol), r.id).toBe(true);
    }
  });

  it('an aliased import resolves to its package; a homonym, the standard library and a third-party package do not', () => {
    const edges = query<Edge>(ws, "SELECT source_file, target_file, target_symbol, edge_type FROM edges WHERE source_file = 'app/use.go' AND edge_type = 'instantiation'");
    expect(edges.map((e) => `${e.target_file}#${e.target_symbol}`)).toEqual(['domain/order.go#Order']);
  });
});
