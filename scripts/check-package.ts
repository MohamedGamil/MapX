// Fails when the npm package would ship files it must not (docs/baton D005), or when the
// dashboard bundle exceeds its gzipped size ceiling (D006).
// Usage: npx tsx scripts/check-package.ts [--max-ui-gzip <bytes>]
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Native executables must never ship in the npm package: `files` includes dist/, where the
// bun build:* scripts write ~96 MB binaries (M0-07-R2). Detected by magic bytes, not by name.
const NATIVE_MAGIC: [string, number[]][] = [
  ['ELF', [0x7f, 0x45, 0x4c, 0x46]],
  ['Mach-O', [0xcf, 0xfa, 0xed, 0xfe]],
  ['Mach-O', [0xce, 0xfa, 0xed, 0xfe]],
  ['Mach-O', [0xfe, 0xed, 0xfa, 0xcf]],
  ['Mach-O universal', [0xca, 0xfe, 0xba, 0xbe]],
  ['PE', [0x4d, 0x5a]],
];

function nativeKind(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const head = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  return NATIVE_MAGIC.find(([, magic]) => magic.every((b, i) => head[i] === b))?.[0];
}

const args = process.argv.slice(2);
const maxAt = args.indexOf('--max-ui-gzip');
// D006: a regression ceiling over the 690,760-byte bundle measured on 2026-10-30.
const DEFAULT_MAX_UI_GZIP = 720 * 1024;
const maxUiGzip = maxAt >= 0 ? Number(args[maxAt + 1]) : DEFAULT_MAX_UI_GZIP;

const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
) as { files: { path: string; size: number }[]; size: number; unpackedSize: number }[];
const problems: string[] = [];
for (const file of pack.files) {
  if (file.path.endsWith('.map')) problems.push(`source map packed: ${file.path}`);
  const kind = nativeKind(file.path);
  if (kind) problems.push(`native ${kind} binary packed: ${file.path} (${file.size} bytes)`);
}

// The dashboard's initial JavaScript: main.js and the chunks it imports statically (M4-20 splits
// the bundle; the layout engines other than fCoSE and the layout worker load on demand).
const ui = 'dist/ui/main.js';
/** M4-16 baseline: the single main.js, gzipped (docs/research/dashboard-ux-audit/metrics.json). */
const BASELINE_UI_GZIP = 690763;
function staticImports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  // Static imports only: `import ... from "./x.js"` and bare `import "./x.js"`, not import("./x.js").
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.\/[^"']+)["']/g)) {
    const target = join(dirname(file), m[1]!);
    if (!existsSync(target)) problems.push(`${file} imports missing ${target}`);
    else staticImports(target, seen);
  }
  return seen;
}
let uiGzip: number | null = null;
if (!existsSync(ui)) problems.push(`${ui} missing; run npm run build:npm first`);
else {
  const initial = [...staticImports(ui)];
  uiGzip = initial.reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);
  if (uiGzip > maxUiGzip) problems.push(`initial dashboard JavaScript (${initial.join(', ')}) is ${uiGzip} bytes gzipped, above ${maxUiGzip}`);
  // M4-20: at least 30% below the M4-16 baseline.
  if (uiGzip > BASELINE_UI_GZIP * 0.7) problems.push(`initial dashboard JavaScript is ${uiGzip} bytes gzipped, not 30% below the M4-16 baseline (${BASELINE_UI_GZIP})`);
  // Every chunk the build wrote must be in the package: lazy chunks are loaded at run time.
  const packed = new Set(pack.files.map((f) => f.path));
  const chunkDir = 'dist/ui/chunks';
  if (existsSync(chunkDir)) for (const f of readdirSync(chunkDir)) if (!packed.has(`${chunkDir}/${f}`)) problems.push(`dashboard chunk not packed: ${chunkDir}/${f}`);
  if (existsSync('dist/ui/layout-worker.js') && !packed.has('dist/ui/layout-worker.js')) problems.push('dist/ui/layout-worker.js not packed');
}

console.log(
  `Package: ${pack.files.length} files, ${pack.size} bytes packed, ${pack.unpackedSize} unpacked; initial dashboard JavaScript gzipped: ${uiGzip ?? 'n/a'} bytes (ceiling ${maxUiGzip}; M4-16 baseline ${BASELINE_UI_GZIP}${uiGzip ? `, ${Math.round((1 - uiGzip / BASELINE_UI_GZIP) * 100)}% smaller` : ''}).`,
);
for (const p of problems) console.error(`FAIL ${p}`);
process.exitCode = problems.length ? 1 : 0;
