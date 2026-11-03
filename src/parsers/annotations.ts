// Decorators, attributes and annotations, and doc-block tags, of a declaration (M5-10; gap G4 in
// docs/research/deptrac/03-mapx-gap-and-integration.md). Read from the syntax tree for PHP, TS/JS,
// Python, Java, Kotlin, C# and (doc tags only) Go, and stored in `symbols.metadata` as `decorators`
// and `docTags`, each only when non-empty. The architecture `decorator` and `docTag` selectors read
// them; the shape is specified in docs/baton/iterations/M5-10.md. Also a declaration's restricted
// native visibility, `visibility`, for Kotlin, C#, Java and Rust: the architecture's native internal
// markers read it (M5-11; AR-07).

import type { SymbolDecorator, SymbolDocTag } from '../types.js';

/** `@Get(':id')` → `{ name: 'Get', args: "':id'" }`; `args` is null without an argument list. */
export type Decorator = SymbolDecorator;
/** `@deprecated use V2` → `{ tag: '@deprecated', value: 'use V2' }`. */
export type DocTag = SymbolDocTag;
export interface SymbolAnnotations { decorators?: Decorator[]; docTags?: DocTag[]; visibility?: string }

/** Longest stored `args` or tag value, in characters; longer ones are cut and end in `…`. */
export const ANNOTATION_TEXT_LIMIT = 500;

const JS_LIKE = new Set(['typescript', 'tsx', 'javascript']);
export const ANNOTATED_LANGUAGES = new Set([...JS_LIKE, 'python', 'java', 'kotlin', 'c-sharp', 'php', 'go', 'rust']);

const cut = (s: string) => (s.length > ANNOTATION_TEXT_LIMIT ? `${s.slice(0, ANNOTATION_TEXT_LIMIT - 1)}…` : s);
const collapse = (s: string) => cut(s.replace(/\s+/g, ' ').trim());
const isComment = (n: any) => !!n && /comment/.test(n.type);
const isDecorator = (n: any) => n?.type === 'decorator';
/** C# attribute targets that name the declaration itself; others (`return:`, `param:`, `field:` …) do not. */
const CSHARP_OWN_TARGETS = new Set(['type', 'method', 'property', 'event']);
const namedChildren = (n: any): any[] => (n ? n.namedChildren : []);

/** The text between an argument list's parentheses, trimmed; null without a list. */
function argsText(list: any): string | null {
  if (!list) return null;
  return cut(list.text.replace(/^\s*\(/, '').replace(/\)\s*$/, '').trim());
}

/**
 * A declaration's decorators and doc tags. `resolve` turns a written name into the stored one
 * (PHP: through the file's `use` imports and namespace). An empty object when there are none, or
 * for a language without a reader.
 */
