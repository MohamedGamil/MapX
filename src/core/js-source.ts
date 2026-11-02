import { createHash } from 'node:crypto';

/**
 * JS/TS source as the import resolution reads it (M2-08-R1): comments removed outside string,
 * template, regex and JSX text, so `'image/*'`, `/\/*$/` or `<p>don't</p>` cannot hide the code
 * after them, and the module's export surface, whose signature tells sync whether the importers
 * must be re-parsed (D032).
 */
export interface JsText {
  /** The text without comments; literals kept verbatim, JSX text blanked. */
  code: string;
  /** `code` with the contents of string, template and regex literals blanked; same length. */
  masked: string;
  /** Every `{` of the mask closes, and none closes early: the scan read the structure as written. */
  balanced: boolean;
}

/** Before these keywords a `/` starts a regex literal, and a `<` a JSX element. */
const EXPRESSION_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** After these characters an expression starts. */
const EXPRESSION_AFTER_CHAR = '(,=:[!&|?{};+-*%<>~^';

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/** `<T,>(x: T) => …` and `<T extends U>(…)` in a .tsx file: type parameters, not an element. */
const GENERIC_ARROW = /^<[\w$]+\s*(?:,|extends\b)/;

/** Files that may hold JSX: plain JS ones too (React projects); never .ts, where `<T>x` is a cast. */
const JSX_FILE = /\.(?:[cm]?jsx?|tsx)$/;

/**
 * A module file as the resolution reads it: a .vue or .svelte file's `<script>` blocks only (the
 * template's text is no code), JSX read in files that may hold it.
 */
export function scanModule(path: string, text: string): JsText {
  if (/\.(?:vue|svelte)$/.test(path)) {
    text = text.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)|[\s\S]/g, (m, open?: string, body?: string, close?: string) =>
      open !== undefined ? blank(open) + body + blank(close!) : blank(m));
  }
  return scanJs(text, { jsx: JSX_FILE.test(path) });
}

export function scanJs(text: string, options: { jsx?: boolean } = {}): JsText {
  const code: string[] = [];
  const masked: string[] = [];
  /** The last significant characters of the mask, whitespace runs as one space. */
  let tail = '';
  const emit = (s: string, m: string = s) => {
    code.push(s);
    masked.push(m);
    if (/\S/.test(m)) tail = (tail + m.slice(-64).replace(/\s+/g, ' ')).slice(-64);
    else if (m && !tail.endsWith(' ')) tail += ' ';
  };
  /** An expression may start here: a `/` is a regex literal, a `<` a JSX element. */
  const expressionStarts = (): boolean => {
    const t = tail.trimEnd();
    if (!t) return true;
    const char = t[t.length - 1]!;
    const word = /[A-Za-z_$][\w$]*$/.exec(t)?.[0];
    if (word) return EXPRESSION_AFTER_WORD.has(word);
    return EXPRESSION_AFTER_CHAR.includes(char);
  };

  /** Scans code from `i`; nested (a template's `${…}`, a JSX `{…}`), it stops after the closing brace. */
  const scan = (start: number, nested: boolean): number => {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const c = text[i]!;
      const next = text[i + 1];
      if (c === '/' && next === '/') {
        const end = text.indexOf('\n', i);
        i = end < 0 ? text.length : end;
        emit(' ');
      } else if (c === '/' && next === '*' && text.indexOf('*/', i + 2) >= 0) {
        // An unterminated `/*` is no comment (it would be a syntax error): text, kept.
        const stop = text.indexOf('*/', i + 2) + 2;
        emit(' ' + text.slice(i, stop).replace(/[^\n]/g, ''));
        i = stop;
      } else if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        const end = Math.min(j + 1, text.length);
        const literal = text.slice(i, end);
        emit(literal, c + blank(literal.slice(1, -1)) + (literal.length > 1 ? literal[literal.length - 1] : ''));
        i = end;
      } else if (c === '`') {
        emit('`');
        i = template(i + 1);
      } else if (c === '/' && expressionStarts()) {
        const end = regexEnd(i);
        if (end < 0) {
          emit('/');
          i++;
        } else {
          const literal = text.slice(i, end);
          const close = literal.lastIndexOf('/');
          emit(literal, '/' + blank(literal.slice(1, close)) + literal.slice(close));
          i = end;
        }
      } else if (options.jsx && c === '<' && /[A-Za-z_$>]/.test(next ?? '') && expressionStarts() && !GENERIC_ARROW.test(text.slice(i, i + 128))) {
        i = jsxElement(i);
      } else if (nested && c === '}' && depth === 0) {
        emit('}');
        return i + 1;
      } else {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        emit(c);
        i++;
      }
    }
    return i;
  };

  /**
   * The end of a regex literal starting at `i` (after its flags), or -1 when the line has none within
   * 4096 characters: the bound keeps a long line of unclosed `/[` from costing quadratic time.
   */
  const regexEnd = (i: number): number => {
    let inClass = false;
    for (let j = i + 1; j < text.length && j - i < 4096; j++) {
      const c = text[j]!;
      if (c === '\n') return -1;
      if (c === '\\') j++;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        let k = j + 1;
        while (k < text.length && /[a-z]/i.test(text[k]!)) k++;
        return k;
      }
    }
    return -1;
  };

  /** Scans a template literal's body from after its opening backtick; returns after the closing one. */
  const template = (start: number): number => {
    let i = start;
    let chunk = '';
    const flush = () => {
      if (chunk) emit(chunk, blank(chunk));
      chunk = '';
    };
    while (i < text.length) {
      const c = text[i]!;
      if (c === '\\') {
        chunk += text.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        flush();
        emit('`');
        return i + 1;
      } else if (c === '$' && text[i + 1] === '{') {
        flush();
        emit('${');
        i = scan(i + 2, true);
      } else {
        chunk += c;
        i++;
      }
    }
    flush();
    return i;
  };

  /**
   * A JSX element from its `<`: attribute strings are literals, `{…}` is code, and the text between
   * tags is blanked, so its quotes, `//` and `/*` mean nothing. Returns after the element.
   */
  const jsxElement = (start: number): number => {
    emit('<');
    let i = start + 1;
    const name = /^[\w$.:-]*/.exec(text.slice(i, i + 256))![0];
    if (name) emit(name);
    i += name.length;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '/' && text[i + 1] === '>') {
        emit('/>');
        return i + 2;
      }
      if (c === '>') {
        emit('>');
        i++;
        break;
      }
      if (c === '{') {
        emit('{');
        i = scan(i + 1, true);
      } else if (c === '"' || c === "'") {
        const end = text.indexOf(c, i + 1);
        const stop = end < 0 ? text.length : end + 1;
        const literal = text.slice(i, stop);
        emit(literal, c + blank(literal.slice(1, -1)) + (literal.length > 1 ? c : ''));
        i = stop;
      } else {
        emit(c);
        i++;
      }
    }
    while (i < text.length) {
      const c = text[i]!;
      if (c === '<' && text[i + 1] === '/') {
        const end = text.indexOf('>', i);
        const stop = end < 0 ? text.length : end + 1;
        emit(text.slice(i, stop));
        return stop;
      }
      if (c === '<') {
        i = jsxElement(i);
      } else if (c === '{') {
        emit('{');
        i = scan(i + 1, true);
      } else {
        let j = i;
        while (j < text.length && text[j] !== '<' && text[j] !== '{') j++;
        const words = blank(text.slice(i, j));
        emit(words, words);
        i = j;
      }
    }
    return i;
  };

  scan(0, false);
  const m = masked.join('');
  let depth = 0;
  let balanced = true;
  for (let i = 0; i < m.length && balanced; i++) {
    if (m[i] === '{') depth++;
    else if (m[i] === '}' && --depth < 0) balanced = false;
  }
  return { code: code.join(''), masked: m, balanced: balanced && depth === 0 };
}

