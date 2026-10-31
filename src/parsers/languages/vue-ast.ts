import { Parser, type Node } from 'web-tree-sitter';
import { getBuiltinLanguages } from '../../languages/registry.js';

/** Tree-sitter helpers shared by the Vue Options API (M3-03) and store (M3-05) passes. */

export const COMPONENT_WRAPPERS = new Set(['defineComponent', 'defineNuxtComponent', 'Vue.extend']);
export const TRANSPARENT = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression']);
export const FUNCTION_VALUES = new Set(['function_expression', 'function', 'arrow_function', 'generator_function']);

let parserPromise: Promise<Parser> | null = null;
function scriptParser(): Promise<Parser> {
  // Loaded on first use: the scanner imports the Vue modules for their resolvers only.
  return (parserPromise ??= import('../wasm-parser.js')
    .then(({ loadLanguage }) => loadLanguage(getBuiltinLanguages().typescript))
    .then((language) => {
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    }));
}

/** Parses a script (TypeScript grammar, which also reads JavaScript) and runs `fn` on its root. */
export async function withScriptTree<T>(code: string, fn: (root: Node) => T): Promise<T | null> {
  const parser = await scriptParser();
  const tree = parser.parse(code);
  if (!tree) return null;
  try {
    return fn(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/** The object of `export default { … }`, `export default defineComponent({ … })` or `export default X`. */
export function optionsObject(root: Node): Node | null {
  for (const statement of root.namedChildren) {
    if (statement.type !== 'export_statement') continue;
    const value = statement.childForFieldName('value');
    if (value) return objectOf(value, root, COMPONENT_WRAPPERS);
  }
  return null;
}

/**
 * The object literal an expression stands for: the literal itself, through parentheses and type
 * assertions, the last argument of a `wrappers` call, or a top-level `const X = …` it names.
 */
export function objectOf(node: Node | null, root: Node, wrappers: Set<string> = new Set(), depth = 0): Node | null {
  if (!node || depth > 4) return null;
  if (node.type === 'object') return node;
  if (TRANSPARENT.has(node.type)) return objectOf(node.namedChild(0), root, wrappers, depth + 1);
  if (node.type === 'call_expression') {
    if (!wrappers.has(node.childForFieldName('function')?.text ?? '')) return null;
    const args = node.childForFieldName('arguments')?.namedChildren ?? [];
    return objectOf(args[args.length - 1] ?? null, root, wrappers, depth + 1);
  }
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier') {
    const declarator = topLevelDeclarator(root, node.text);
    return declarator ? objectOf(declarator.childForFieldName('value'), root, wrappers, depth + 1) : null;
  }
  return null;
}

/** `const name = …` (exported or not) at the top level of the script. */
export function topLevelDeclarator(root: Node, name: string): Node | null {
  for (const top of root.namedChildren) {
    const statement = top.type === 'export_statement' ? top.childForFieldName('declaration') : top;
    if (statement?.type !== 'lexical_declaration' && statement?.type !== 'variable_declaration') continue;
    for (const declarator of statement.namedChildren) {
      if (declarator.type === 'variable_declarator' && declarator.childForFieldName('name')?.text === name) return declarator;
    }
  }
  return null;
}

/** Local binding → module specifier, for the file's static imports. */
export function importSources(root: Node): Map<string, string> {
  const sources = new Map<string, string>();
  for (const statement of root.namedChildren) {
    if (statement.type !== 'import_statement') continue;
    const source = stringValue(statement.childForFieldName('source'));
    const clause = statement.namedChildren.find((c) => c.type === 'import_clause');
    if (source === null || !clause) continue;
    for (const part of clause.namedChildren) {
      if (part.type === 'identifier') sources.set(part.text, source);
      else if (part.type === 'namespace_import') {
        const local = part.namedChildren.find((c) => c.type === 'identifier');
        if (local) sources.set(local.text, source);
      } else if (part.type === 'named_imports') {
        for (const specifier of part.namedChildren) {
          const local = specifier.childForFieldName('alias') ?? specifier.childForFieldName('name');
          if (specifier.type === 'import_specifier' && local) sources.set(local.text, source);
        }
      }
    }
  }
  return sources;
}

/** The name of an object member: `a: …`, `'a': …`, `a() {}` or shorthand `a`. */
export function keyOf(prop: Node): string | null {
  if (prop.type === 'shorthand_property_identifier') return prop.text;
  const key = prop.type === 'pair' ? prop.childForFieldName('key') : prop.type === 'method_definition' ? prop.childForFieldName('name') : null;
  if (!key) return null;
  if (key.type === 'property_identifier' || key.type === 'identifier') return key.text;
  return stringValue(key);
}

/** The value of an object member; a method or shorthand member is its own value. */
export function valueOf(prop: Node): Node | null {
  if (prop.type === 'pair') return prop.childForFieldName('value');
  if (prop.type === 'method_definition' || prop.type === 'shorthand_property_identifier') return prop;
  return null;
}

export function stringValue(node: Node | null | undefined): string | null {
  if (node?.type !== 'string') return null;
  return node.namedChildren.find((c) => c.type === 'string_fragment')?.text ?? '';
}

/** True for a method or a member whose value is a function. */
export function isFunctionMember(prop: Node): boolean {
  return prop.type === 'method_definition' || FUNCTION_VALUES.has(valueOf(prop)?.type ?? '');
}
