import { build } from 'esbuild';
import { mkdirSync, copyFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  if (process.env.MAPX_NO_UI === '1') {
    console.error('MAPX_NO_UI is set. Skipping UI client build.');
    return;
  }

  const srcDir = resolve('src/ui');
  const distDir = resolve('dist/ui');

  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }
  // Drop a map left over from an earlier opt-in build.
  rmSync(resolve(distDir, 'main.js.map'), { force: true });

  // Progress goes to stderr: npm prints lifecycle output on stdout, as part of `npm pack --json`.
  console.error('Bundling Mapx Web Dashboard client...');

  // Copy static HTML and CSS
  copyFileSync(resolve(srcDir, 'index.html'), resolve(distDir, 'index.html'));
  if (existsSync(resolve(srcDir, 'styles.css'))) {
    copyFileSync(resolve(srcDir, 'styles.css'), resolve(distDir, 'styles.css'));
  }
  // The logo and favicons (scripts/brand/logo-assets.sh, D028).
  if (existsSync(resolve(srcDir, 'assets'))) {
    cpSync(resolve(srcDir, 'assets'), resolve(distDir, 'assets'), { recursive: true });
  }

  // Run esbuild
  await build({
    entryPoints: [resolve(srcDir, 'main.ts')],
    bundle: true,
    minify: true,
    // Source maps are opt-in for local debugging; they are never shipped (docs/baton D005).
    sourcemap: process.env.MAPX_UI_SOURCEMAP === '1',
    platform: 'browser',
    outfile: resolve(distDir, 'main.js'),
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  });

  console.error('Mapx Web Dashboard client build completed.');
}

main().catch(err => {
  console.error('UI Build failed:', err);
  process.exit(1);
});
