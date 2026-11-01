import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findUnescaped } from '../scripts/ui/check-escaping.js';

// M4-24: every interpolation in the dashboard's HTML templates is escaped, numeric or a helper
// that returns escaped HTML.
describe('dashboard HTML escaping (static check)', () => {
  it('finds no unescaped interpolation in src/ui/main.ts', () => {
    const found = findUnescaped(readFileSync(resolve(__dirname, '../src/ui/main.ts'), 'utf8'));
    expect(found.map((u) => `${u.line}: \${${u.expression}}`)).toEqual([]);
  });

  it('flags raw values, and accepts escaped, numeric and checked fragments', () => {
    const src = [
      'const a = `<td>${row.path}</td>`;',
      'const b = `<td>${escapeHtml(row.path)}</td>`;',
      'const c = `<td>${row.count.toFixed(2)} ${xs.length}</td>`;',
      'const d = `<ul>${xs.map((x) => `<li>${x.name}</li>`).join("")}</ul>`;',
      'let itemsHtml = `<b>${escapeHtml(n)}</b>`;',
      'const e = `<div>${itemsHtml}</div>`;',
      'let rawHtml = row.html;',
      'const f = `<div>${rawHtml}</div>`;',
      'const g = `<a title="${ok ? row.title : \'\'}">x</a>`;',
      'const h = `plain ${row.path} text`;',
    ].join('\n');
    const lines = findUnescaped(src).map((u) => u.expression);
    // The .map() is flagged because its callback's template is unsafe, and so is x.name inside it.
    expect(lines).toEqual(['row.path', 'xs.map((x) => `<li>${x.name}</li>`).join("")', 'x.name', 'rawHtml', "ok ? row.title : ''"]);
  });
});
