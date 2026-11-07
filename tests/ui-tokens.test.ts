import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findColourLiterals } from '../scripts/ui/check-tokens.js';

// M4-17: the dashboard's colours are design tokens. Runs without a browser, in `npm run check`.
describe('dashboard colour tokens (static check)', () => {
  it('styles.css has no colour literal outside its token blocks', () => {
    const found = findColourLiterals(readFileSync(resolve(__dirname, '../src/ui/styles.css'), 'utf8'));
    expect(found.map((v) => `${v.line}: ${v.selector} { ${v.text} }`)).toEqual([]);
  });

  it('allows literals only in token custom properties', () => {
    const css = ':root { --a: #000; --b: white; }\n:root[data-theme="light"] { --a: #fff; }\n.x { color: var(--a); background: color-mix(in srgb, var(--a) 10%, transparent); white-space: nowrap; }\n';
    expect(findColourLiterals(css)).toEqual([]);
  });

  it('finds literals in rules, media blocks, a token block\'s plain properties, any case and every named colour', () => {
    const css = [
      '.a { color: #fff; }',
      '@media (max-width: 9px) { .b { background: rgba(0,0,0,.5); } }',
      ':root[data-theme="light"] { color: red; }',
      '.c { color: White; border-color: RGB(1, 2, 3); }',
      '.d { color: darkred; outline-color: lightgray; }',
      '.e { color: color(srgb 1 0 0); }',
    ].join('\n');
    expect(findColourLiterals(css).map((v) => v.selector)).toEqual(['.a', '.b', ':root[data-theme="light"]', '.c', '.c', '.d', '.d', '.e']);
  });

  it('is not thrown off by statement at-rules or braces and colour names inside strings', () => {
    const css = [
      '@charset "utf-8";',
      '@import url("theme.css");',
      '@layer base, components;',
      '.after-at-rules { color: #123456; }',
      '.quoted { content: "} red {"; }',
      '.next { background: blue; }',
    ].join('\n');
    expect(findColourLiterals(css).map((v) => `${v.line} ${v.selector}`)).toEqual(['4 .after-at-rules', '6 .next']);
  });
});
