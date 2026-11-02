import { describe, it, expect } from 'vitest';
import { exportSkeleton, hasCommonJsExports, jsExportSignature, scanJs, scanModule } from '../src/core/js-source.js';

// M2-08-R1: comments found outside literals, and the export signature sync compares (D032).
describe('scanJs', () => {
  it.each([
    ['a string', "const a = 'image/*';\nexport { run } from './impl';\n// */", "const a = 'image/*';\nexport { run } from './impl';\n "],
    ['a regex literal', "const re = /\\/*$/;\nexport { run } from './impl';", "const re = /\\/*$/;\nexport { run } from './impl';"],
    ['a regex after return', 'function f(s) { return /a\\/b[/]c/g.test(s); } // x', 'function f(s) { return /a\\/b[/]c/g.test(s); }  '],
    ['a template expression', 'const t = `a ${ {x: \'/*\'}.x } b // c`; /* gone */', 'const t = `a ${ {x: \'/*\'}.x } b // c`;  '],
  ])('keeps comment openers inside %s', (_name, text, code) => {
    expect(scanJs(text).code).toBe(code);
  });

  it.each([
    ['an apostrophe', "export function A() { return <p>You don't have items</p>; }\nexport const b = 1;"],
    ['a URL', 'export function A() { return <p>see https://example.com</p>; }\nexport const b = 1;'],
    ['closing tags after an expression', 'export function A() { return <div>{show && <pre data={data} />}</div>; }\nexport const b = 1;'],
    ['an unterminated /*', 'export function A() { return <p>src/*.ts</p>; }\nexport const b = 1;'],
  ])('reads JSX text with %s as no code', (_name, text) => {
    const js = scanModule('a.tsx', text);
    expect(js.balanced).toBe(true);
    expect(exportSkeleton(js)).toBe('export function A() {} export const b = 1;');
  });

  it('reads a .tsx generic arrow as type parameters, not an element', () => {
    const js = scanModule('a.tsx', 'export const id = <T,>(x: T) => { return x; };\nexport const b = 1;');
    expect(exportSkeleton(js)).toBe('export const id = <T,>(x: T) => {}; export const b = 1;');
  });

  it('reads only the script blocks of a .vue file', () => {
    const js = scanModule('A.vue', "<template><p>src/*.ts, don't</p></template>\n<script setup>\nimport { run } from './impl';\n/* c */\n</script>\n");
    expect(js.code).toContain("import { run } from './impl';");
    expect(js.code).not.toContain('template');
  });

  it('keeps an unterminated /* as text', () => {
    expect(scanJs('a = b /* never closed\nexport { run };').code).toContain('export { run };');
  });

  it('reads divisions as divisions', () => {
    expect(scanJs('x = a / b; y = c / d; // c').code).toBe('x = a / b; y = c / d;  ');
  });

  it('blanks literal contents in the mask, at the same length', () => {
    const js = scanJs("const s = 'exports'; const r = /exports/; const t = `exports ${x}`;");
    expect(js.masked).toHaveLength(js.code.length);
    expect(js.masked).not.toContain('exports');
    expect(js.masked).toContain('${x}');
  });
});

describe('export signature', () => {
  const sig = (text: string) => jsExportSignature(scanJs(text));

  it('empties function, method and arrow bodies in the skeleton', () => {
    expect(exportSkeleton(scanJs('export function f() { body(); } export const g = () => { more(); }; export class C { m() { x(); } }')))
      .toBe('export function f() {} export const g = () => {}; export class C { m() {} }');
  });

  it('empties a body after a return type', () => {
    expect(exportSkeleton(scanJs('export function f(): Promise<number> { return g(); }\nclass C { m(): void { x(); } }')))
      .toBe('export function f(): Promise<number> {} class C { m(): void {} }');
  });

  it('keeps an object literal after a ternary colon', () => {
    expect(exportSkeleton(scanJs('export const o = c ? f() : { run };'))).toBe('export const o = c ? f() : { run };');
  });

  it('keeps every body when the scan could not balance its braces, so any edit changes the signature', () => {
    const js = scanJs('export function f() { if (x) /[}]/.test(s); return 0; }');
    expect(js.balanced).toBe(false);
    expect(sig('export function f() { if (x) /[}]/.test(s); return 0; }')).not.toBe(sig('export function f() { if (x) /[}]/.test(s); return 1; }'));
  });

  it('is unchanged by an edit inside a body', () => {
    expect(sig('export function f() { return 0; }')).toBe(sig('export function f() {\n  const x = 1;\n  return x;\n}'));
  });

  it.each([
    ['a new export', 'export function f() { return 0; }\nexport function g() {}'],
    ['a renamed export', 'export function h() { return 0; }'],
    ['a nested function', 'export function f() { function run() {} return 0; }'],
    ['a re-export', "export function f() { return 0; }\nexport * from './x';"],
    ['CommonJS exports in a body', 'export function f() { exports.run = 1; return 0; }'],
  ])('changes with %s', (_name, text) => {
    expect(sig(text)).not.toBe(sig('export function f() { return 0; }'));
  });

  it('tells a value from a function', () => {
    expect(sig('export const run = () => 1;')).not.toBe(sig('export const run = 1;'));
  });

  it('finds CommonJS exports outside literals only', () => {
    expect(hasCommonJsExports(scanJs('__exportStar(require("./a"), exports);'))).toBe(true);
    expect(hasCommonJsExports(scanJs('module.exports = require("./x");'))).toBe(true);
    expect(hasCommonJsExports(scanJs("const s = 'exports';"))).toBe(false);
  });
});
