import { build } from 'esbuild';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  if (process.env.MAPX_NO_UI === '1') {
    console.log('MAPX_NO_UI is set. Skipping UI client build.');
    return;
  }

  const srcDir = resolve('src/ui');
  const distDir = resolve('dist/ui');

  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  console.log('Bundling Mapx Web Dashboard client...');

  // Copy static HTML and CSS
  copyFileSync(resolve(srcDir, 'index.html'), resolve(distDir, 'index.html'));
  if (existsSync(resolve(srcDir, 'styles.css'))) {
    copyFileSync(resolve(srcDir, 'styles.css'), resolve(distDir, 'styles.css'));
  }

  // Run esbuild
  await build({
    entryPoints: [resolve(srcDir, 'main.ts')],
    bundle: true,
    minify: true,
    sourcemap: true,
    platform: 'browser',
    outfile: resolve(distDir, 'main.js'),
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  });

  console.log('Mapx Web Dashboard client build completed.');
}

main().catch(err => {
  console.error('UI Build failed:', err);
  process.exit(1);
});
