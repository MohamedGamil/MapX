// Scan scaling benchmark (docs/baton M4-03). Generates synthetic TypeScript workspaces in a temp
// dir: file i (`src/d<i % 50>/m<i>.ts`) imports and calls two other files' functions and declares a
// class with methods `run` and `helper`, so those two names are declared in every file, as common
// method names are in real code. Runs the real CLI (init + scan) at each size and prints the scan
// wall times and the ratio of the largest to the smallest. No real code is involved.
//   npx tsx scripts/bench/scan-scaling.ts [--sizes 8000,16000] [--max-ratio X] [--json]
// Exit code 1 when the ratio exceeds --max-ratio; 2 on usage or scan errors.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '../..');
const MAIN = join(REPO, 'src/main.ts');
const TSX = pathToFileURL(join(REPO, 'node_modules/tsx/dist/loader.mjs')).href;

function value(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return v;
}

const SIZES = (value('sizes') ?? '8000,16000').split(',').map(Number);
if (SIZES.length < 2 || SIZES.some((n) => !Number.isInteger(n) || n < 2)) {
  console.error('--sizes needs at least two integers ≥ 2, e.g. 8000,16000');
  process.exit(2);
}
const maxRatioArg = value('max-ratio');
const MAX_RATIO = maxRatioArg === null ? null : Number(maxRatioArg);
if (MAX_RATIO !== null && !(MAX_RATIO > 0)) {
  console.error('--max-ratio needs a positive number');
  process.exit(2);
}

function generate(dir: string, n: number) {
  const folder = (i: number) => `d${i % 50}`;
  for (let i = 0; i < n; i++) {
    const a = (i * 7 + 1) % n;
    const b = (i * 13 + 5) % n;
    const rel = (j: number) => (folder(j) === folder(i) ? `./m${j}` : `../${folder(j)}/m${j}`);
    mkdirSync(join(dir, 'src', folder(i)), { recursive: true });
    writeFileSync(join(dir, 'src', folder(i), `m${i}.ts`), `import { f${a} } from '${rel(a)}';
import { f${b} } from '${rel(b)}';
export class C${i} { run(x: number) { return this.helper(x) + f${a}(x); } helper(x: number) { return x * 2; } }
export function f${i}(x: number): number { return x > 0 ? f${b}(x - 1) : new C${i}().helper(x); }
`);
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scan-scaling', version: '1.0.0' }));
}

const cli = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, ['--import', TSX, MAIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });

const work = mkdtempSync(join(tmpdir(), 'mapx-scan-scaling-'));
try {
  const seconds: number[] = [];
  for (const n of SIZES) {
    const dir = join(work, `w${n}`);
    generate(dir, n);
    cli(dir, 'init', dir, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    const started = process.hrtime.bigint();
    cli(dir, 'scan', dir);
    seconds.push(Number(process.hrtime.bigint() - started) / 1e9);
    rmSync(dir, { recursive: true, force: true });
  }
  const ratio = +(seconds[seconds.length - 1]! / seconds[0]!).toFixed(2);
  const result = { sizes: SIZES, seconds: seconds.map((s) => +s.toFixed(2)), ratio, sizeRatio: SIZES[SIZES.length - 1]! / SIZES[0]! };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else {
    for (let i = 0; i < SIZES.length; i++) console.log(`${String(SIZES[i]).padStart(7)} files: ${result.seconds[i]} s`);
    console.log(`time ratio ${ratio} for a size ratio of ${result.sizeRatio}`);
  }
  if (MAX_RATIO !== null && ratio > MAX_RATIO) {
    console.error(`ratio ${ratio} exceeds --max-ratio ${MAX_RATIO}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
} finally {
  rmSync(work, { recursive: true, force: true });
}
