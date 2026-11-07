// Scores frontend HTTP call extraction and backend pairing against a labelled fixture
// (docs/baton M2-02, contract D008). Builds a parent-folder workspace with the Laravel route
// fixture as backend/ and each Vue app as frontend-<app>/, runs the real CLI (init + scan) and
// reads .mapx/http-calls.json.
//   npx tsx scripts/eval/score-http.ts <vue-http-fixture> [--json] [--min-recall R] [--min-precision P]
// Exit code 1 when a threshold is missed; 2 on usage or scan errors (unknown, repeated or
// malformed options are usage errors, M4-08).
import { execFileSync } from 'node:child_process';
import { parseScorerArgs } from './args.ts';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** D008: one record per client call site in .mapx/http-calls.json. */
export interface HttpCallRecord {
  file: string;
  line: number;
  method: string;
  rawUrl: string;
  url?: string;
  pattern?: string;
  route?: { method: string; path: string; handlerSymbol?: string; handlerFile: string } | null;
}
export interface HttpLabel {
  id: string;
  pattern: string;
  file: string;
  line: number;
  method: string;
  url: string;
  route: string | null;
  /** Expected handler of `route` as ShortClass@method, null for a closure (M2-06-R1). */
  handler?: string | null;
}
interface PatternScore {
  labelled: number;
  found: number;
  urlResolved: number;
  pairLabelled: number;
  pairedCorrect: number;
  unmatchedLabelled: number;
  unmatchedCorrect: number;
  wrongPairs: number;
}
export interface HttpScore {
  patterns: Record<string, PatternScore>;
  totals: PatternScore & {
    reported: number;
    unlabelled: number;
    callSiteRecall: number;
    urlRecall: number;
    pairingRecall: number;
    pairingPrecision: number;
  };
  misses: string[];
}

const ROOT = resolve(import.meta.dirname, '../..');
const BACKEND = join(ROOT, 'tests/fixtures/laravel-routes');

