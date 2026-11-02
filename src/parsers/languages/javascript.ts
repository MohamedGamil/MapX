import { GenericWasmParser } from '../generic-wasm-parser.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import type { ExtractedSymbol, ParseResult } from '../../types.js';
import { annotateStoreRefs } from './vue-stores.js';
import { moduleNavigationReferences } from './vue-navigation.js';

/**
 * A member-assigned function's signature (M2-09): its target and its value up to the body,
 * `api.get = function (url)` or `svc.save = (x: number): number =>`. Null for any other node.
 */
export function memberAssignmentSignature(source: string, node: any): string | null {
  if (node?.type !== 'assignment_expression') return null;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  const body = right?.childForFieldName('body');
  if (!left || !right || !body) return null;
  return `${left.text} = ${source.slice(right.startIndex, body.startIndex)}`.replace(/\s+/g, ' ').trim();
}

/**
 * A member-assigned function is marked `assigned` (M2-09): name lookup ranks it below declared
 * functions and methods, and an `exports.f` one (scope `exports`) is reached only through its
 * module, never as a lexical `f`.
 */
export function memberAssignmentMetadata(node: any): Record<string, unknown> {
  return node?.type === 'assignment_expression' ? { assigned: true } : {};
}

/**
 * Drops a member-assigned symbol whose scope and name the file already has: a class method or
 * object-literal member of that name (`class Foo { bar() {} }` and `Foo.prototype.bar = …`), or an
 * earlier assignment of the same member (M2-09).
 */
export function dropRepeatedAssignments(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  const key = (s: ExtractedSymbol) => `${s.scope ?? ''}\0${s.name}`;
  const assigned = symbols.filter(s => s.metadata?.['assigned']);
  if (!assigned.length) return symbols;
  const taken = new Set(symbols.filter(s => !s.metadata?.['assigned']).map(key));
  const repeated = new Set<ExtractedSymbol>();
  for (const s of assigned.sort((a, b) => a.startLine - b.startLine)) {
    if (taken.has(key(s))) repeated.add(s);
    else taken.add(key(s));
  }
  return repeated.size ? symbols.filter(s => !repeated.has(s)) : symbols;
}

export class JavaScriptParser extends GenericWasmParser {
  constructor(langDef: LanguageDefinition) {
    super(langDef);
  }

  override async parse(filePath: string, source: string, options?: any): Promise<ParseResult> {
    const result = await super.parse(filePath, source, options);
    result.symbols = dropRepeatedAssignments(result.symbols);
    // Vuex / Pinia store references and store models (M3-05).
    await annotateStoreRefs(filePath, source, result, options?.absolutePath);
    // Vue Router navigation in stores, guards and composables (M3-11); SFCs have their own pass.
    if (!filePath.endsWith('.vue')) result.references.push(...moduleNavigationReferences(source, result.symbols));
    return result;
  }

  protected override symbolMetadata(node: any): Record<string, unknown> {
    return memberAssignmentMetadata(node);
  }

  protected override extractSignature(source: string, node: any, name: string, kind: string, startLine: number): string {
    const member = memberAssignmentSignature(source, node);
    if (member) return member;
    const lines = source.split('\n');
    const lineIdx = startLine - 1;
    if (lineIdx >= lines.length) return name;
    const line = lines[lineIdx].trim();

    if (kind === 'function') {
      const match = line.match(/(function\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)/);
      if (match) return match[0];
    }
    if (kind === 'method') {
      const match = line.match(/(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\([^)]*\)/);
      if (match) return match[0];
    }
    if (kind === 'class') {
      const match = line.match(/class\s+\w+(\s+extends\s+\w+)?(\s+implements\s+\w+)?/);
      if (match) return match[0];
    }
    return name;
  }
}
