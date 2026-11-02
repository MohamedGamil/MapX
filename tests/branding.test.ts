import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LOGO_ART, LOGO_COLOR, LOGO_WIDTH, MARK_HEIGHT, MARK_WIDTH, backgroundOf, compactMark, markColor, markLevels, nearest256, renderBanner, type Background } from '../src/branding.js';
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

});

// M4-25, D031: init, scan and sync open with the art at half its width and height.
describe('the compact mark', () => {
  const LEVEL: Record<string, number> = { ' ': 0, '░': 1, '▒': 2, '▓': 3, '█': 4 };
  const source = LOGO_ART.split('\n').map((l) => [...l].map((c) => LEVEL[c] ?? 0));
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  /** Reads a 24-bit mark back into half-cell level sums, through the colour of each sum. */
  const decode = (text: string, light: Background) => {
    const max = Math.max(...markLevels().flat());
    const sumOf = new Map<string, number>([...Array(max)].map((_, i) => [markColor(i + 1, light).join(';'), i + 1]));
    const rows: number[][] = [];
    for (const line of text.split('\n')) {
      const top: number[] = [], bottom: number[] = [];
      for (const cell of line.match(/(\x1b\[[0-9;]*m)*[^\x1b](\x1b\[0m)?/g) ?? []) {
        const fg = /\x1b\[38;2;([0-9;]+)m/.exec(cell)?.[1], bg = /\x1b\[48;2;([0-9;]+)m/.exec(cell)?.[1];
        const glyph = strip(cell);
        const f = fg ? sumOf.get(fg)! : 0, b = bg ? sumOf.get(bg)! : 0;
        if (glyph === ' ') { top.push(0); bottom.push(0); }
        else if (glyph === '▀') { top.push(f); bottom.push(b); }
        else if (glyph === '▄') { top.push(0); bottom.push(f); }
        else throw new Error(`unexpected cell ${JSON.stringify(cell)}`);
      }
      while (top.length < MARK_WIDTH) { top.push(0); bottom.push(0); }
      rows.push(top, bottom);
    }
    return rows;
  };

  it('is 32 columns by 12 rows: half the art each way', () => {
    expect([MARK_WIDTH, MARK_HEIGHT]).toEqual([32, 12]);
    for (const text of [compactMark('truecolor'), compactMark('256'), compactMark('plain')]) {
      const lines = strip(text).split('\n');
      expect(lines).toHaveLength(12);
      expect(Math.max(...lines.map((l) => [...l].length))).toBe(32);
    }
  });

  it.each(['dark', 'light', 'unknown'] as const)('keeps every row of the art, averaging only column pairs (%s background)', (light) => {
    const expected = Array.from({ length: 24 }, (_, y) =>
      Array.from({ length: 32 }, (_, x) => (source[y]?.[2 * x] ?? 0) + (source[y]?.[2 * x + 1] ?? 0)));
    expect(markLevels()).toEqual(expected);
    expect(decode(compactMark('truecolor', light), light)).toEqual(expected);
    // Detail survives: every pair sum of the art (0, 1, 2, 3, 4, 5, 6) keeps its own colour.
    expect([...new Set(expected.flat())].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('mixes #ff02fe toward the background: black, white, or a mid grey when the background is unknown', () => {
    // The art's strongest shade (two ▓, sum 6) is the full logo colour; the faintest a third of it.
    for (const bg of ['dark', 'light', 'unknown'] as const) expect(markColor(6, bg)).toEqual([255, 2, 254]);
    expect(markColor(1, 'dark')).toEqual([85, 1, 85]);
    expect(markColor(1, 'light')).toEqual([255, 171, 255]);
    expect(markColor(1, 'unknown')).toEqual([170, 86, 170]);
    const banner = (COLORFGBG?: string) => renderBanner({ isTTY: true, columns: 80, env: { COLORTERM: 'truecolor', COLORFGBG } })!;
    expect(banner()).toBe(compactMark('truecolor', 'unknown') + '\n');
    expect(banner('0;15')).toBe(compactMark('truecolor', 'light') + '\n');
    expect(banner('15;0')).toBe(compactMark('truecolor', 'dark') + '\n');
  });

  it.each([
    [undefined, 'unknown'], ['', 'unknown'], ['default;default', 'unknown'], ['15;0', 'dark'], ['0;8', 'dark'],
    ['0;15', 'light'], ['0;7', 'light'], ['0;default;15', 'light'], ['12;default;0', 'dark'], ['0;15 ', 'light'],
  ] as const)('reads COLORFGBG %j as a %s background', (value, expected) => {
    expect(backgroundOf({ COLORFGBG: value })).toBe(expected);
  });

  it('gives every shade level its own xterm-256 colour without 24-bit support', () => {
    expect(nearest256([255, 2, 254])).toBe(201);
    expect(nearest256([0, 0, 0])).toBe(16);
    expect(nearest256([128, 128, 128])).toBe(244);
    const levels = [...new Set(markLevels().flat())].filter(Boolean);
    for (const bg of ['dark', 'light', 'unknown'] as const) {
      const text = compactMark('256', bg);
      expect(text).not.toMatch(/\x1b\[[34]8;2;/);
      expect(text).toContain('\x1b[38;5;201m');
      const codes = new Set([...text.matchAll(/\x1b\[[34]8;5;(\d+)m/g)].map((m) => m[1]));
      expect(codes.size, bg).toBe(levels.length);
    }
    expect(renderBanner({ isTTY: true, columns: 80, env: {} })).toBe(compactMark('256', 'unknown') + '\n');
  });

  it('never lets a colour run past its cell or line', () => {
    for (const text of [compactMark('truecolor', 'dark'), compactMark('256', 'light')]) {
      for (const line of text.split('\n')) {
        // Each coloured glyph is closed by a reset before anything else follows.
        expect(line.replace(/(\x1b\[[34]8;[0-9;]+m)+[▀▄]\x1b\[0m/g, '')).toMatch(/^ *$/);
      }
    }
  });

  it('is plain shade characters, each the mean of four art characters, under NO_COLOR', () => {
    const text = renderBanner({ isTTY: true, columns: 80, env: { NO_COLOR: '1', COLORTERM: 'truecolor' } })!;
    expect(text).not.toContain('\x1b');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(12);
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 32; x++) {
        const sum = [0, 1].flatMap((dy) => [0, 1].map((dx) => source[2 * y + dy]?.[2 * x + dx] ?? 0)).reduce((a, b) => a + b);
        expect([...lines[y]!][x] ?? ' ', `${y},${x}`).toBe(' ░▒▓█'[Math.round(sum / 4)]);
      }
  });

  it('is coloured when NO_COLOR is set but empty', () => {
    expect(renderBanner({ isTTY: true, columns: 80, env: { NO_COLOR: '', COLORTERM: 'truecolor' } })).toBe(compactMark('truecolor', 'unknown') + '\n');
  });

  it.each([
    ['in a pipe', { isTTY: false, columns: 120, env: { COLORTERM: 'truecolor' } }],
    ['in CI, even on a pseudo-terminal', { isTTY: true, columns: 120, env: { CI: 'true' } }],
    ['on a dumb terminal', { isTTY: true, columns: 120, env: { TERM: 'dumb' } }],
    ['in a terminal narrower than the mark', { isTTY: true, columns: 31, env: {} }],
    ['with MAPX_NO_BANNER', { isTTY: true, columns: 120, env: { MAPX_NO_BANNER: '1' } }],
  ] as const)('is not shown %s', (_name, term) => {
    expect(renderBanner(term as any)).toBeNull();
  });

  it('is shown from 32 columns, and when CI is "false"', () => {
    expect(renderBanner({ isTTY: true, columns: 32, env: {} })).not.toBeNull();
    expect(renderBanner({ isTTY: true, columns: 80, env: { CI: 'false' } })).not.toBeNull();
  });

  const hasScript = spawnSync('script', ['--version']).status === 0;
  const tsx = join(ROOT, 'node_modules/tsx/dist/loader.mjs');
  const cli = (args: string) => `"${process.execPath}" --import "file://${tsx}" "${join(ROOT, 'src/main.ts')}" ${args}`;
  const env = { ...process.env, COLORTERM: 'truecolor', MAPX_NO_TELEMETRY: '1', NO_COLOR: '' } as NodeJS.ProcessEnv;
  delete env['NO_COLOR'];
  delete env['MAPX_NO_BANNER'];
  delete env['COLORFGBG'];
  delete env['CI'];
  delete env['TERM'];

  it.skipIf(!hasScript)('heads init, scan and sync in a terminal, before their other output (real CLI in a pseudo-terminal)', () => {
    const root = workspace({ 'a.ts': 'export const a = 1;\n' });
    try {
      const mark = compactMark('truecolor', 'unknown');
      const run = (args: string) => {
        const r = spawnSync('script', ['-qec', `stty cols 100; ${cli(args)}`, '/dev/null'], { cwd: root, encoding: 'utf8', env });
        expect(r.status, args).toBe(0);
        return r.stdout.replace(/\r/g, '');
      };
      const init = run(`init "${root}" --no-agents --no-suggestions --no-mcp-configs --no-discover`);
      expect(init.startsWith(mark)).toBe(true);
      expect(init.indexOf('Initialized mapx')).toBeGreaterThan(mark.length);
      for (const [cmd, after] of [['scan', 'Found'], ['sync', 'Updated']] as const) {
        const out = run(cmd);
        expect(out.startsWith(mark), cmd).toBe(true);
        expect(out.indexOf(after), cmd).toBeGreaterThan(mark.length);
      }
      // The full 64-column art is gone.
      expect(init).not.toContain(LOGO_ART.split('\n')[1]!);
    } finally {
      cleanup(root);
    }
  }, 180000);

  it('is not printed when scan and sync are piped', () => {
    const root = workspace({ 'a.ts': 'export const a = 1;\n' });
    try {
      const run = (...args: string[]) => {
        const r = spawnSync(process.execPath, ['--import', tsx, join(ROOT, 'src/main.ts'), ...args], { cwd: root, encoding: 'utf8', env });
        expect(r.status, args.join(' ')).toBe(0);
        return r.stdout;
      };
      run('init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
      for (const cmd of ['scan', 'sync']) {
        const out = run(cmd);
        expect(out, cmd).not.toMatch(/[▀▄░▒▓]/);
        expect(out, cmd).not.toContain('\x1b[38;2;');
      }
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
