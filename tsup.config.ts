import { defineConfig } from 'tsup';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export default defineConfig({
  entry: ['src/**/*.ts', '!src/ui/**/*.ts'],
  format: ['esm'],
  outDir: 'dist',
  bundle: false,
  // Keep the dashboard bundle (scripts/build-ui.ts): `npm pack` builds it in prepack, before prepare runs tsup (M4-05).
  clean: ['!ui/**'],
  dts: true,
  onSuccess: async () => {
    const mainJsPath = join(process.cwd(), 'dist', 'main.js');
    try {
      const content = await fs.readFile(mainJsPath, 'utf-8');
      if (!content.startsWith('#!/usr/bin/env node')) {
        await fs.writeFile(mainJsPath, '#!/usr/bin/env node\n' + content, 'utf-8');
      }
    } catch (err) {
      console.error('Failed to add shebang to dist/main.js:', err);
    }
  }
});
