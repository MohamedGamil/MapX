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
 * The template is not read.
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

    for (const block of scriptBlocks(source)) {
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