/** Request path with every parameter as {} and no trailing slash: /api/x/{id}/ → /api/x/{}. */
export const normUrl = (url: string) =>
  ('/' + url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, ''))
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\$\{[^}]*\}/g, '{}');
const normRoute = (method: string, path: string) => `${method.toUpperCase()} ${normUrl(path)}`;
/** Handler without its namespace: App\\Http\\Controllers\\PostController@index → PostController@index. */
export const shortHandler = (symbol: string | undefined) => (symbol ? symbol.split('\\').pop()! : null);
/** Fixture app dir → workspace dir: vue2/src/x.js ↔ frontend-vue2/src/x.js. */
export const workspacePath = (labelFile: string) => labelFile.replace(/^([^/]+)\//, 'frontend-$1/');

export function scoreHttp(labels: HttpLabel[], records: HttpCallRecord[]): HttpScore {
  const patterns: Record<string, PatternScore> = {};
  const misses: string[] = [];
  const used = new Set<HttpCallRecord>();
  for (const l of labels) {
    const p = (patterns[l.pattern] ??= {
      labelled: 0, found: 0, urlResolved: 0, pairLabelled: 0, pairedCorrect: 0,
      unmatchedLabelled: 0, unmatchedCorrect: 0, wrongPairs: 0,
    });
    p.labelled++;
    if (l.route) p.pairLabelled++;
    else p.unmatchedLabelled++;
    const candidates = records.filter(
      (r) => !used.has(r) && r.file === workspacePath(l.file) && r.method.toUpperCase() === l.method && r.line === l.line,
    );
    const record = candidates.find((r) => r.url && normUrl(r.url) === normUrl(l.url)) ?? candidates[0];
    if (!record) {
      misses.push(`${l.id} ${l.pattern} ${l.method} ${l.url} @ ${l.file}:${l.line} not extracted`);
      continue;
    }
    used.add(record);
    p.found++;
    if (record.url && normUrl(record.url) === normUrl(l.url)) p.urlResolved++;
    else misses.push(`${l.id} ${l.pattern} url ${record.url ?? '(unresolved)'} ≠ ${l.url}`);
    const got = record.route ? normRoute(record.route.method, record.route.path) : null;
    if (!l.route) {
      if (got) {
        p.wrongPairs++;
        misses.push(`${l.id} ${l.pattern} paired with ${got}, expected unmatched`);
      } else p.unmatchedCorrect++;
    } else {
      const [method, path] = l.route.split(' ');
      // The right route is not enough: it must be the handler that serves it (M2-06-R1).
      const handler = shortHandler(record.route?.handlerSymbol);
      const handlerOk = l.handler === undefined || handler === l.handler;
      if (got === normRoute(method!, path!) && handlerOk) p.pairedCorrect++;
      else {
        if (got) p.wrongPairs++;
        misses.push(`${l.id} ${l.pattern} paired with ${got ?? 'nothing'}${got ? ` (${handler})` : ''}, expected ${l.route} (${l.handler})`);
      }
    }
  }
  const unlabelled = records.filter((r) => !used.has(r));
  const sum = (k: keyof PatternScore) => Object.values(patterns).reduce((s, p) => s + p[k], 0);
  const t = {
    labelled: sum('labelled'), found: sum('found'), urlResolved: sum('urlResolved'),
    pairLabelled: sum('pairLabelled'), pairedCorrect: sum('pairedCorrect'),
    unmatchedLabelled: sum('unmatchedLabelled'), unmatchedCorrect: sum('unmatchedCorrect'),
    wrongPairs: sum('wrongPairs'),
  };
  const reportedPairs = t.pairedCorrect + t.wrongPairs + unlabelled.filter((r) => r.route).length;
  return {
    patterns,
    totals: {
      ...t,
      reported: records.length,
      unlabelled: unlabelled.length,
      callSiteRecall: t.labelled ? t.found / t.labelled : 1,
      urlRecall: t.labelled ? t.urlResolved / t.labelled : 1,
      pairingRecall: t.pairLabelled ? t.pairedCorrect / t.pairLabelled : 1,
      // No pairs reported means nothing was wrong, but recall carries the failure.
      pairingPrecision: reportedPairs ? t.pairedCorrect / reportedPairs : 1,
    },
    misses,
  };
}

/**
 * Scans the composed workspace and returns the D008 records (empty when the file is absent).
 * `config: false` leaves out the fixture's http-config.json (settings.http).
 */
export function scanHttpFixture(fixture: string, { config = true }: { config?: boolean } = {}): HttpCallRecord[] {
  const work = mkdtempSync(join(tmpdir(), 'mapx-score-http-'));
  try {
    cpSync(BACKEND, join(work, 'backend'), { recursive: true });
    for (const app of readdirSync(fixture, { withFileTypes: true }))
      if (app.isDirectory()) cpSync(join(fixture, app.name), join(work, `frontend-${app.name}`), { recursive: true });
    const tsx = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
    const run = (...args: string[]) =>
      execFileSync(process.execPath, ['--import', tsx, join(ROOT, 'src/main.ts'), ...args], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
      });
    run('init', work, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    const extra = join(fixture, 'http-config.json');
    if (config && existsSync(extra)) {
      const configPath = join(work, '.mapx', 'config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.settings = { ...config.settings, ...JSON.parse(readFileSync(extra, 'utf8')).settings };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
    run('scan', work);
    const out = join(work, '.mapx', 'http-calls.json');
    return existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as HttpCallRecord[]) : [];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The command line, strictly (M4-08): unknown, repeated or malformed options throw. */
export function parseHttpArgs(args: string[]) {
  const parsed = parseScorerArgs(args, {
    booleans: ['json'],
    thresholds: { 'min-recall': 'ratio', 'min-precision': 'ratio' },
    requiredFile: 'labels.json',
  });
  return {
    fixture: parsed.fixture,
    json: parsed.flags.has('json'),
    minRecall: parsed.thresholds['min-recall'] ?? null,
    minPrecision: parsed.thresholds['min-precision'] ?? null,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
function main() {
  let opts: ReturnType<typeof parseHttpArgs>;
  try {
    opts = parseHttpArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error('Usage: score-http.ts <fixture-dir> [--json] [--min-recall R] [--min-precision P]');
    process.exit(2);
  }
  const { fixture } = opts;
  const labels = (JSON.parse(readFileSync(join(fixture, 'labels.json'), 'utf8')) as { labels: HttpLabel[] }).labels;
  const result = scoreHttp(labels, scanHttpFixture(resolve(fixture)));
  const t = result.totals;
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('pattern              labelled  found  url  paired  unmatched  wrong');
    for (const [name, p] of Object.entries(result.patterns))
      console.log(`${name.padEnd(20)} ${String(p.labelled).padStart(8)} ${String(p.found).padStart(6)} ${String(p.urlResolved).padStart(4)} ${`${p.pairedCorrect}/${p.pairLabelled}`.padStart(7)} ${`${p.unmatchedCorrect}/${p.unmatchedLabelled}`.padStart(10)} ${String(p.wrongPairs).padStart(6)}`);
    console.log(`\nCall-site recall ${pct(t.callSiteRecall)}, URL recall ${pct(t.urlRecall)}, pairing recall ${pct(t.pairingRecall)}, pairing precision ${pct(t.pairingPrecision)}, unlabelled records ${t.unlabelled}`);
    for (const m of result.misses) console.log(`  miss: ${m}`);
  }
  const failures: string[] = [];
  const { minRecall, minPrecision } = opts;
  if (minRecall !== null && t.pairingRecall < minRecall) failures.push(`pairing recall below ${minRecall}`);
  if (minPrecision !== null && t.pairingPrecision < minPrecision) failures.push(`pairing precision below ${minPrecision}`);
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
