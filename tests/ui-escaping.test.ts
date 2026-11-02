import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findUnescaped } from '../scripts/ui/check-escaping.js';

/**
 * The module's escaper, appended after each synthetic source (a declaration is hoisted, and the
 * source's line numbers stay as written). The check trusts only this declaration (review P2-5).
 */
const ESCAPER = "\nfunction escapeHtml(v: unknown): string { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#039;'); }\n";
const check = (src: string) => findUnescaped(src + ESCAPER);
const flagged = (src: string) => check(src).map((u) => u.expression);

// M4-24: every value the dashboard writes into HTML is escaped, numeric or a constant. M4-24-R1:
// HTML built by concatenation is checked too, and a variable is judged by its values, not its name.
describe('dashboard HTML escaping (static check)', () => {
  it('finds no unescaped value in the dashboard sources (src/ui)', () => {
    const dir = resolve(__dirname, '../src/ui');
    const files = readdirSync(dir).filter((f) => /\.ts$/.test(f));
    expect(files).toContain('main.ts');
    const found = files.flatMap((f) => findUnescaped(readFileSync(join(dir, f), 'utf8'), join(dir, f)).map((u) => `${f}:${u.line}: ${u.expression}`));
    expect(found).toEqual([]);
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
    // x.name is reported inside the .map() callback's template, which is checked where it stands.
    expect(flagged(src)).toEqual(['row.path', 'x.name', 'rawHtml', "ok ? row.title : ''"]);
  });

  it('flags HTML built by concatenation, and any unsafe value written to an HTML sink', () => {
    const src = [
      'el.innerHTML = "<td>" + row.path + "</td>";', // the review's m2
      'el.insertAdjacentHTML("beforeend", "<li>" + item.name + "</li>");',
      'let html = "";',
      'for (const r of rows) html += "<tr><td>" + r.file + "</td></tr>";',
      'table.innerHTML = html;',
      'box.innerHTML = row.label;', // no tag in sight
      'box.outerHTML = `${row.label}`;',
      'list.insertAdjacentHTML("afterbegin", row.label);',
      'document.write(row.label);',
      'el.innerHTML = "<b>" + escapeHtml(row.path) + "</b>";',
      'el.innerHTML = "<i>" + row.count.toFixed(1) + "</i>";',
      'el.innerHTML = "Loading…";',
    ].join('\n');
    expect(flagged(src)).toEqual(['row.path', 'item.name', 'r.file', 'row.label', '`${row.label}`', 'row.label', 'row.label']);
  });

  it('judges a variable by its values, not its name', () => {
    // Names the M4-24 check trusted (the review's m3): durationStr, val, count, color, statusIcon.
    const src = [
      'const durationStr = data.durationMs != null ? ` <span>${data.durationMs}ms</span>` : "";',
      'const val = matrix[i][j] || 0;',
      'let count = 0;',
      'count = row.count;',
      'const color = row.color;',
      'let statusIcon = "ok";',
      'if (failed) statusIcon += row.error;',
      'out.innerHTML = `<td>${durationStr}</td><td data-val="${val}">${count}</td><td style="color:${color}">${statusIcon}</td>`;',
      // The same names with values the code chose are safe.
      'function safe(ms: number) {',
      '  const durationStr = ` ${Math.round(ms)}ms`;',
      '  const val = matrix.length * 2;',
      '  let count = 0;',
      '  count += 1;',
      '  return `<td>${durationStr}</td><td>${val}</td><td>${count}</td>`;',
      '}',
    ].join('\n');
    expect(flagged(src)).toEqual(['data.durationMs', 'val', 'count', 'color', 'statusIcon']);
  });

  it('resolves names by scope, so a shadowed variable is judged by its own values', () => {
    const src = [
      'const label = "fixed";',
      'function a(row: any) { const label = row.name; return `<b>${label}</b>`; }',
      'function b() { return `<b>${label}</b>`; }',
    ].join('\n');
    expect(check(src).map((u) => `${u.line}: ${u.expression}`)).toEqual(['2: label']);
  });

  it('judges a parameter by the arguments at every call, and a helper by what it returns', () => {
    const src = [
      'function cell(text: string) { return `<td>${text}</td>`; }',
      'cell("a"); cell(escapeHtml(row.name));',
      'function badge(kind: string) { return `<span>${kind}</span>`; }',
      'badge("x"); badge(row.kind);', // one unsafe call is enough
      'function passed(v: string) { return `<i>${v}</i>`; }',
      'items.forEach(passed);', // used as a value: its arguments are unknown
      'const wrap = (s: string) => s;',
      'const lit = () => "<hr>";',
      'el.innerHTML = `<p>${wrap(row.title)}</p><p>${lit()}</p><p>${wrap("ok")}</p>`;',
      'el.innerHTML = `<ol>${names.map((n, i) => `<li data-i="${i}">${n}</li>`).join("")}</ol>`;',
      'el.innerHTML = `<ol>${["a", "b"].map((n) => `<li>${n}</li>`).join("")}</ol>`;',
    ].join('\n');
    // A helper is judged over all its calls: wrap("ok") returns what wrap(row.title) does.
    expect(flagged(src)).toEqual(['kind', 'v', 'wrap(row.title)', 'wrap("ok")', 'n']);
  });

  it('follows elements pushed into an array that is joined into HTML', () => {
    const src = [
      'const parts: string[] = [];',
      'parts.push("<li>" + escapeHtml(a) + "</li>");',
      'parts.push(row.raw);',
      'el.innerHTML = parts.join("");',
      'const ok: string[] = ["<hr>"];',
      'ok.push(`<b>${escapeHtml(a)}</b>`);',
      'el.innerHTML = ok.join("");',
    ].join('\n');
    expect(flagged(src)).toEqual(['parts.join("")']);
  });

  it('accepts a property of a constant object, but not of one the code writes to', () => {
    const src = [
      'const COLORS = { get: "green", post: "blue" };',
      'const LABELS: Record<string, string> = { a: "A" };',
      'LABELS[row.key] = row.label;',
      'el.innerHTML = `<b style="color:${COLORS[row.method] ?? "grey"}">${COLORS.get}</b><i>${LABELS[row.k]}</i>`;',
    ].join('\n');
    expect(flagged(src)).toEqual(['LABELS[row.k]']);
  });

  // Review of M4-24-R1 (2026-11-02): each probe below was accepted by the first version of the check.
  it('does not keep a result that relied on a cycle still being judged (P2-1)', () => {
    const src = [
      "let a = '', b = '';",
      'a = b;',
      'a = data.name;',
      'b = a;',
      'el.innerHTML = `<i>${a}</i><b>${b}</b>`;',
      'el.innerHTML = `<i>${b}</i>`;',
    ].join('\n');
    expect(check(src).map((u) => `${u.line}: ${u.expression}`)).toEqual(['5: a', '5: b', '6: b']);
  });

  it('takes forEach\'s second argument as an index only on an array (P2-2)', () => {
    const src = [
      'new URLSearchParams(location.search).forEach((v, k) => { el.innerHTML += `<li>${k}</li>`; });',
      'const m = new Map<string, string>();',
      'm.forEach((v, k) => { el.innerHTML += `<li>${k}</li>`; });',
      "['a', 'b'].forEach((v, i) => { el.innerHTML += `<li>${i}</li>`; });",
      'const rows: string[] = [];',
      'rows.forEach((r, i) => { el.innerHTML += `<li>${i}</li>`; });',
    ].join('\n');
    expect(flagged(src)).toEqual(['k', 'k']);
  });

  it('does not follow an array once it is aliased or handed to a function (P2-3)', () => {
    const src = [
      'const parts: string[] = [];',
      'const alias = parts;',
      'alias.push(data.name);',
      'el.innerHTML = parts.join("");',
      'const items: string[] = [];',
      'collect(items, data);',
      'el.innerHTML = items.join("");',
      'const kept: string[] = ["<hr>"];',
      'for (const k of kept) console.log(k, kept.length, kept.includes(k));',
      'el.innerHTML = kept.join("");',
    ].join('\n');
    expect(flagged(src)).toEqual(['parts.join("")', 'items.join("")']);
  });

  it('judges a constant array with what is pushed into it (P2-4)', () => {
    const src = [
      "const L = ['ok'];",
      'L.push(data.name);',
      'el.innerHTML = `<b>${L[1]}</b>`;',
      "const K = ['ok', 'fine'];",
      'el.innerHTML = `<b>${K[1]}</b>`;',
    ].join('\n');
    expect(flagged(src)).toEqual(['L[1]']);
  });

  it('trusts only the module\'s own escapeHtml, not a local of the same name (P2-5)', () => {
    const src = [
      'function view(row: any) {',
      '  const escapeHtml = (s: string) => s;',
      '  return `<b>${escapeHtml(row.name)}</b>`;',
      '}',
      'el.innerHTML = `<i>${escapeHtml(row.name)}</i>`;',
    ].join('\n');
    expect(flagged(src)).toEqual(['escapeHtml(row.name)']);
    // Without the module's escaper (or with one that does not escape quotes) nothing is trusted.
    expect(findUnescaped('el.innerHTML = `<i>${escapeHtml(row.name)}</i>`;').map((u) => u.expression)).toEqual(['escapeHtml(row.name)']);
    const weak = "function escapeHtml(v: unknown) { return String(v).replace(/</g, '&lt;').replace(/>/g, '&gt;'); }\n";
    expect(findUnescaped(weak + 'el.innerHTML = `<a title="${escapeHtml(row.name)}">x</a>`;').map((u) => u.expression)).toEqual(['escapeHtml(row.name)']);
  });

  it('keeps a replace safe only with a literal replacement free of markup characters (P2-6)', () => {
    const src = [
      "el.innerHTML = `<b>${escapeHtml(row.name).replace(/x/g, '<img src=x onerror=alert(1)>')}</b>`;",
      "el.innerHTML = `<b>${escapeHtml(row.name).replace(/x/g, row.sub)}</b>`;",
      "el.innerHTML = `<b>${escapeHtml(row.name).replace(/x/g, (m) => m)}</b>`;",
      "el.innerHTML = `<b>${escapeHtml(row.name).replace(/\\n/g, ' ')}</b>`;",
    ].join('\n');
    expect(flagged(src)).toEqual([
      "escapeHtml(row.name).replace(/x/g, '<img src=x onerror=alert(1)>')",
      'escapeHtml(row.name).replace(/x/g, row.sub)',
      'escapeHtml(row.name).replace(/x/g, (m) => m)',
    ]);
  });

  it('judges a reassigned function by every function it is given (P2-7)', () => {
    const src = [
      "let fmt = (x: string) => 'safe';",
      'fmt = (x: string) => x;',
      'el.innerHTML = `<b>${fmt(row.name)}</b>`;',
      "function label(x: string) { return 'fixed'; }",
      'el.innerHTML = `<b>${label(row.name)}</b>`;',
    ].join('\n');
    expect(flagged(src)).toEqual(['fmt(row.name)']);
  });

  it('checks element-access, Object.assign and srcdoc sinks (P2-8)', () => {
    const src = [
      "el['innerHTML'] = row.name;",
      'el["outerHTML"] = `${row.name}`;',
      'Object.assign(el, { innerHTML: row.name });',
      'const innerHTML = row.html;',
      'Object.assign(el, { innerHTML });',
      "frame.setAttribute('srcdoc', row.doc);",
      "el['innerHTML'] = escapeHtml(row.name);",
      "Object.assign(el, { textContent: row.name });",
    ].join('\n');
    expect(flagged(src)).toEqual(['row.name', '`${row.name}`', 'row.name', 'innerHTML', 'row.doc']);
  });
});