export function symbolAnnotations(language: string, node: any, resolve?: (name: string) => string): SymbolAnnotations {
  if (!node || !ANNOTATED_LANGUAGES.has(language)) return {};
  let decorators: Decorator[] = [];
  let docTags: DocTag[] = [];
  if (JS_LIKE.has(language)) {
    const outer = jsOuter(node);
    decorators = jsDecorators(node, outer);
    // TS overload signatures are not symbols: their docs belong to the implementation (review of M5-10).
    for (const signature of overloadSignatures(node, outer)) docTags.push(...javadocTags(precedingDoc(signature, isDecorator)));
    docTags.push(...javadocTags(precedingDoc(outer, isDecorator)));
  } else if (language === 'python') {
    const outer = node.parent?.type === 'decorated_definition' ? node.parent : node;
    decorators = namedChildren(outer).filter((c) => c.type === 'decorator').map(pythonDecorator);
    docTags = pythonDocTags(node);
    // AR-04: a `@deprecated` decorator is a deprecation like the docstring directive; the selector
    // counts it (src/arch/selectors/doc-tag.ts), the stored tags stay what the docstring says.
  } else if (language === 'java') {
    decorators = namedChildren(namedChildren(node).find((c) => c.type === 'modifiers'))
      .filter((c) => c.type === 'marker_annotation' || c.type === 'annotation')
      .map((a) => ({ name: a.childForFieldName('name')?.text ?? a.text.slice(1), args: argsText(a.childForFieldName('arguments')) }));
    docTags = javadocTags(precedingDoc(node));
  } else if (language === 'kotlin') {
    decorators = namedChildren(namedChildren(node).find((c) => c.type === 'modifiers'))
      .filter((c) => c.type === 'annotation')
      .flatMap(kotlinAnnotations);
    docTags = javadocTags(precedingDoc(node));
  } else if (language === 'c-sharp') {
    for (const list of namedChildren(node).filter((c) => c.type === 'attribute_list')) {
      // `[return: X]`, `[param: X]`, `[field: X]` and the like apply to something else than the declaration.
      const target = namedChildren(list).find((c) => c.type === 'attribute_target_specifier')?.text.replace(/\s*:$/, '');
      if (target && !CSHARP_OWN_TARGETS.has(target)) continue;
      for (const a of namedChildren(list).filter((c) => c.type === 'attribute')) {
        const name = a.childForFieldName('name')?.text ?? namedChildren(a)[0]?.text;
        if (name) decorators.push({ name: name.replace(/<[\s\S]*$/, ''), args: argsText(namedChildren(a).find((c) => c.type === 'attribute_argument_list')) });
      }
    }
    docTags = xmlDocTags(node);
  } else if (language === 'php') {
    for (const list of namedChildren(node).filter((c) => c.type === 'attribute_list')) {
      for (const group of namedChildren(list).filter((c) => c.type === 'attribute_group')) {
        for (const a of namedChildren(group).filter((c) => c.type === 'attribute')) {
          const written = namedChildren(a).find((c) => c.type === 'name' || c.type === 'qualified_name')?.text;
          if (!written) continue;
          const name = (resolve ? resolve(written) : written).replace(/^\\/, '');
          // The name as written too, when resolution changed it (`ORM\Entity`, an alias `Baz`).
          const asWritten = written.replace(/^\\/, '');
          decorators.push({ name, args: argsText(a.childForFieldName('parameters')), ...(asWritten !== name ? { written: asWritten } : {}) });
        }
      }
    }
    docTags = javadocTags(precedingDoc(node));
  } else if (language === 'go') {
    docTags = goDocTags(goDeclaration(node));
  }
  const out: SymbolAnnotations = {};
  if (decorators.length) out.decorators = decorators;
  if (docTags.length) out.docTags = docTags;
  const visibility = nativeVisibility(language, node);
  if (visibility) out.visibility = visibility;
  return out;
}

// ─── Native visibility (M5-11) ───────────────────────────────────────────────────────────────

