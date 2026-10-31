// Fails when the npm package would ship files it must not (docs/baton D005), or when the
// dashboard bundle exceeds its gzipped size ceiling (D006).
// Usage: npx tsx scripts/check-package.ts [--max-ui-gzip <bytes>]
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
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

const ui = 'dist/ui/main.js';
const uiGzip = existsSync(ui) ? gzipSync(readFileSync(ui)).length : null;
if (uiGzip === null) problems.push(`${ui} missing; run npm run build:npm first`);
else if (uiGzip > maxUiGzip) problems.push(`${ui} is ${uiGzip} bytes gzipped, above ${maxUiGzip}`);

console.log(
  `Package: ${pack.files.length} files, ${pack.size} bytes packed, ${pack.unpackedSize} unpacked; ${ui} gzipped: ${uiGzip ?? 'n/a'} bytes (ceiling ${maxUiGzip}).`,
);
for (const p of problems) console.error(`FAIL ${p}`);
process.exitCode = problems.length ? 1 : 0;
