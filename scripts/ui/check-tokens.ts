// The dashboard stylesheet defines its colours only as design tokens (M4-17, criterion 1): a colour
// literal (hex, rgb(), hsl(), or a named colour) may appear only in a custom-property declaration
// of a token block, i.e. a rule whose selector is :root or :root[data-theme=…]. Everything else
// must use var(--…) (color-mix() of tokens included).
//   npx tsx scripts/ui/check-tokens.ts [path/to/styles.css]    exit 1 and a list when it finds one
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const NAMED = ['white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'cyan', 'magenta', 'silver', 'navy', 'teal', 'maroon', 'olive', 'lime', 'aqua', 'fuchsia', 'brown', 'gold', 'indigo', 'violet', 'crimson', 'coral', 'salmon', 'tomato', 'khaki', 'beige', 'ivory', 'lavender', 'plum', 'orchid', 'tan', 'chocolate', 'turquoise'];
const LITERAL = new RegExp(String.raw`#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(?:${NAMED.join('|')})\b`, 'g');
const TOKEN_BLOCK = /^:root(\[data-theme="(light|dark)"\])?$/;

export interface TokenViolation { line: number; selector: string; text: string }

/** Colour literals outside the token blocks of `css`. */
export function findColourLiterals(css: string): TokenViolation[] {
  const violations: TokenViolation[] = [];
  // Blank comments out, keeping line numbers.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const lineAt = (i: number) => src.slice(0, i).split('\n').length;
  // Walk rules; at-rule blocks (@media, @supports) are entered, and their rules checked the same way.
  const stack: Array<{ selector: string; start: number }> = [];
  let segmentStart = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      stack.push({ selector: src.slice(segmentStart, i).trim(), start: i + 1 });
      segmentStart = i + 1;
    } else if (ch === '}') {
      const rule = stack.pop();
      if (rule && !rule.selector.startsWith('@')) checkBlock(rule.selector, src.slice(rule.start, i), rule.start);
      segmentStart = i + 1;
    } else if (ch === ';' && stack.length && stack[stack.length - 1]!.selector.startsWith('@')) {
      segmentStart = i + 1;
    }
  }
  function checkBlock(selector: string, body: string, offset: number) {
    // Nested rules (inside @media) were checked on their own; this body is declarations only.
    const isTokenBlock = selector.split(',').map((s) => s.trim()).every((s) => TOKEN_BLOCK.test(s));
    let declStart = 0;
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':');
      const property = colon >= 0 ? decl.slice(0, colon).trim() : '';
      const value = colon >= 0 ? decl.slice(colon + 1) : '';
      if (!(isTokenBlock && property.startsWith('--'))) {
        for (const m of value.matchAll(LITERAL)) {
          // `white-space`, `currentColor` and similar never reach here: only values are scanned, and
          // a named colour must stand alone (not inside a var() name or a longer identifier).
          const before = value[(m.index ?? 0) - 1] ?? ' ';
          if (/[\w-]/.test(before)) continue;
          violations.push({ line: lineAt(offset + declStart + colon + 1 + (m.index ?? 0)), selector, text: decl.trim() });
        }
      }
      declStart += decl.length + 1;
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = resolve(process.argv[2] ?? 'src/ui/styles.css');
  const found = findColourLiterals(readFileSync(path, 'utf8'));
  for (const v of found) console.log(`${path}:${v.line}  ${v.selector}  ${v.text}`);
  console.log(found.length ? `${found.length} colour literal(s) outside the token blocks.` : 'No colour literals outside the token blocks.');
  process.exitCode = found.length ? 1 : 0;
}
