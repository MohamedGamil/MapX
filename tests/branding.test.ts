import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LOGO_ART, LOGO_COLOR, LOGO_WIDTH, renderBanner } from '../src/branding.js';
import { cleanup, workspace } from './helpers/e2e.js';

// M4-18, D028: the owner's logo. The text art heads mapx init in #ff02fe; the symbol's sizes are
// generated from assets/brand/mapx-logo.png.
const ROOT = resolve(__dirname, '..');

/** The PNG's width and height, from its IHDR chunk. */
const pngSize = (path: string) => { const b = readFileSync(path); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

describe('the text-art logo', () => {
  it('is assets/brand/mapx-logo.txt without its blank lines, trailing spaces and common indent', () => {
    const lines = readFileSync(join(ROOT, 'assets/brand/mapx-logo.txt'), 'utf8').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    const indent = Math.min(...lines.filter(Boolean).map((l) => l.match(/^ */)![0].length));
    expect(LOGO_ART).toBe(lines.map((l) => l.slice(indent)).join('\n'));
    expect(LOGO_ART.split('\n')).toHaveLength(23);
    expect(LOGO_WIDTH).toBe(64);
    expect(LOGO_COLOR).toBe('#ff02fe');
  });

  it.each([
    ['24-bit colour when the terminal reports it', { isTTY: true, columns: 120, env: { COLORTERM: 'truecolor' } }, `\x1b[38;2;255;2;254m${LOGO_ART}\x1b[0m\n`],
    ['the nearest 256-colour code otherwise', { isTTY: true, columns: 120, env: {} }, `\x1b[38;5;201m${LOGO_ART}\x1b[0m\n`],
    ['plain under NO_COLOR', { isTTY: true, columns: 120, env: { NO_COLOR: '1', COLORTERM: 'truecolor' } }, `${LOGO_ART}\n`],
    ['none in a pipe or CI', { isTTY: false, columns: 120, env: { COLORTERM: 'truecolor' } }, null],
    ['none in a terminal narrower than the art', { isTTY: true, columns: 63, env: {} }, null],
    ['none with MAPX_NO_BANNER', { isTTY: true, columns: 120, env: { MAPX_NO_BANNER: '1' } }, null],
  ] as const)('renders %s', (_name, term, expected) => {
    expect(renderBanner(term as any)).toBe(expected);
  });

  it.skipIf(spawnSync('script', ['--version']).status !== 0)('heads mapx init in a terminal, before its other output (real CLI in a pseudo-terminal)', () => {
    const root = workspace({ 'a.ts': 'export const a = 1;\n' });
    try {
      const tsx = join(ROOT, 'node_modules/tsx/dist/loader.mjs');
      const cmd = `stty cols 100; "${process.execPath}" --import "file://${tsx}" "${join(ROOT, 'src/main.ts')}" init "${root}" --no-agents --no-suggestions --no-mcp-configs --no-discover`;
      const r = spawnSync('script', ['-qec', cmd, '/dev/null'], { cwd: root, encoding: 'utf8', env: { ...process.env, COLORTERM: 'truecolor', MAPX_NO_TELEMETRY: '1' } });
      expect(r.status).toBe(0);
      const out = r.stdout.replace(/\r/g, '');
      expect(out.startsWith(`\x1b[38;2;255;2;254m${LOGO_ART.split('\n')[0]}`)).toBe(true);
      expect(out.indexOf('Initialized mapx')).toBeGreaterThan(out.indexOf(LOGO_ART.split('\n').at(-1)!));
    } finally {
      cleanup(root);
    }
  }, 120000);
});

describe('the logo symbol', () => {
  it.each([
    ['src/ui/assets/mapx-logo-128.png', 128],
    ['src/ui/assets/favicon-32.png', 32],
    ['src/ui/assets/favicon-16.png', 16],
    ['src/ui/assets/apple-touch-icon.png', 180],
    ['docs/images/mapx-logo.png', 256],
  ] as const)('%s is a %i px square PNG', (path, size) => {
    expect(pngSize(join(ROOT, path))).toEqual([size, size]);
  });

  it('is in the dashboard header and favicons, and at the top of the README', () => {
    const html = readFileSync(join(ROOT, 'src/ui/index.html'), 'utf8');
    expect(html).toContain('<img class="logo-mark" src="assets/mapx-logo-128.png"');
    expect(html).toContain('href="assets/favicon-32.png"');
    expect(html).toContain('href="assets/favicon-16.png"');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="assets/apple-touch-icon.png"');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme.slice(0, 600)).toContain('docs/images/mapx-logo.png');
  });
});
