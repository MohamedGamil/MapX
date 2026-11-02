import type { LanguageParser } from '../parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference } from '../../types.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import { getBuiltinLanguages } from '../../languages/registry.js';
import { TypeScriptParser } from './typescript.js';
import { JavaScriptParser } from './javascript.js';

/**
 * Svelte components (M0-12-R8). Each `<script>` block (instance, `context="module"` or Svelte 5
 * `module`) is parsed by the TypeScript parser when `lang="ts"`, else by the JavaScript parser,
 * with the `.svelte` path, so its symbols and references are those of a `.ts` / `.js` module
 * (the scanner's import, alias and built-in globals rules apply). Lines are offset into the
 * `.svelte` file. The component is a class symbol named after the file and spanning it, so the
 * scanner gives it the references outside any narrower symbol. `export let` bindings are its
 * props (`metadata.prop`, and the component's `metadata.props`, as a .vue component lists them).
 * The template's calls, event handlers and component tags are references too, resolved as a .vue
 * template's (M0-12-R10, `svelteTemplateReferences`).
 */
export class SvelteParser implements LanguageParser {
  readonly languageName = 'svelte';
  readonly supportedExtensions = ['.svelte'];

  private tsParser: TypeScriptParser;
  private jsParser: JavaScriptParser;

  constructor(_langDef: LanguageDefinition) {
    const builtin = getBuiltinLanguages();
    this.tsParser = new TypeScriptParser(builtin.typescript);
    this.jsParser = new JavaScriptParser(builtin.javascript);
  }

