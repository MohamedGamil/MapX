// A small TOML reader for the Python manifests and lockfiles external-reference attribution reads
// (M5-22): pyproject.toml, uv.lock and poetry.lock. It reads TOML 1.0 documents into plain objects:
// tables, arrays of tables, dotted and quoted keys, basic and literal strings (multi-line too),
// arrays and inline tables. Numbers become numbers; dates and times stay text. It does not check
// everything the specification forbids (redefined tables, mixed array types): attribution only needs
// the keys and strings, and text it cannot read throws, which the callers treat as unreadable.

type Table = Record<string, unknown>;

const isTable = (v: unknown): v is Table => !!v && typeof v === 'object' && !Array.isArray(v);
/** A table without a prototype, so no key is inherited. */
const table = (): Table => Object.create(null) as Table;

const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' };

/** Parses TOML text; throws on text it cannot read. */
export function parseToml(text: string): Table {
  const s = text.replace(/^﻿/, '');
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`TOML: ${what} at line ${s.slice(0, i).split('\n').length}`);
  };
  const spaces = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
  const comment = () => { if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++; };
  /** Spaces, comments and line breaks (inside arrays and between statements). */
  const blank = () => {
    for (;;) {
      spaces();
      comment();
      if (s[i] === '\n' || s[i] === '\r') i++;
      else return;
    }
  };
  const endOfLine = () => {
    spaces();
    comment();
    if (s[i] === '\r') i++;
    if (i < s.length && s[i] !== '\n') fail('expected the end of the line');
  };

  const basic = (multi: boolean): string => {
    let out = '';
    if (multi && s[i] === '\r') i++;
    if (multi && s[i] === '\n') i++;
    for (;;) {
      if (i >= s.length) fail('unterminated string');
      if (!multi && s[i] === '"') { i++; return out; }
      if (multi && s.startsWith('"""', i)) {
        // Up to two quotes may end the content right before the closing delimiter (`"""x"""""`).
        let n = 3;
        while (s[i + n] === '"') n++;
        if (n > 5) fail('too many quotes');
        i += n;
        return out + '"'.repeat(n - 3);
      }
      const c = s[i++]!;
      if (!multi && c === '\n') fail('line break in a string');
      if (c !== '\\') { out += c; continue; }
      const e = s[i++]!;
      if (multi && /[ \t\r\n]/.test(e)) {
        // A line-ending backslash trims the whitespace and line breaks that follow.
        i--;
        while (/[ \t\r\n]/.test(s[i] ?? '')) i++;
        continue;
      }
      if (e === 'u' || e === 'U') {
        const n = e === 'u' ? 4 : 8;
        const hex = s.slice(i, i + n);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) fail('bad unicode escape');
        out += String.fromCodePoint(parseInt(hex, 16));
        i += n;
      } else if (e in ESCAPES) out += ESCAPES[e];
      else fail('bad escape');
    }
  };

  const literal = (multi: boolean): string => {
    if (multi && s[i] === '\r') i++;
    if (multi && s[i] === '\n') i++;
    const end = multi ? s.indexOf("'''", i) : s.indexOf("'", i);
    if (end < 0) fail('unterminated string');
    let close = end;
    if (multi) while (s[close + 3] === "'" && close - end < 2) close++;
    const out = s.slice(i, close);
    if (!multi && out.includes('\n')) fail('line break in a string');
    i = close + (multi ? 3 : 1);
    return out;
  };

  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      spaces();
      if (s[i] === '"') { i++; parts.push(basic(false)); }
      else if (s[i] === "'") { i++; parts.push(literal(false)); }
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i, i + 256));
        if (!m) fail('expected a key');
        parts.push(m![0]);
        i += m![0].length;
      }
      spaces();
      if (s[i] !== '.') return parts;
      i++;
    }
  };

  /** The table a dotted key names, created as needed; an array of tables gives its last table. */
  const descend = (from: Table, keys: string[]): Table => {
    let t = from;
    for (const k of keys) {
      // Own keys only, on tables without a prototype: `constructor` or `toString` is a key like any (review of M5-22).
      let next = Object.hasOwn(t, k) ? t[k] : undefined;
      if (next === undefined) t[k] = next = table();
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!isTable(next)) fail(`key ${k} is not a table`);
      t = next as Table;
    }
    return t;
  };

  const assign = (into: Table, keys: string[], value: unknown) => {
    const t = descend(into, keys.slice(0, -1));
    const last = keys[keys.length - 1]!;
    if (Object.hasOwn(t, last)) fail(`key ${last} defined twice`);
    t[last] = value;
  };

  const value = (): unknown => {
    spaces();
    if (s.startsWith('"""', i)) { i += 3; return basic(true); }
    if (s.startsWith("'''", i)) { i += 3; return literal(true); }
    if (s[i] === '"') { i++; return basic(false); }
    if (s[i] === "'") { i++; return literal(false); }
    if (s[i] === '[') {
      i++;
      const out: unknown[] = [];
      for (;;) {
        blank();
        if (s[i] === ']') { i++; return out; }
        out.push(value());
        blank();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return out; }
        fail('expected , or ] in an array');
      }
    }
    if (s[i] === '{') {
      i++;
      const out = table();
      blank();
      if (s[i] === '}') { i++; return out; }
      for (;;) {
        blank();
        const k = key();
        if (s[i] !== '=') fail('expected =');
        i++;
        assign(out, k, value());
        blank();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return out; }
        fail('expected , or } in an inline table');
      }
    }
    const m = /^[^,\]}#\r\n]+/.exec(s.slice(i, i + 256));
    if (!m) fail('expected a value');
    const raw = m![0].trimEnd();
    i += raw.length;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+)$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.includes('nan') ? NaN : raw.startsWith('-') ? -Infinity : Infinity;
    if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) return raw;
    return fail(`bad value ${raw}`);
  };

  const root = table();
  let current = root;
  for (;;) {
    blank();
    if (i >= s.length) return root;
    if (s[i] === '[') {
      const array = s[i + 1] === '[';
      i += array ? 2 : 1;
      const keys = key();
      if (!s.startsWith(array ? ']]' : ']', i)) fail('unterminated table header');
      i += array ? 2 : 1;
      if (array) {
        const parent = descend(root, keys.slice(0, -1));
        const last = keys[keys.length - 1]!;
        if (!Object.hasOwn(parent, last)) parent[last] = [];
        const list = parent[last];
        if (!Array.isArray(list)) fail(`key ${last} is not an array of tables`);
        const t = table();
        (list as unknown[]).push(t);
        current = t;
      } else {
        current = descend(root, keys);
      }
      endOfLine();
      continue;
    }
    const k = key();
    if (s[i] !== '=') fail('expected =');
    i++;
    assign(current, k, value());
    endOfLine();
  }
}
