// Scores MapX route extraction against a labelled fixture (docs/baton M1-01).
// Copies the fixture to a temp dir, runs the real CLI (init + scan), reads .mapx/routes.json.
//   npx tsx scripts/eval/score-routes.ts <fixture-dir> [--json] [--min-recall R] [--max-fp N]
//     [--min-precision P] [--strict-params]
// --min-recall applies to URI, handler and labelled-attribute (name, domain, dynamic) recall.
// Exit code 1 when a threshold is missed; 2 on usage or scan errors (unknown, repeated or
// malformed options are usage errors, M4-08).
import { execFileSync } from 'node:child_process';
import { parseScorerArgs } from './args.ts';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Label {
  id: string;
  pattern: string;
  method: string;
  uri: string;
  handler: string | null;
  expect: 'live' | 'conditional' | 'overridden' | 'unreachable' | 'absent';
  /** Route attributes a live or conditional route must carry (M1-07-R2). */
  name?: string;
  domain?: string;
  dynamic?: boolean;
}
export interface ReportedRoute {
  method: string;
  path: string;
  handlerSymbol?: string;
  metadata?: Record<string, any>;
}
interface PatternScore {
  labelled: number;
  uriFound: number;
  handlerLabelled: number;
  handlerFound: number;
  exactParams: number;
  flagged: number;
  falsePositives: number;
  /** Labelled route attributes (name, domain, dynamic), and how many the matched route carries. */
  attributesLabelled: number;
  attributesFound: number;
}
export interface Score {
  patterns: Record<string, PatternScore>;
  totals: PatternScore & {
    reported: number;
    unlabelled: number;
    uriRecall: number;
    handlerRecall: number;
    attributeRecall: number;
    precision: number;
  };
  misses: string[];
  unlabelledRoutes: string[];
}

const ROOT = resolve(import.meta.dirname, '../..');

export const normUri = (uri: string, strict = false) =>
  uri
    .replace(/^\/+|\/+$/g, '')
    .replace(/\{([^}]*)\}/g, (_, name: string) => (strict ? `{${name.replace(/\?$/, '')}}` : '{}'));
const methods = (m: string) => m.toUpperCase().split(/[|,]/).map((x) => x.trim());
const shortHandler = (h?: string) => {
  if (!h || !h.includes('@')) return null;
  const [cls, method] = h.split('@');
  return `${cls!.split('\\').pop()}@${method}`;
};
const live = (r: ReportedRoute) => r.metadata?.reachable !== false && r.metadata?.overridden !== true;
const ATTRIBUTES = ['name', 'domain', 'dynamic'] as const;
/** A route attribute as reported; dynamic is a flag whose absence means false. */
const attribute = (r: ReportedRoute, key: (typeof ATTRIBUTES)[number]) =>
  key === 'dynamic' ? r.metadata?.dynamic === true : r.metadata?.[key];

export function score(labels: Label[], routes: ReportedRoute[], strictParams = false): Score {
  const patterns: Record<string, PatternScore> = {};
  const misses: string[] = [];
  const matched = new Set<ReportedRoute>();
  const same = (l: Label, r: ReportedRoute) =>
    methods(r.method).includes(l.method) && normUri(r.path, strictParams) === normUri(l.uri, strictParams);
  for (const l of labels) {
    const p = (patterns[l.pattern] ??= {
      labelled: 0, uriFound: 0, handlerLabelled: 0, handlerFound: 0, exactParams: 0, flagged: 0, falsePositives: 0,
      attributesLabelled: 0, attributesFound: 0,
    });
    const candidates = routes.filter((r) => same(l, r));
    if (l.expect === 'absent') {
      // Route code that must never be reported (comments, strings, a prefix that never mounts).
      p.labelled++;
      for (const r of candidates) matched.add(r);
      if (candidates.length) {
        p.falsePositives += candidates.length;
        misses.push(`${l.id} absent ${l.method} ${l.uri} reported`);
      } else p.flagged++;
      continue;
    }
    if (l.expect === 'overridden' || l.expect === 'unreachable') {
      // Negative: the losing or unmounted declaration must be reported, flagged, and not live.
      // An absent route is a miss, not a credit: it proves nothing about the flag.
      const offending = candidates.filter(
        (r) => live(r) && (l.expect === 'unreachable' || shortHandler(r.handlerSymbol) === l.handler),
      );
      const own = (r: ReportedRoute) => !l.handler || shortHandler(r.handlerSymbol) === l.handler;
      const flaggedRoute = candidates.find((r) =>
        own(r) && (l.expect === 'overridden' ? r.metadata?.overridden === true : r.metadata?.reachable === false));
      for (const r of candidates) if (!live(r) || shortHandler(r.handlerSymbol) === l.handler) matched.add(r);
      p.labelled++;
      if (offending.length) {
        p.falsePositives += offending.length;
        misses.push(`${l.id} ${l.expect} ${l.method} ${l.uri} reported as live`);
      } else if (flaggedRoute) p.flagged++;
      else misses.push(`${l.id} ${l.expect} ${l.method} ${l.uri} not reported with the ${l.expect} flag`);
      continue;
    }
    p.labelled++;
    if (l.handler) p.handlerLabelled++;
    const liveCandidates = candidates.filter(live);
    const best =
      liveCandidates.find((r) => shortHandler(r.handlerSymbol) === l.handler) ?? liveCandidates[0];
    if (!best) {
      misses.push(`${l.id} ${l.pattern} ${l.method} /${l.uri} not found`);
      continue;
    }
    matched.add(best);
    p.uriFound++;
    if (normUri(best.path, true) === normUri(l.uri, true)) p.exactParams++;
    if (l.handler) {
      if (shortHandler(best.handlerSymbol) === l.handler) p.handlerFound++;
      else misses.push(`${l.id} ${l.pattern} ${l.method} /${l.uri} handler ${best.handlerSymbol ?? '-'} ≠ ${l.handler}`);
    }
    for (const key of ATTRIBUTES) {
      if (l[key] === undefined) continue;
      p.attributesLabelled++;
      if (attribute(best, key) === l[key]) p.attributesFound++;
      else misses.push(`${l.id} ${l.pattern} ${l.method} /${l.uri} ${key} ${JSON.stringify(attribute(best, key) ?? null)} ≠ ${JSON.stringify(l[key])}`);
    }
    if (l.expect === 'conditional') {
      if (best.metadata?.conditional === true) p.flagged++;
      else misses.push(`${l.id} conditional ${l.method} /${l.uri} not flagged conditional`);
    }
  }
  const unlabelled = routes.filter((r) => !matched.has(r) && live(r));
  const sum = (k: keyof PatternScore) => Object.values(patterns).reduce((s, p) => s + p[k], 0);
  const t = {
    labelled: sum('labelled'), uriFound: sum('uriFound'), handlerLabelled: sum('handlerLabelled'),
    handlerFound: sum('handlerFound'), exactParams: sum('exactParams'), flagged: sum('flagged'),
    falsePositives: sum('falsePositives'), attributesLabelled: sum('attributesLabelled'), attributesFound: sum('attributesFound'),
  };
  const positives = labels.filter((l) => l.expect === 'live' || l.expect === 'conditional').length;
  const reportedLive = routes.filter(live).length;
  return {
    patterns,
    totals: {
      ...t,
      reported: routes.length,
      unlabelled: unlabelled.length,
      uriRecall: positives ? t.uriFound / positives : 1,
      handlerRecall: t.handlerLabelled ? t.handlerFound / t.handlerLabelled : 1,
      attributeRecall: t.attributesLabelled ? t.attributesFound / t.attributesLabelled : 1,
      precision: reportedLive ? (reportedLive - unlabelled.length - t.falsePositives) / reportedLive : 1,
    },
    misses,
    unlabelledRoutes: unlabelled.map((r) => `${r.method} ${r.path} ${r.handlerSymbol ?? '-'}`),
  };
}