  async parse(filePath: string, source: string, options?: any): Promise<ParseResult> {
    const symbols: ExtractedSymbol[] = [];
    const references: ExtractedReference[] = [];
    const errors: ParseResult['errors'] = [];
    const props: string[] = [];
    const name = filePath.split(/[\\/]/).pop()!.replace(/\.svelte$/, '');

    const blocks = scriptBlocks(source);
    for (const block of blocks) {
      const { attrs, code } = block;
      // Lines before the one holding the opening tag's `>`, where the block's line 1 starts.
      const lineOffset = source.slice(0, block.start).split('\n').length - 1;
      const parser = /\blang\s*=\s*["']?(?:ts|typescript)\b/i.test(attrs) ? this.tsParser : this.jsParser;
      // A module script's `export let` is a module export, not a prop (review 2026-11-01).
      const instance = !/\bcontext\s*=\s*["']?module\b|(?:^|\s)module(?:\s|=|$)/i.test(attrs);
      try {
        const res = await parser.parse(filePath, code, options);
        const exportLets = instance ? exportLetLines(code) : new Set<number>();
        const lines = code.split('\n');
        for (const sym of res.symbols) {
          // `export let x` is a prop of the component (Svelte 3/4). It keeps the kind a .ts binding
          // gets (`variable`, or `function` for `export let onPick = noop`) and is flagged `prop`.
          const prop = (sym.kind === 'variable' || sym.kind === 'function') && !sym.scope && exportLets.has(sym.startLine);
          if (prop) props.push(sym.name);
          // Svelte 5 runes make values: `let count = $state(0)` is no call target (as Vue refs).
          const rune = sym.kind === 'function' && !sym.scope
            && /=\s*\$(?:state|derived|props|bindable)\b/.test(lines[sym.startLine - 1] ?? '');
          symbols.push({
            ...sym,
            kind: rune ? 'variable' : sym.kind,
            startLine: sym.startLine + lineOffset,
            endLine: sym.endLine + lineOffset,
            metadata: prop ? { ...sym.metadata, prop: true } : sym.metadata,
          });
        }
        for (const ref of res.references) references.push({ ...ref, startLine: ref.startLine + lineOffset });
        for (const err of res.errors) errors.push({ ...err, line: err.line ? err.line + lineOffset : lineOffset + 1 });
      } catch (err: any) {
        errors.push({ message: `Failed to parse Svelte script block starting at line ${lineOffset + 1}: ${err.message}`, line: lineOffset + 1 });
      }
    }

    const component: ExtractedSymbol = {
      name, kind: 'class', scope: null, signature: `<${name}>`,
      startLine: 1, endLine: source.replace(/\r?\n$/, '').split('\n').length, metadata: props.length ? { props } : {},
    };
    symbols.unshift(component);
    // Scripts in <svelte:head> are the document's, not template expressions.
    const headScripts = [...source.matchAll(/<svelte:head[\s>][\s\S]*?<\/svelte:head\s*>/gi)].flatMap((h) =>
      [...h[0].matchAll(/<script[\s>][\s\S]*?<\/script\s*>/gi)].map((m) => ({ start: h.index! + m.index!, end: h.index! + m.index! + m[0].length })));
    references.push(...svelteTemplateReferences(source, name, blocks.map((b) => b.code),
      [...blocks.map((b) => ({ start: b.start, end: b.start + b.code.length })), ...headScripts]));
    return { symbols, references, errors };
  }
}

/**
 * The top-level `<script>` blocks of a component, skipping HTML comments and `{…}` template
 * expressions (a `<script>` inside `{@html "…"}` is text), with attributes read up to an unquoted
 * `>` (`generics="T extends Array<string>"`). `start` is the index of the block's first character.
 */
function scriptBlocks(source: string): Array<{ attrs: string; code: string; start: number }> {
  const blocks: Array<{ attrs: string; code: string; start: number }> = [];
  for (let i = 0; i < source.length; i++) {
    const skipTo = (closer: RegExp) => {
      const end = source.slice(i).search(closer);
      return end < 0 ? source.length : i + end;
    };
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0) break;
      i = end + 2;
    } else if (/^<(?:style|svelte:head)(?=[\s>])/i.test(source.slice(i, i + 14))) {
      // A stylesheet (`/* don't */`) and the document head's own scripts are not the component's.
      i = skipTo(source.startsWith('<style', i) || source.startsWith('<STYLE', i) ? /<\/style\s*>/i : /<\/svelte:head\s*>/i);
    } else if (source[i] === '{') {
      let depth = 0;
      for (; i < source.length; i++) {
        const c = source[i]!;
        if (c === '`') {
          const close = source.indexOf('`', i + 1);
          if (close >= 0) i = close;
        } else if (c === '"' || c === "'") {
          // A string ends on its own line; a lone quote (`/'/g`) is no string.
          const close = source.indexOf(c, i + 1);
          const eol = source.indexOf('\n', i + 1);
          if (close >= 0 && (eol < 0 || close < eol)) i = close;
        } else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
      }
    } else if (/^<script(?=[\s>])/i.test(source.slice(i, i + 8))) {
      let j = i + 7;
      for (let quote = ''; j < source.length; j++) {
        const c = source[j]!;
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      const close = source.slice(j).search(/<\/script\s*>/i);
      if (close < 0) break;
      blocks.push({ attrs: source.slice(i + 7, j), code: source.slice(j + 1, j + close), start: j + 1 });
      i = j + close;
    }
  }
  return blocks;
}

/** Lines (1-based, in `code`) of top-level `export let` / `export var` declarations. */
function exportLetLines(code: string): Set<number> {
  const lines = new Set<number>();
  code.split('\n').forEach((line, i) => {
    if (/^\s*export\s+(?:let|var)\s/.test(line)) lines.add(i + 1);
  });
  return lines;
}

/** JS keywords that look like calls in a template expression (block words are cut off before). */
const TEMPLATE_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'function', 'new', 'await', 'catch', 'else']);

/** DOM events: `onclick={save}` is a Svelte 5 handler; `online={isOnline}` is a prop (review 2026-11-01). */
const DOM_EVENTS = new Set(['click', 'dblclick', 'contextmenu', 'input', 'change', 'submit', 'reset', 'invalid', 'keydown', 'keyup', 'keypress',
  'focus', 'blur', 'focusin', 'focusout', 'mousedown', 'mouseup', 'mousemove', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'wheel',
  'pointerdown', 'pointerup', 'pointermove', 'pointerenter', 'pointerleave', 'pointercancel', 'touchstart', 'touchend', 'touchmove', 'touchcancel',
  'drag', 'dragstart', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop', 'scroll', 'resize', 'load', 'error', 'select', 'copy', 'cut',
  'paste', 'animationstart', 'animationend', 'transitionend', 'play', 'pause', 'ended', 'timeupdate', 'close', 'toggle', 'beforeinput']);

/** HTML elements with no closing tag, so no scope. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** The index of the quote closing the string opened at `i`, past escaped quotes (review 2026-11-01). */
function stringEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === text[i]) return j;
  }
  return -1;
}

