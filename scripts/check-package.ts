// Fails when the npm package would ship files it must not (docs/baton D005), or when the
// dashboard bundle exceeds its gzipped size ceiling (D006).
// Usage: npx tsx scripts/check-package.ts [--max-ui-gzip <bytes>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const maxAt = args.indexOf('--max-ui-gzip');
// D006: a regression ceiling over the 690,760-byte bundle measured on 2026-10-30.
const DEFAULT_MAX_UI_GZIP = 720 * 1024;
const maxUiGzip = maxAt >= 0 ? Number(args[maxAt + 1]) : DEFAULT_MAX_UI_GZIP;

const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
) as { files: { path: string; size: number }[]; size: number; unpackedSize: number }[];
const problems: string[] = [];
for (const file of pack.files) if (file.path.endsWith('.map')) problems.push(`source map packed: ${file.path}`);

const ui = 'dist/ui/main.js';
const uiGzip = existsSync(ui) ? gzipSync(readFileSync(ui)).length : null;
if (uiGzip === null) problems.push(`${ui} missing; run npm run build:npm first`);
else if (uiGzip > maxUiGzip) problems.push(`${ui} is ${uiGzip} bytes gzipped, above ${maxUiGzip}`);

console.log(
  `Package: ${pack.files.length} files, ${pack.size} bytes packed, ${pack.unpackedSize} unpacked; ${ui} gzipped: ${uiGzip ?? 'n/a'} bytes (ceiling ${maxUiGzip}).`,
);
for (const p of problems) console.error(`FAIL ${p}`);
process.exitCode = problems.length ? 1 : 0;
