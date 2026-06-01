import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const VERSION = readFileSync(resolve(PROJECT_ROOT, 'VERSION'), 'utf-8').trim();

const targets = [
  { target: 'bun-linux-x64', outfile: 'dist/mapx-linux-x64' },
  { target: 'bun-linux-arm64', outfile: 'dist/mapx-linux-arm64' },
  { target: 'bun-darwin-arm64', outfile: 'dist/mapx-darwin-arm64' },
  { target: 'bun-darwin-x64', outfile: 'dist/mapx-darwin-x64' },
  { target: 'bun-windows-x64', outfile: 'dist/mapx-windows-x64.exe' },
];

console.log('Building WASM grammars...');
try {
  execSync('npx tsx scripts/build-wasm.ts', { cwd: PROJECT_ROOT, stdio: 'inherit' });
} catch {
  console.log('WASM build had issues (may already be built)');
}

console.log('\nBuilding binaries...');
for (const { target, outfile } of targets) {
  try {
    console.log(`  Building ${outfile}...`);
    execSync(
      `bun build --compile --minify --define MAPX_BUILD_VERSION='"${VERSION}"' --target=${target} ./src/main.ts --outfile ${outfile}`,
      { cwd: PROJECT_ROOT, stdio: 'pipe' }
    );
    console.log(`  ✓ ${outfile}`);
  } catch (e: any) {
    console.log(`  ✗ ${outfile}: ${e.message?.split('\n')[0]}`);
  }
}

console.log('\nDone.');