/** Bare calls (`name(`, not `obj.name(`) in a template expression, with their offsets in `code`. */
function templateCalls(code: string): { name: string; index: number }[] {
  // Strings hold no calls: blank their content, keeping offsets.
  const masked = code.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
  const calls: { name: string; index: number }[] = [];
  for (const m of masked.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (m[2]!.startsWith('$') || TEMPLATE_KEYWORDS.has(m[2]!)) continue;
    calls.push({ name: m[2]!, index: m.index! + m[1]!.length });
  }
  return calls;
}

/**
 * The index of the first unmatched `)`, `]` or `}` from `i` (with `comma`, or of a `,` outside any
 * nesting), skipping strings and nested brackets; with `angles`, `<…>` nests too (a TS type).
 */
function scanTo(text: string, i: number, comma: boolean, angles = false): number {
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const k = stringEnd(text, i);
      if (k > 0) i = k;
    } else if (c === '(' || c === '[' || c === '{' || (angles && c === '<')) depth++;
    else if (c === ')' || c === ']' || c === '}' || (angles && c === '>' && text[i - 1] !== '=')) {
      if (depth-- === 0) return i;
    } else if (comma && c === ',' && depth === 0) return i;
  }
  return i;
}

/**
 * Identifiers a pattern binds (`item`, `{ id, name }`, `[a, b]`, `item, i`), leaving out object keys
 * (`{ children: kids }` binds `kids`), defaults and TS types (`item: Item` binds `item`).
 */
function patternNames(pattern: string): string[] {
  const names: string[] = [];
  const open: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '(' || c === '[' || c === '{') open.push(c);
    else if (c === ')' || c === ']' || c === '}') open.pop();
    else if (c === '=') i = scanTo(pattern, i + 1, true) - 1;
    else if (c === ':' && open.length === 0) i = scanTo(pattern, i + 1, true, true) - 1;
    else if (/[A-Za-z_$]/.test(c)) {
      const id = /^[A-Za-z_$][\w$]*/.exec(pattern.slice(i))![0];
      const key = open[open.length - 1] === '{' && /^\s*:/.test(pattern.slice(i + id.length));
      if (!key) names.push(id);
      i += id.length - 1;
    }
  }
  return names;
}

/** The names the component's scripts import: local name → module specifier and imported name. */
function scriptImports(scripts: string[]): Map<string, { specifier: string; name: string }> {
  const imports = new Map<string, { specifier: string; name: string }>();
  for (const code of scripts) {
    for (const m of code.matchAll(/\bimport\s+(?!type\s)([^'"`;]+?)\s+from\s*['"]([^'"]+)['"]/g)) {
      const clause = m[1]!;
      const specifier = m[2]!;
      for (const part of /\{([^}]*)\}/.exec(clause)?.[1]?.split(',') ?? []) {
        const [imported, local] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        if (imported && /^[\w$]+$/.test(imported)) imports.set((local ?? imported).trim(), { specifier, name: imported });
      }
      const rest = clause.replace(/\{[^}]*\}/, '');
      const star = /\*\s*as\s+([\w$]+)/.exec(rest);
      if (star) imports.set(star[1]!, { specifier, name: '*' });
      const def = /^\s*([\w$]+)/.exec(rest.replace(/\*\s*as\s+[\w$]+/, ''));
      if (def) imports.set(def[1]!, { specifier, name: 'default' });
    }
  }
  return imports;
}

/**
 * Template references of a Svelte component (M0-12-R10), with the Vue resolution hints: a call goes
 * to the component's own function, else to the module that imports it, never by name elsewhere; a
 * component tag renders the file its import resolves to. Calls come from `{expr}` blocks, block
 * headers (`{#if}`, `{#each}`, `{#await}`, `{#key}`, `{@const}`, `{@render}`), attribute values and
 * `use:` actions; an event handler named by itself (`on:click={save}`, `onclick={save}`, also in
 * quotes) is a call of it. Each-block items, `let:`, `{@const}`, `{:then}` / `{:catch}` values and
 * snippet names and parameters are template-local: never resolved inside their block, branch or
 * element (M0-12-R11). `{@html}`, comments, `<script>` and `<style>` hold none.
 */
