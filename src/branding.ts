/**
 * MapX branding (D028, M4-18). LOGO_ART is the owner's text-art logo, assets/brand/mapx-logo.txt,
 * without its blank lines, trailing spaces and common indent (tests/branding.test.ts keeps the two
 * in sync). It is embedded, so the npm package and the compiled binary need no file at run time.
 */
export const LOGO_ART = [
  "         ░░░░░░░                               ░░░░░░░░░",
  "    ░░▒▒▓▓▓▓▓▓▓▓▒▒░░░                     ░░░▒▒▓▓▓▓▓▓▓▓▓▓▒░░",
  "  ░░▒▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒░░               ░░▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░",
  "  ▒▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒░░         ░░▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒",
  "░▒▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░   ░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▓▓▓▒▒░░",
  "░▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▒▒▒▒░░░░",
  "░▓▓▓▒▒░░░░░▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░▒▒▒░░░░░░░░░░░▒▒▒▓▓▒▒▒▒▒▒░░░░░░",
  "░▓▒░░░░░░░░░░░░▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░▒▓▓▓▒▒▒▒▒▒▒░░░░░░░░",
  "░▓▒░░░░░░░░░░░░ ░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▓▓▓▒▒▒▒▒▒▒▒▒░░░░░░░",
  "░▒▒░░░░░░░░░░░░    ░░░░░░░░░░░░░░░░░░▒▒▓▓▓▓▒▒▒▒▒▒▒▒▒▒░░░░░░░░░",
  "░▒▒▒▒▒░░░░░░░░░       ░░░░░░░░░░░░▒▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒░░░░░░░░",
  "░▒▒▒▒▒▒▒░░░░░░░           ░░░░░▒▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░",
  "░▒▒▒▒▒▒▒▒░░░░░░          ░░░▒▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░",
  "░▒▒▒▒▒▒▒▒▒░░░░░       ░░▒▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░",
  "░▒▒▒▒▒▒▒▒▒░░░░░    ░░▒▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░",
  "░▒▒▒▒▒▒▒▒░░░░░░░░░▒▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░",
  "░▒▒▒▒▒░░░░░░░░▒▒▒▓▓▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░",
  "░▒▒▒░░░░░░░░▒▒▓▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░",
  "░░░▒░░░░░░░▒▒▒▒▒▒▒░░░░░░░░░░░░░      ░░░░░░░░░░░░░░░░░░░░░░░░░",
  " ░░░░░░░░░▒▒░░░░░░░░░░░░░░░░░          ░░░░░░░░░░░░░░░░░░░░░░░",
  "  ░░░░░░░░░░░░░░░░░░░░░░░                 ░░░░░░░░░░░░░░░░░░░░",
  "    ░░░░░░░░░░░░░░░░░                         ░░▒░░░░░░░░░▒▒░░",
  "       ░░░░░░░░░░░                               ░░░░▒░░░░░░░",
].join('\n');

/** The owner's colour for the text-art logo. */
export const LOGO_COLOR = '#ff02fe';

/** Columns the full art needs. */
export const LOGO_WIDTH = Math.max(...LOGO_ART.split('\n').map(l => [...l].length));

/** Shade level of each art character: space 0, ░ 1, ▒ 2, ▓ 3, █ 4. */
const LEVELS: Record<string, number> = { ' ': 0, '░': 1, '▒': 2, '▓': 3, '█': 4 };

/**
 * The compact mark (M4-25, D031): the art at half its width and height. Each cell covers two
 * columns and two rows of the art; its top and bottom halves (▀ ▄) hold the sum of the levels of
 * their two characters (0–8), so every row of the art survives and only column pairs are merged.
 */
export const MARK_WIDTH = Math.ceil(LOGO_WIDTH / 2);
export const MARK_HEIGHT = Math.ceil(LOGO_ART.split('\n').length / 2);

/** Half-cell sums of the compact mark: MARK_HEIGHT × 2 rows of MARK_WIDTH values in 0–8. */
export function markLevels(): number[][] {
  const rows = LOGO_ART.split('\n').map(l => [...l]);
  const at = (y: number, x: number) => LEVELS[rows[y]?.[x] ?? ' '] ?? 0;
  return Array.from({ length: MARK_HEIGHT * 2 }, (_, y) =>
    Array.from({ length: MARK_WIDTH }, (_, x) => at(y, 2 * x) + at(y, 2 * x + 1)));
}

const LOGO_RGB = [255, 2, 254] as const;

/** The highest half-cell sum in the art (the art has no █, so 6: two ▓). */
const MAX_SUM = Math.max(...markLevels().flat());

/**
 * The terminal background the shading fades toward. Unknown when nothing says (most terminals):
 * a mid grey then, so the faint glow stays faint on dark and light backgrounds alike.
 */
export type Background = 'dark' | 'light' | 'unknown';

/**
 * COLORFGBG ("fg;bg" or "fg;default;bg", set by rxvt, Konsole and others): its last field is the
 * background colour index; 7 and 15 (white) are light, other indexes dark, anything else unknown.
 */
export function backgroundOf(env: Record<string, string | undefined>): Background {
  const last = (env['COLORFGBG'] ?? '').trim().split(';').pop() ?? '';
  if (!/^\d+$/.test(last)) return 'unknown';
  return last === '7' || last === '15' ? 'light' : 'dark';
}

const FADE_TOWARD: Record<Background, number> = { dark: 0, light: 255, unknown: 128 };