/**
 * The module's top level: function, method and arrow bodies (a `{` after `)`, `=>` or a return type
 * `): T`) emptied, and whitespace collapsed. Every ESM export, re-export and top-level declaration
 * stays; an edit inside a body leaves it unchanged. A scan that did not balance its braces keeps
 * everything, so any edit changes it.
 */
export function exportSkeleton(js: JsText): string {
  const { code, masked } = js;
  if (!js.balanced) return code.replace(/\s+/g, ' ').trim();
  let out = '';
  let depth = 0;
  let dropAt = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === '{') {
      depth++;
      if (!dropAt && opensBody(masked, i)) {
        dropAt = depth;
        out += '{';
        continue;
      }
    } else if (c === '}') {
      if (dropAt === depth) {
        dropAt = 0;
        depth--;
        out += '}';
        continue;
      }
      depth--;
    }
    if (!dropAt) out += code[i];
  }
  return out.replace(/\s+/g, ' ').trim();
}

function opensBody(masked: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(masked[j]!)) j--;
  if (masked[j] === ')' || (masked[j] === '>' && masked[j - 1] === '=')) return true;
  // `function f(): Promise<T> {`, `m(): void {`: a return type between the parameters and the body.
  return /\)\s*:\s*[^;{}()=\s][^;{}()=]*$/.test(masked.slice(Math.max(0, i - 256), i));
}

/** `a.b = function`, `a.b = async (…) =>`, `a.b = x =>`: a member assigned a function (M2-09). */
const MEMBER_FUNCTION = /(?<![\w$.])((?:[A-Za-z_$][\w$]*\s*\.\s*)+[A-Za-z_$][\w$]*)\s*=(?![=>])\s*(?:async\b\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g;

/** CommonJS or `export =` exports, compiled ones included (`__exportStar(require(…), exports)`). */
export function hasCommonJsExports(js: JsText): boolean {
  return /(?<![\w$])exports(?![\w$])|\bexport\s*=(?!=)/.test(js.masked);
}

/**
 * What a module's importers resolve through, as a hash: the export skeleton, every function, class,
 * interface, enum and type alias name it declares (nested ones are indexed too), every member it
 * assigns a function to at any depth (`Baz.prototype.quux = function`, inside an IIFE too: M2-09),
 * and whether it has CommonJS exports. Equal hashes mean the importers' call edges cannot change (D032).
 */
export function jsExportSignature(js: JsText): string {
  const declared = [...js.masked.matchAll(/\b(?:function\s*\*?\s*|class\s+|interface\s+|enum\s+|type\s+(?=[A-Za-z_$][\w$]*\s*[=<]))([A-Za-z_$][\w$]*)/g)]
    .map(m => m[1]!);
  for (const m of js.masked.matchAll(MEMBER_FUNCTION)) declared.push(m[1]!.replace(/\s+/g, ''));
  const surface = JSON.stringify([exportSkeleton(js), [...new Set(declared)].sort(), hasCommonJsExports(js)]);
  return createHash('sha1').update(surface).digest('hex');
}