export function svelteTemplateReferences(
  source: string, componentName: string, scripts: string[], blocks: Array<{ start: number; end: number }>,
): ExtractedReference[] {
  // Blank scripts, styles and comments, keeping offsets (so lines) intact.
  let text = source;
  const blank = (from: number, to: number) => { text = text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, ' ') + text.slice(to); };
  for (const b of blocks) blank(b.start, b.end);
  for (const m of [...text.matchAll(/<style[\s>][\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi)]) blank(m.index!, m.index! + m[0].length);

  const imports = scriptImports(scripts);
  // Template-local names hide a call only inside their scope, as in .vue templates (M0-12-R11). A
  // block, a branch (`{:else}`, `{:then}`, `{:catch}`) and an element are scopes; a name hides from
  // `from` to the end of the scope holding it. The ranges are applied once the walk is done.
  // `start` is where the scope's body starts: after a block's header or an element's opening tag.
  type Scope = { block: string | null; tag: string | null; start: number; names: Array<{ name: string; from: number }> };
  const scopes: Scope[] = [{ block: null, tag: null, start: 0, names: [] }];
  // Stack indices of the open block scopes, and of the open element scopes per tag name, so that
  // closing a block or a tag never walks the stack (review 2026-11-02: quadratic on large templates).
  const blockAt: number[] = [];
  const tagAt = new Map<string, number[]>();
  const hidden = new Map<string, Array<{ from: number; to: number }>>();
  const open = (block: string | null, tag: string | null, start: number) => {
    if (block) blockAt.push(scopes.length);
    if (tag) { const at = tagAt.get(tag); if (at) at.push(scopes.length); else tagAt.set(tag, [scopes.length]); }
    scopes.push({ block, tag, start, names: [] });
  };
  const bind = (names: string[], from: number, scope = scopes[scopes.length - 1]!) => { for (const name of names) scope.names.push({ name, from }); };
  const hide = (name: string, from: number, to: number) => {
    const ranges = hidden.get(name);
    if (ranges) ranges.push({ from, to });
    else hidden.set(name, [{ from, to }]);
  };
  /** Ends the scopes from index `k` up, at offset `at`. */
  const closeScopes = (k: number, at: number) => {
    while (scopes.length > k) {
      const scope = scopes.pop()!;
      if (scope.block) blockAt.pop();
      if (scope.tag) tagAt.get(scope.tag)!.pop();
      for (const n of scope.names) hide(n.name, n.from, at);
    }
  };
  /** The innermost block scope (of `word`, if given), past any elements left open inside it; -1 if none. */
  const innerBlock = (word?: string) => {
    for (let b = blockAt.length - 1; b >= 0; b--) if (!word || scopes[blockAt[b]!]!.block === word) return blockAt[b]!;
    return -1;
  };
  // Line starts once, then a binary search per reference: re-splitting per reference was quadratic.
  const lineStarts = [0];
  for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) lineStarts.push(k + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const pending: Array<{ name: string; at: number }> = [];
  const renders: Array<{ name: string; at: number }> = [];
  const expression = (code: string, at: number) => { for (const c of templateCalls(code)) pending.push({ name: c.name, at: at + c.index }); };
  /** The end of a `{…}` starting at `i` (the index of its `}`), skipping strings and nested braces. */
  const closeBrace = (i: number) => {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (c === '"' || c === "'" || c === '`') {
        const k = stringEnd(text, j);
        if (k > 0) j = k;
      } else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j;
    }
    return text.length;
  };
  /** A `{…}` whose content starts at `at` (its `{` is at `at - 1`). */
  const block = (content: string, at: number) => {
    const head = /^\s*([#:@/])(\w+)\s*([\s\S]*)$/.exec(content);
    if (!head) return expression(content, at);
    const [, sigil, word, rest] = head;
    const restAt = at + content.indexOf(rest!);
    if (sigil === '/') {
      const k = innerBlock(word);
      if (k > 0) closeScopes(k, at - 1);
      return;
    }
    // A block's or branch's body starts after its header: a {@const} there does not reach the header.
    const body = at + content.length + 1;
    if (sigil === '#') open(word!, null, body);
    else if (sigil === ':') {
      // A branch: the names of the one before end here.
      const k = innerBlock();
      if (k > 0) { const of = scopes[k]!.block; closeScopes(k, at - 1); open(of, null, body); }
    }
    if (word === 'html' || word === 'debug') return;
    if (word === 'each') {
      const m = /^([\s\S]*?)\s+as\s+([\s\S]*?)(?:\(([\s\S]*)\))?\s*$/.exec(rest!);
      if (!m) {
        // Svelte 5 `{#each { length: 8 }, rank}`: an index with no item.
        const index = /,\s*([A-Za-z_$][\w$]*)\s*$/.exec(rest!);
        if (index) bind([index[1]!], restAt + index.index!);
        return expression(index ? rest!.slice(0, index.index) : rest!, restAt);
      }
      // The aliases hide from the pattern on: the source expression is read outside them.
      bind(patternNames(m[2]!), restAt + m[0].indexOf(m[2]!, m[1]!.length));
      expression(m[1]!, restAt);
      if (m[3]) expression(m[3], restAt + rest!.indexOf(m[3]));
      return;
    }
    if (word === 'await' || word === 'then' || word === 'catch') {
      const m = /^([\s\S]*?)(?:\s*\b(then|catch)\b\s*([\s\S]*))?$/.exec(rest!);
      if (word !== 'await') return bind(patternNames(rest!), restAt);
      if (m?.[3]) bind(patternNames(m[3]), restAt + rest!.length - m[3].length);
      return expression(m?.[1] ?? rest!, restAt);
    }
    if (word === 'const') {
      // Svelte orders a block's {@const} declarations itself: the names hold in the whole block.
      const m = /^([\s\S]*?)=([\s\S]*)$/.exec(rest!);
      if (m) { const scope = scopes[scopes.length - 1]!; bind(patternNames(m[1]!), scope.start, scope); expression(m[2]!, restAt + m[1]!.length + 1); }
      return;
    }
    if (word === 'snippet') {
      // The parameters hold in the snippet; its name in the enclosing scope, before it too (hoisted).
      const name = /^[\w$]+/.exec(rest!)?.[0];
      const paren = rest!.indexOf('(');
      if (paren >= 0) bind(patternNames(rest!.slice(paren + 1, scanTo(rest!, paren + 1, false))), at - 1);
      const parent = scopes[scopes.length - 2];
      if (name && parent) bind([name], parent.start, parent);
      return;
    }
    // #if, :else if, #key, @render: an expression.
    return expression(rest!.replace(/^if\b/, ''), restAt);
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '{') {
      const end = closeBrace(i);
      block(text.slice(i + 1, end), i + 1);
      i = end;
    } else if (c === '<' && text[i + 1] === '/') {
      // A closing tag ends its element's scope and those left open inside it, never past a block.
      const name = /^[A-Za-z][\w.:-]*/.exec(text.slice(i + 2))?.[0];
      const same = name ? tagAt.get(name) : undefined;
      const k = same?.[same.length - 1];
      if (k !== undefined && k > (blockAt[blockAt.length - 1] ?? 0)) closeScopes(k, i);
    } else if (c === '<' && /[A-Za-z]/.test(text[i + 1] ?? '')) {
      const name = /^[A-Za-z][\w.:-]*/.exec(text.slice(i + 1))![0];
      if (/^[A-Z]/.test(name) || (name.includes('.') && !name.startsWith('svelte:'))) renders.push({ name, at: i });
      const dynamic = name === 'svelte:component';
      const letNames: string[] = [];
      let j = i + 1 + name.length;
      while (j < text.length && text[j] !== '>') {
        if (/\s/.test(text[j]!) || text[j] === '/') { j++; continue; }
        const attr = /^[^\s=>/{]+/.exec(text.slice(j))?.[0];
        if (!attr) {
          if (text[j] === '{') { const end = closeBrace(j); expression(text.slice(j + 1, end), j + 1); j = end + 1; continue; }
          j++;
          continue;
        }
        j += attr.length;
        let value: { code: string; at: number } | null = null;
        if (text[j] === '=') {
          j++;
          if (text[j] === '{') {
            const end = closeBrace(j);
            value = { code: text.slice(j + 1, end), at: j + 1 };
            j = end + 1;
          } else if (text[j] === '"' || text[j] === "'") {
            const end = text.indexOf(text[j]!, j + 1);
            if (text[j + 1] === '{' && end > 0 && closeBrace(j + 1) === end - 1) {
              // One expression in quotes (`on:click="{save}"`) reads as the unquoted one (M0-12-R11).
              value = { code: text.slice(j + 2, end - 1), at: j + 2 };
            } else {
              const inner = text.slice(j + 1, end < 0 ? text.length : end);
              for (const m of inner.matchAll(/\{([^}]*)\}/g)) expression(m[1]!, j + 1 + m.index! + 1);
            }
            j = end < 0 ? text.length : end + 1;
          } else {
            j += /^[^\s>]*/.exec(text.slice(j))![0].length;
          }
        }
        if (attr.startsWith('let:')) {
          letNames.push(...patternNames(value?.code ?? attr.slice(4)));
        } else if (dynamic && attr === 'this' && value && /^\s*[A-Za-z_$][\w$.]*\s*$/.test(value.code)) {
          // <svelte:component this={Card}>: a render of what Card names.
          renders.push({ name: value.code.trim(), at: i });
        } else if (/^(?:use|transition|in|out|animate):/.test(attr)) {
          // An action or transition directive calls its function.
          pending.push({ name: attr.slice(attr.indexOf(':') + 1).split('|')[0]!, at: j });
          if (value) expression(value.code, value.at);
        } else if (attr.startsWith('bind:')) {
          // A binding names a variable, not a call.
        } else if (value && (attr.startsWith('on:') || (attr.startsWith('on') && DOM_EVENTS.has(attr.slice(2)))) && /^\s*[A-Za-z_$][\w$]*\s*$/.test(value.code)) {
          pending.push({ name: value.code.trim(), at: value.at });
        } else if (value) {
          expression(value.code, value.at);
        }
      }
      // An element is a scope up to its closing tag. `let:` names hold in it: in a plain element's
      // attributes too, but not in a component's, which Svelte reads in the parent's scope.
      const component = /^[A-Z]/.test(name) || name.includes('.') || name === 'svelte:component' || name === 'svelte:self';
      let last = j - 1;
      while (last > i && /\s/.test(text[last]!)) last--;
      // Void elements are lowercase HTML tags: `<Input>` and `<Link>` are components (review 2026-11-02).
      if (text[last] === '/' || VOID_TAGS.has(name)) { if (!component) for (const n of letNames) hide(n, i, j); }
      else { open(null, name, j + 1); bind(letNames, component ? j + 1 : i); }
      i = j;
    }
  }
  closeScopes(0, text.length);
  // Per name, the ranges merged into sorted disjoint ones, so a lookup is a binary search.
  for (const [name, ranges] of hidden) {
    ranges.sort((a, b) => a.from - b.from);
    const merged: typeof ranges = [];
    for (const r of ranges) {
      const prev = merged[merged.length - 1];
      if (prev && r.from <= prev.to) prev.to = Math.max(prev.to, r.to);
      else merged.push({ ...r });
    }
    hidden.set(name, merged);
  }
  const isHidden = (name: string, at: number) => {
    const ranges = hidden.get(name);
    if (!ranges) return false;
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ranges[mid]!.from <= at) lo = mid;
      else hi = mid - 1;
    }
    return ranges[lo]!.from <= at && at < ranges[lo]!.to;
  };

  const refs: ExtractedReference[] = [];
  for (const { name, at } of pending) {
    if (isHidden(name, at)) continue;
    const imported = imports.get(name);
    const from = imported && imported.name !== '*' && imported.name !== 'default' ? [imported] : [];
    refs.push({
      sourceSymbol: componentName, targetName: name, referenceType: 'call', startLine: lineAt(at),
      metadata: { vue: { sameFile: true, from } },
    } as ExtractedReference);
  }
  for (const { name, at } of renders) {
    const [head, member] = name.split('.');
    const imported = imports.get(head!);
    if (!imported) continue;
    // `<Child>`: the module Child imports; `<ui.Button>`: Button of the module `* as ui` imports.
    const from = member ? (imported.name === '*' ? [{ specifier: imported.specifier, name: member }] : []) : [{ specifier: imported.specifier, name: imported.name }];
    if (!from.length) continue;
    refs.push({
      sourceSymbol: componentName, targetName: member ?? head!, referenceType: 'render', startLine: lineAt(at),
      metadata: { vue: { from } },
    } as ExtractedReference);
  }
  return refs;
}
