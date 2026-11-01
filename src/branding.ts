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

/** Columns the art needs. */
export const LOGO_WIDTH = Math.max(...LOGO_ART.split('\n').map(l => [...l].length));

export interface BannerTerminal {
  isTTY: boolean;
  columns?: number;
  env: Record<string, string | undefined>;
}

/**
 * The init banner for this terminal, or null when none is shown: not a terminal (piped, CI),
 * MAPX_NO_BANNER set, or narrower than the art. In #ff02fe: 24-bit when the terminal reports it
 * (COLORTERM truecolor or 24bit), else the nearest 256-colour code (201, #ff00ff); plain under
 * NO_COLOR.
 */
export function renderBanner(term: BannerTerminal): string | null {
  if (!term.isTTY || term.env['MAPX_NO_BANNER']) return null;
  if (term.columns !== undefined && term.columns < LOGO_WIDTH) return null;
  if (term.env['NO_COLOR'] !== undefined && term.env['NO_COLOR'] !== '') return LOGO_ART + '\n';
  const truecolor = /^(truecolor|24bit)$/i.test(term.env['COLORTERM'] ?? '');
  const start = truecolor ? '\x1b[38;2;255;2;254m' : '\x1b[38;5;201m';
  return start + LOGO_ART + '\x1b[0m\n';
}

/** Prints the init banner to stdout when this terminal shows one. */
export function printBanner(stream: NodeJS.WriteStream = process.stdout): void {
  const banner = renderBanner({ isTTY: !!stream.isTTY, columns: stream.columns, env: process.env });
  if (banner) stream.write(banner + '\n');
}