/** C# declarations that are types: at file or namespace level, without an access modifier, they are `internal`. */
const CSHARP_TYPES = new Set(['class_declaration', 'struct_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'delegate_declaration']);
/** Java declarations that take an access modifier; members of an interface or annotation type are implicitly public. */
const JAVA_ACCESSIBLE = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration', 'method_declaration', 'constructor_declaration', 'field_declaration']);

/**
 * A declaration's visibility when the language restricts it to a module, package or crate, else
 * null (public, or private to its type or file, which another file cannot reach anyway):
 * - Kotlin `internal`;
 * - C# `internal` (not `protected internal`, which derived types anywhere reach), `private
 *   protected`, and a type declared at file or namespace level without an access modifier;
 * - Java package-private (`package`): no access modifier, outside interface and annotation bodies;
 * - Rust `pub(crate)`, `pub(super)`, `pub(self)`, `pub(in path)`. A bare item is not marked: trait
 *   impl methods have no `pub` and are as public as the trait.
 */
export function nativeVisibility(language: string, node: any): string | null {
  if (language === 'kotlin') {
    const v = namedChildren(namedChildren(node).find((c) => c.type === 'modifiers')).find((c) => c.type === 'visibility_modifier');
    return v?.text === 'internal' ? 'internal' : null;
  }
  if (language === 'c-sharp') {
    const mods = namedChildren(node).filter((c) => c.type === 'modifier').map((c) => c.text);
    if (mods.includes('internal')) return mods.includes('protected') ? null : 'internal';
    if (mods.includes('private') && mods.includes('protected')) return 'internal';
    if (mods.some((m) => m === 'public' || m === 'private' || m === 'protected') || !CSHARP_TYPES.has(node.type)) return null;
    // A type directly in the file or a namespace (block or file-scoped); a nested one is private.
    const parent = node.parent;
    const atTop = parent?.type === 'compilation_unit' || parent?.type === 'file_scoped_namespace_declaration'
      || (parent?.type === 'declaration_list' && parent.parent?.type === 'namespace_declaration');
    return atTop ? 'internal' : null;
  }
  if (language === 'java') {
    if (!JAVA_ACCESSIBLE.has(node.type)) return null;
    const body = node.parent?.type;
    if (body === 'interface_body' || body === 'annotation_type_body') return null;
    const mods = namedChildren(node).find((c) => c.type === 'modifiers');
    const access = (mods?.children ?? []).some((c: any) => c.type === 'public' || c.type === 'protected' || c.type === 'private');
    return access ? null : 'package';
  }
  if (language === 'rust') {
    const v = namedChildren(node).find((c) => c.type === 'visibility_modifier');
    const text = v?.text.replace(/\s+/g, ' ').replace(/\(\s+/, '(').replace(/\s+\)/, ')');
    return text && /^pub\(/.test(text) ? text : null;
  }
  return null;
}

// ─── Go doc comments (M5-11) ─────────────────────────────────────────────────────────────────

/**
 * The node a Go declaration's doc comment sits above: a type, const or var spec's declaration when
 * it holds that one spec, the spec itself inside a group (`type ( … )`), otherwise the node.
 */
function goDeclaration(node: any): any {
  if (!/^(type|const|var)_spec$/.test(node.type)) return node;
  const parent = node.parent;
  if (!parent || !/^(type|const|var)_declaration$/.test(parent.type)) return node;
  return namedChildren(parent).filter((c) => /_spec$/.test(c.type)).length === 1 ? parent : node;
}

/**
 * Tags of a Go doc comment: the comments directly above the declaration, each on its own line, with
 * no blank line between (a detached or trailing comment is not documentation). `@tag` lines, as in the other languages, and Go's
 * `Deprecated:` paragraph as `@deprecated`. A value runs to the next tag or the end of its
 * paragraph; indented lines are code blocks, never tags.
 */
function goDocTags(decl: any): DocTag[] {
  const comments: any[] = [];
  let next = decl;
  for (let p = decl.previousNamedSibling; isComment(p) && p.endPosition.row >= next.startPosition.row - 1 && startsOwnLine(p); p = p.previousNamedSibling) {
    comments.unshift(p);
    next = p;
  }
  const lines = comments.flatMap((c) => {
    const text: string = c.text;
    if (text.startsWith('//')) return [text.replace(/^\/\/ ?/, '')];
    return text.replace(/^\/\*/, '').replace(/\*\/$/, '').split('\n').map((l) => l.replace(/^ ?/, ''));
  });
  const tags: Array<{ tag: string; value: string[] }> = [];
  let current: (typeof tags)[number] | null = null;
  let paragraphStart = true;
  for (const line of lines) {
    if (!line.trim()) { current = null; paragraphStart = true; continue; }
    const code = /^\s/.test(line);
    const tag = code ? null : BLOCK_TAG.exec(line);
    const deprecated = code || !paragraphStart ? null : /^Deprecated:(.*)$/.exec(line);
    if (tag) tags.push(current = { tag: `@${tag[1]}`, value: [tag[2]!] });
    else if (deprecated) tags.push(current = { tag: '@deprecated', value: [deprecated[1]!] });
    else current?.value.push(line);
    paragraphStart = false;
  }
  return tags.map((t) => ({ tag: t.tag, value: collapse(t.value.join(' ')) }));
}

// ─── Declarations and their comments ─────────────────────────────────────────────────────────

/**
 * The statement a JS/TS declaration's doc comment and outer decorators belong to: the
 * `const f = …` declaration of a declarator, the statement of a member assignment, then the
 * `export` statement around either.
 */
function jsOuter(node: any): any {
  let outer = node;
  if (outer.type === 'variable_declarator' && /^(lexical|variable)_declaration$/.test(outer.parent?.type ?? '')) outer = outer.parent;
  if (outer.type === 'assignment_expression' && outer.parent?.type === 'expression_statement') outer = outer.parent;
  if (outer.parent?.type === 'export_statement') outer = outer.parent;
  return outer;
}

/**
 * JS/TS decorators in source order: those before a class member (siblings in the class body,
 * comments between them passed over), those of the `export` statement (`@Dec() export class X`),
 * then the declaration's own (`export @Dec() class X`, `@Input() field`). Parameter decorators sit
 * deeper and are not read.
 */
function jsDecorators(node: any, outer: any): Decorator[] {
  const before: any[] = [];
  for (let p = outer.previousNamedSibling; p && (isDecorator(p) || isComment(p)); p = p.previousNamedSibling) if (isDecorator(p)) before.unshift(p);
  const own = (n: any) => namedChildren(n).filter(isDecorator);
  const nodes = [...before, ...(outer !== node ? own(outer) : []), ...own(node)];
  return nodes.map((d) => {
    const expr = namedChildren(d).find((c) => !isComment(c));
    if (expr?.type === 'call_expression') {
      return { name: expr.childForFieldName('function')?.text ?? expr.text, args: argsText(expr.childForFieldName('arguments')) };
    }
    return { name: (expr?.text ?? d.text.slice(1)).replace(/^\(|\)$/g, ''), args: null };
  });
}

/**
 * The overload signatures just before a TS function implementation (`function f(a: string): void;`
 * then `function f(a: any) {}`), each as its statement, in source order. They are not symbols, so
 * their doc tags are the implementation's.
 */
function overloadSignatures(node: any, outer: any): any[] {
  const name = node.type === 'function_declaration' ? node.childForFieldName('name')?.text : null;
  if (!name) return [];
  const out: any[] = [];
  for (let p = outer.previousNamedSibling; p; p = p.previousNamedSibling) {
    if (isComment(p)) continue;
    const declaration = p.type === 'export_statement' ? p.childForFieldName('declaration') : p;
    if (declaration?.type !== 'function_signature' || declaration.childForFieldName('name')?.text !== name) break;
    out.unshift(p);
  }
  return out;
}

function pythonDecorator(d: any): Decorator {
  const expr = namedChildren(d).find((c) => !isComment(c));
  if (expr?.type === 'call') return { name: expr.childForFieldName('function')?.text ?? expr.text, args: argsText(expr.childForFieldName('arguments')) };
  return { name: expr?.text ?? d.text.replace(/^@\s*/, ''), args: null };
}

/** `@Entity`, `@Table(name = "t")`, `@get:JvmName("x")`, `@kotlin.jvm.JvmStatic`, and each of `@[A B(1)]`. */
function kotlinAnnotations(a: any): Decorator[] {
  const typeName = (type: any) => type.text.replace(/<[\s\S]*$/, '').replace(/\s+/g, '');
  const out: Decorator[] = [];
  for (const c of namedChildren(a)) {
    if (c.type === 'user_type') out.push({ name: typeName(c), args: null });
    else if (c.type === 'constructor_invocation') {
      const type = namedChildren(c).find((t) => t.type === 'user_type');
      if (type) out.push({ name: typeName(type), args: argsText(namedChildren(c).find((t) => t.type === 'value_arguments')) });
    }
  }
  return out;
}

/**
 * Does a comment start its own line (nothing but whitespace before it)? A trailing comment
 * (`type A struct{} // @internal`, `f(); /** … *\/`) documents the code before it, never the next
 * declaration (review of M5-11).
 */
const startsOwnLine = (n: any) => {
  const prev = n.previousSibling;
  return !prev || prev.endPosition.row < n.startPosition.row;
};

/** A `/** … *\/` doc comment (not `/**\/`). */
const isBlockDoc = (n: any) => isComment(n) && n.text.startsWith('/**') && n.text !== '/**/';

/**
 * The doc comment just before `node`, passing over siblings `skip` accepts (JS decorators) and
 * other comments (`// eslint-disable-next-line` between a doc and its declaration), but no code.
 * When the previous sibling is code, its last descendant may still be the doc: Kotlin's
 * `package a` without a terminator keeps the next comment inside the package header.
 */
function precedingDoc(node: any, skip: (n: any) => boolean = () => false): any {
  let p = node.previousNamedSibling;
  for (;;) {
    while (p && (skip(p) || (isComment(p) && !isBlockDoc(p)))) p = p.previousNamedSibling;
    if (!p || isComment(p)) return p && startsOwnLine(p) ? p : null;
    const last = p.lastChild;
    if (!last?.isNamed) return null;
    p = last;
  }
}

// ─── Doc-block parsers ───────────────────────────────────────────────────────────────────────

const BLOCK_TAG = /^\s*@([A-Za-z_][\w\\.:-]*)(.*)$/;

/** How deep inside inline `{@code …}` / `{@literal …}` a line ends, given the depth it starts at. */
function inlineCodeDepth(line: string, depth: number): number {
  for (let i = 0; i < line.length; i++) {
    if (depth === 0) {
      if (line.startsWith('{@code', i) || line.startsWith('{@literal', i)) { depth = 1; i += 5; }
    } else if (line[i] === '{') depth++;
    else if (line[i] === '}') depth--;
  }
  return depth;
}

/**
 * Block tags of a `/** … *\/` comment (PHPDoc, JSDoc/TSDoc, Javadoc, KDoc). A tag starts a line;
 * its value runs to the next tag or the end, so `{@link X}` inside text is not a tag. Code is text,
 * never tags: lines in a ``` fence, a `<pre>…</pre>` block or a multi-line `{@code …}`, and
 * everything after `@example`, which is that tag's value to the end of the comment.
 */
export function javadocTags(comment: any): DocTag[] {
  const text: string | undefined = comment?.text;
  if (!text || !text.startsWith('/**') || text === '/**/') return [];
  const lines = text.slice(3, text.endsWith('*/') ? -2 : undefined).split('\n').map((l) => l.replace(/^\s*\*?/, ''));
  const tags: Array<{ tag: string; value: string[] }> = [];
  let fenced = false;
  let pre = false;
  let code = 0;
  let example = false;
  for (const line of lines) {
    const m: RegExpExecArray | null = fenced || pre || code > 0 || example ? null : BLOCK_TAG.exec(line);
    if (m) {
      tags.push({ tag: `@${m[1]}`, value: [m[2]!] });
      example = m[1]!.toLowerCase() === 'example';
    } else if (tags.length) tags[tags.length - 1]!.value.push(line);
    if (/^\s*```/.test(line)) fenced = !fenced;
    for (const t of line.matchAll(/<(\/?)pre\b[^>]*>/gi)) pre = !t[1];
    code = inlineCodeDepth(line, code);
  }
  return tags.map((t) => ({ tag: t.tag, value: collapse(t.value.join(' ')) }));
}

/**
 * C# XML doc: the `///` lines just before the declaration (other comments between are passed
 * over). Each top-level element is a tag `@<element>`, its `name` or `cref` attribute starting the
 * value; `<summary>` is the description and `<code>` a code sample, neither a tag.
 */
function xmlDocTags(node: any): DocTag[] {
  const lines: string[] = [];
  let p = node.previousNamedSibling;
  while (isComment(p) && !p.text.startsWith('///')) p = p.previousNamedSibling;
  for (; isComment(p) && p.text.startsWith('///') && startsOwnLine(p); p = p.previousNamedSibling) lines.unshift(p.text.slice(3));
  if (!lines.length) return [];
  const xml = lines.join('\n');
  const tags: DocTag[] = [];
  const open = /<([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const [, name, attrs, selfClosing] = m as unknown as [string, string, string, string];
    let inner = '';
    if (!selfClosing) {
      const close = xml.indexOf(`</${name}>`, open.lastIndex);
      if (close >= 0) {
        inner = xml.slice(open.lastIndex, close);
        open.lastIndex = close + name.length + 3;
      }
    }
    if (/^(summary|code)$/i.test(name)) continue;
    const ref = /\b(?:name|cref)\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    // Nested `<see cref="X"/>` reads as X; other markup is dropped.
    const text = inner.replace(/<[^>]*\b(?:cref|name|langword)\s*=\s*"([^"]*)"[^>]*\/>/g, '$1').replace(/<[^>]+>/g, ' ');
    tags.push({ tag: `@${name}`, value: collapse([ref, text].filter(Boolean).join(' ')) });
  }
  return tags;
}

/**
 * Tags in a Python docstring: reStructuredText directives (`.. deprecated:: 2.0`, value = argument
 * plus the indented body) and `@tag` lines (epydoc style). A value continues over the following
 * lines indented deeper than the tag, blank lines included. Code is never a tag: a literal block
 * (the lines indented under a paragraph ending in `::`) and doctest examples (from `>>>` to the
 * next blank line). Indentation is measured after `inspect.cleandoc`-style dedenting.
 */
function pythonDocTags(definition: any): DocTag[] {
  const first = namedChildren(definition.childForFieldName('body')).find((c) => !isComment(c));
  const string = first?.type === 'expression_statement' && first.namedChildCount === 1 ? first.namedChildren[0] : null;
  if (string?.type !== 'string') return [];
  const content = namedChildren(string).filter((c) => c.type === 'string_content').map((c) => c.text).join('');
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const raw = content.split('\n');
  const margin = Math.min(...raw.slice(1).filter((l) => l.trim()).map(indentOf));
  const lines = [raw[0]!.trimStart(), ...raw.slice(1).map((l) => (Number.isFinite(margin) ? l.slice(Math.min(margin, indentOf(l))) : l))];
  const tags: Array<{ tag: string; value: string[]; indent: number }> = [];
  let current: (typeof tags)[number] | null = null;
  let literal: number | null = null;
  let doctest = false;
  for (const line of lines) {
    const blank = !line.trim();
    const indent = indentOf(line);
    if (literal !== null && !blank && indent <= literal) literal = null;
    if (blank) doctest = false;
    else if (/^\s*>>>/.test(line)) doctest = true;
    if (current && (blank || indent > current.indent)) current.value.push(line);
    else {
      current = null;
      const m = literal === null && !doctest ? /^\s*(?:\.\.\s+([\w-]+)::|@([A-Za-z_][\w.-]*))(.*)$/.exec(line) : null;
      if (m) {
        current = { tag: `@${m[1] ?? m[2]}`, value: [m[3]!], indent };
        tags.push(current);
      }
    }
    if (!blank && literal === null && /::\s*$/.test(line) && !/^\s*\.\.\s/.test(line)) literal = indent;
  }
  return tags.map((t) => ({ tag: t.tag, value: collapse(t.value.join(' ')) }));
}