export function scanFixture(fixture: string): ReportedRoute[] {
  const work = mkdtempSync(join(tmpdir(), 'mapx-score-'));
  try {
    cpSync(fixture, work, { recursive: true });
    const tsx = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
    const run = (...args: string[]) =>
      execFileSync(process.execPath, ['--import', tsx, join(ROOT, 'src/main.ts'), ...args], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
      });
    run('init', work, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    run('scan', work);
    return JSON.parse(readFileSync(join(work, '.mapx', 'routes.json'), 'utf8')) as ReportedRoute[];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The command line, strictly (M4-08): unknown, repeated or malformed options throw. */
export function parseRoutesArgs(args: string[]) {
  const parsed = parseScorerArgs(args, {
    booleans: ['json', 'strict-params'],
    requiredFile: 'labels.json',
    thresholds: { 'min-recall': 'ratio', 'min-precision': 'ratio', 'max-fp': 'count' },
  });
  const t = parsed.thresholds;
  return {
    fixture: parsed.fixture,
    json: parsed.flags.has('json'),
    strictParams: parsed.flags.has('strict-params'),
    minRecall: t['min-recall'] ?? null,
    minPrecision: t['min-precision'] ?? null,
    maxFp: t['max-fp'] ?? null,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
function main() {
  let opts: ReturnType<typeof parseRoutesArgs>;
  try {
    opts = parseRoutesArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error('Usage: score-routes.ts <fixture-dir> [--json] [--min-recall R] [--max-fp N] [--min-precision P] [--strict-params]');
    process.exit(2);
  }
  const { fixture } = opts;
  const labels = (JSON.parse(readFileSync(join(fixture, 'labels.json'), 'utf8')) as { labels: Label[] }).labels;
  const result = score(labels, scanFixture(resolve(fixture)), opts.strictParams);
  const t = result.totals;
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('pattern            labelled  uri  handler  exact-params  flagged  FP  attributes');
    for (const [name, p] of Object.entries(result.patterns))
      console.log(`${name.padEnd(18)} ${String(p.labelled).padStart(8)} ${String(p.uriFound).padStart(4)} ${`${p.handlerFound}/${p.handlerLabelled}`.padStart(8)} ${String(p.exactParams).padStart(13)} ${String(p.flagged).padStart(8)} ${String(p.falsePositives).padStart(3)} ${`${p.attributesFound}/${p.attributesLabelled}`.padStart(11)}`);
    console.log(`\nURI recall ${pct(t.uriRecall)}, handler recall ${pct(t.handlerRecall)}, attribute recall ${pct(t.attributeRecall)}, precision ${pct(t.precision)}, false positives ${t.falsePositives}, unlabelled live routes ${t.unlabelled}`);
    for (const m of result.misses) console.log(`  miss: ${m}`);
    for (const u of result.unlabelledRoutes) console.log(`  unlabelled: ${u}`);
  }
  const failures: string[] = [];
  const { minRecall, maxFp, minPrecision } = opts;
  if (minRecall !== null && (t.uriRecall < minRecall || t.handlerRecall < minRecall || t.attributeRecall < minRecall))
    failures.push(`recall below ${minRecall}`);
  if (maxFp !== null && t.falsePositives > maxFp) failures.push(`false positives ${t.falsePositives} > ${maxFp}`);
  if (minPrecision !== null && t.precision < minPrecision) failures.push(`precision below ${minPrecision}`);
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