/**
 * The colour of a half cell with level sum `sum` (1 to the art's highest): #ff02fe mixed toward
 * the background, from a fifth of the way at the faintest to the full colour at the art's
 * strongest shade, so every level differs.
 */
export function markColor(sum: number, background: Background): [number, number, number] {
  const t = 0.2 + 0.8 * Math.min(1, sum / MAX_SUM);
  const bg = FADE_TOWARD[background];
  return LOGO_RGB.map(c => Math.round(bg + (c - bg) * t)) as [number, number, number];
}

const XTERM_STEPS = [0, 95, 135, 175, 215, 255];

/** The xterm-256 colours (6×6×6 cube 16–231, grey ramp 232–255) and their RGB values. */
const XTERM_256: Array<[number, number[]]> = [
  ...Array.from({ length: 216 }, (_, i) => [16 + i, [XTERM_STEPS[Math.floor(i / 36)]!, XTERM_STEPS[Math.floor(i / 6) % 6]!, XTERM_STEPS[i % 6]!]] as [number, number[]]),
  ...Array.from({ length: 24 }, (_, i) => [232 + i, [8 + 10 * i, 8 + 10 * i, 8 + 10 * i]] as [number, number[]]),
];

const distance = (a: readonly number[], b: readonly number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;

/** The nearest xterm-256 colour to `rgb`, leaving out the codes in `taken`. */
export function nearest256(rgb: readonly number[], taken: ReadonlySet<number> = new Set()): number {
  let best = -1, bestD = Infinity;
  for (const [code, value] of XTERM_256) {
    if (taken.has(code)) continue;
    const d = distance(rgb, value);
    if (d < bestD) { best = code; bestD = d; }
  }
  return best;
}

/**
 * xterm-256 codes for each level sum, strongest first so the full colour keeps its exact code:
 * each level takes the nearest code no stronger level took, so no two shades merge.
 */
function codes256(background: Background): Map<number, number> {
  const codes = new Map<number, number>();
  const taken = new Set<number>();
  for (let sum = MAX_SUM; sum >= 1; sum--) {
    const code = nearest256(markColor(sum, background), taken);
    codes.set(sum, code);
    taken.add(code);
  }
  return codes;
}

export type MarkColors = 'truecolor' | '256' | 'plain';

/**
 * The compact mark as text, without a trailing newline. In colour, a cell with both halves set is
 * ▀ with the top as foreground and the bottom as background; a cell with one half set draws only
 * that half and leaves the terminal's background; an empty cell is a space. Plain text has no
 * halves, so each cell is the shade character of its four characters' mean level.
 */
export function compactMark(colors: MarkColors, background: Background = 'unknown'): string {
  const levels = markLevels();
  const codes = colors === '256' ? codes256(background) : null;
  const lines: string[] = [];
  for (let y = 0; y < MARK_HEIGHT; y++) {
    const top = levels[2 * y]!, bottom = levels[2 * y + 1]!;
    if (colors === 'plain') {
      lines.push(top.map((t, x) => ' ░▒▓█'[Math.round((t + bottom[x]!) / 4)]).join('').replace(/\s+$/, ''));
      continue;
    }
    const sgr = (sum: number, ground: 38 | 48) => {
      return codes ? `\x1b[${ground};5;${codes.get(sum)}m` : `\x1b[${ground};2;${markColor(sum, background).join(';')}m`;
    };
    let line = '';
    for (let x = 0; x < MARK_WIDTH; x++) {
      const t = top[x]!, b = bottom[x]!;
      if (!t && !b) line += ' ';
      else if (!b) line += `${sgr(t, 38)}▀\x1b[0m`;
      else if (!t) line += `${sgr(b, 38)}▄\x1b[0m`;
      else line += `${sgr(t, 38)}${sgr(b, 48)}▀\x1b[0m`;
    }
    lines.push(line.replace(/ +$/, ''));
  }
  return lines.join('\n');
}

export interface BannerTerminal {
  isTTY: boolean;
  columns?: number;
  env: Record<string, string | undefined>;
}

/** CI is set (to anything but "false" or "0"): CI runners may allocate a pseudo-terminal. */
const inCI = (env: BannerTerminal['env']) => !!env['CI'] && env['CI'] !== 'false' && env['CI'] !== '0';

/**
 * The banner of init, scan and sync for this terminal, or null when none is shown: not a terminal
 * (piped), CI, TERM=dumb, MAPX_NO_BANNER set, or narrower than the mark. 24-bit colour when the
 * terminal reports it (COLORTERM truecolor or 24bit), else xterm-256 colours; plain shade
 * characters under NO_COLOR (M4-18, M4-25).
 */
export function renderBanner(term: BannerTerminal): string | null {
  if (!term.isTTY || term.env['MAPX_NO_BANNER'] || inCI(term.env) || term.env['TERM'] === 'dumb') return null;
  if (term.columns !== undefined && term.columns < MARK_WIDTH) return null;
  if (term.env['NO_COLOR'] !== undefined && term.env['NO_COLOR'] !== '') return compactMark('plain') + '\n';
  const truecolor = /^(truecolor|24bit)$/i.test(term.env['COLORTERM'] ?? '');
  return compactMark(truecolor ? 'truecolor' : '256', backgroundOf(term.env)) + '\n';
}

/** Prints the banner to stdout when this terminal shows one (init, scan and sync; CLI only). */
export function printBanner(stream: NodeJS.WriteStream = process.stdout): void {
  const banner = renderBanner({ isTTY: !!stream.isTTY, columns: stream.columns, env: process.env });
  if (banner) stream.write(banner + '\n');
}
