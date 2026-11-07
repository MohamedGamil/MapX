import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// Usage: tsx scripts/build-all.ts [target …] [--outdir <dir>] [--dry-run]
//   --outdir   where binaries go (default: dist); tests build into a temp dir (M0-07-R2)
//   --dry-run  print the bun commands instead of running them
const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const VERSION = readFileSync(resolve(PROJECT_ROOT, 'VERSION'), 'utf-8').trim();

const argv = process.argv.slice(2);
const outdirAt = argv.indexOf('--outdir');
if (outdirAt >= 0 && !argv[outdirAt + 1]) {
  console.error('--outdir needs a directory');
  process.exit(2);
}
const outdir = outdirAt >= 0 ? resolve(argv[outdirAt + 1]!) : resolve(PROJECT_ROOT, 'dist');
const dryRun = argv.includes('--dry-run');
const positional = argv.filter((a, i) => !a.startsWith('--') && (outdirAt < 0 || i !== outdirAt + 1));

const allTargets = [
  { target: 'bun-linux-x64', outfile: join(outdir, 'mapx-linux-x64') },
  { target: 'bun-linux-arm64', outfile: join(outdir, 'mapx-linux-arm64') },
  { target: 'bun-darwin-arm64', outfile: join(outdir, 'mapx-darwin-arm64') },
  { target: 'bun-darwin-x64', outfile: join(outdir, 'mapx-darwin-x64') },
  { target: 'bun-windows-x64', outfile: join(outdir, 'mapx-windows-x64.exe') },
];

// `tsx scripts/build-all.ts linux-x64 …` builds only the named targets (the package.json
// build:* scripts use this so every binary gets the VERSION define).
const only = positional;
const targets = only.length ? allTargets.filter(t => only.some(o => t.target === `bun-${o}`)) : allTargets;
if (only.length && targets.length !== only.length) {
  console.error(`Unknown target in: ${only.join(', ')}`);
  process.exit(2);
}

// A full build refreshes the WASM grammars; a single-target build reuses the committed ones.
if (!only.length && !dryRun) {
  console.log('Building WASM grammars...');
  try {
    execSync('npx tsx scripts/build-wasm.ts', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  } catch {
    console.log('WASM build had issues (may already be built)');
  }
}

console.log('\nBuilding binaries...');
for (const { target, outfile } of targets) {
  const command = `bun build --compile --minify --define MAPX_BUILD_VERSION='"${VERSION}"' --target=${target} ./src/main.ts ./src/parsers/parse-worker.ts --outfile ${JSON.stringify(outfile)}`;
  if (dryRun) {
    console.log(`  ${command}`);
    continue;
  }
  try {
    console.log(`  Building ${outfile}...`);
    execSync(command, { cwd: PROJECT_ROOT, stdio: 'pipe' });
    console.log(`  ✓ ${outfile}`);
  } catch (e: any) {
    console.log(`  ✗ ${outfile}: ${e.message?.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

console.log('\nDone.');
