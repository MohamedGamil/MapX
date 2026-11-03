// Layer selectors (M5-03; docs/research/deptrac AR-04). Each is a pure function of an element and
// the element view, and says which part of the selector decided the match (the trace that
// `explain` shows). Symbol-level selectors (`name`, `kind`, `decorator`, `docTag`, and M5-09's
// `extends`, `implements`, `inherits`, `mixes`, `inheritanceDepth`, `member`) never match a file element; file-level
// ones (`path`, `repo`, `language`, `role`, `cluster`, `workspacePackage`, `framework`) judge a
// symbol by its file. Selectors that need data later tasks add never match here and are reported.
import type { Selector } from '../schema.js';
import type { Element, ElementView } from '../elements.js';
import { globOrRegex, nameOrGlob, regex } from './patterns.js';
import { hasDecorator } from './decorator.js';
import { hasDocTag } from './doc-tag.js';
import { hierarchyMatch, hierarchyOf, isType, type HierarchyKey } from './hierarchy.js';
import { matchingMember } from './member.js';

export { globOrRegex, regex } from './patterns.js';

/** Selector keys this version cannot evaluate yet, with the task that adds them. */
export const UNSUPPORTED_SELECTORS: Record<string, string> = {
  package: 'M5-24', builtin: 'M5-24', ambient: 'M5-24',
};

export interface SelectorContext {
  view: ElementView;
  /** Whether `element` is in layer `name` (for `layer` selectors; membership guards against cycles). */
  inLayer(element: Element, name: string): boolean;
}

export interface SelectorMatch {
  matched: boolean;
  /** Where in the selector the decision was made, e.g. `all[1].path`; set when matched. */
  path?: string;
  /**
   * The selector does not apply to this element (a symbol-level selector such as `name` on a
   * file). It is not a match, and `not` of it is not a match either: `{not: {name: …}}` never
   * puts a file in a layer (AR-01; review 2026-11-02). `all`, `any` and `not` follow three-valued
   * logic: `all` is inapplicable when no branch fails and one is inapplicable, `any` when no branch
   * matches and one is inapplicable.
   */
  inapplicable?: boolean;
  /**
   * For a hierarchy selector (M5-09): the inheritance path that decided the match, from the type to
   * the matched ancestor (`inheritanceDepth`: the longest chain; `member`: the type and the member).
   */
  chain?: string[];
}

const LANGUAGE_ALIASES: Record<string, string> = { ts: 'typescript', js: 'javascript', py: 'python', 'c#': 'c-sharp', csharp: 'c-sharp', 'c++': 'cpp', kt: 'kotlin', rb: 'ruby', rs: 'rust', golang: 'go' };
export const normaliseLanguage = (l: string) => LANGUAGE_ALIASES[l.toLowerCase()] ?? l.toLowerCase();

/** `typescript` (or `ts`) covers `.tsx` files, which MapX indexes as language `tsx`; `tsx` matches only them. */
function languageMatches(fileLanguage: string, wanted: string): boolean {
  const have = normaliseLanguage(fileLanguage);
  const want = normaliseLanguage(wanted);
  return have === want || (want === 'typescript' && have === 'tsx');
}

/** Does `selector` match `element`? */
export function matchSelector(selector: Selector, element: Element, ctx: SelectorContext): SelectorMatch {
  const file = element.file;
  const yes = (path: string): SelectorMatch => ({ matched: true, path });
  const no: SelectorMatch = { matched: false };
  const inapplicable: SelectorMatch = { matched: false, inapplicable: true };
  if (selector.all) {
    if (!selector.all.length) return no;
    let na = false;
    let chain: string[] | undefined;
    for (const s of selector.all) {
      const m = matchSelector(s, element, ctx);
      if (m.matched) { chain ??= m.chain; continue; }
      if (!m.inapplicable) return no;
      na = true;
    }
    return na ? inapplicable : { ...yes('all'), ...(chain ? { chain } : {}) };
  }
  // Three-valued (Kleene) logic: `any` matches when a branch matches; otherwise it is inapplicable
  // when any branch is, so `not` of it does not match either (review of M5-03-R1).
  if (selector.any) {
    let na = false;
    for (let i = 0; i < selector.any.length; i++) {
      const m = matchSelector(selector.any[i]!, element, ctx);
      if (m.matched) return { ...m, path: `any[${i}].${m.path}` };
      if (m.inapplicable) na = true;
    }
    return na ? inapplicable : no;
  }
  if (selector.not) {
    const m = matchSelector(selector.not, element, ctx);
    return m.inapplicable ? inapplicable : m.matched ? no : yes('not');
  }
  if (selector.path !== undefined) return globOrRegex(selector.path)(file.path) ? yes('path') : no;
  if (selector.name !== undefined) {
    if (element.kind !== 'symbol') return inapplicable;
    if (selector.kind && !selector.kind.includes(element.symbolKind as never)) return no;
    return regex(selector.name)(element.qualifiedName) ? yes('name') : no;
  }
  // Decorators, attributes and annotations, and doc tags, as the parsers store them (M5-10).
  if (selector.decorator !== undefined) {
    if (element.kind !== 'symbol') return inapplicable;
    return hasDecorator(element, selector.decorator) ? yes('decorator') : no;
  }
  if (selector.docTag !== undefined) {
    if (element.kind !== 'symbol') return inapplicable;
    return hasDocTag(element, selector.docTag, selector.value === undefined ? undefined : regex(selector.value)) ? yes('docTag') : no;
  }
  // Type ancestry and members (M5-09, src/arch/selectors/hierarchy.ts): a type's, never a file's.
  // A member (method, property …) is judged by the type it belongs to, as a symbol is judged by its
  // file for `path`: a layer of Eloquent models holds their methods too (review of M5-09).
  const typeOf = () => (isType(element) ? element : hierarchyOf(ctx.view).ownerType(element));
  for (const key of ['extends', 'implements', 'inherits', 'mixes'] as const satisfies readonly HierarchyKey[]) {
    if (selector[key] === undefined) continue;
    if (element.kind !== 'symbol') return inapplicable;
    const type = typeOf();
    const chain = type ? hierarchyMatch(ctx.view, type, key, selector[key]!) : null;
    return chain ? { ...yes(key), chain } : no;
  }
  if (selector.inheritanceDepth !== undefined) {
    if (element.kind !== 'symbol') return inapplicable;
    const h = hierarchyOf(ctx.view);
    const type = typeOf();
    if (!type || h.depth(type) < selector.inheritanceDepth) return no;
    return { ...yes('inheritanceDepth'), chain: h.longestChain(type) };
  }
  if (selector.member !== undefined) {
    if (element.kind !== 'symbol') return inapplicable;
    const type = typeOf();
    const m = type ? matchingMember(ctx.view, type, selector.member) : null;
    return m ? { ...yes('member'), chain: [type!.qualifiedName, m.qualifiedName] } : no;
  }
  if (selector.repo !== undefined) return nameOrGlob(selector.repo)(file.repo) ? yes('repo') : no;
  if (selector.language !== undefined) return languageMatches(file.language, selector.language) ? yes('language') : no;
  if (selector.role !== undefined) {
    if (!file.role || file.role.toLowerCase() !== selector.role.toLowerCase()) return no;
    return file.roleConfidence >= (selector.confidence ?? 0) ? yes('role') : no;
  }
  if (selector.cluster !== undefined) {
    const test = nameOrGlob(selector.cluster);
    return file.clusters.some(test) ? yes('cluster') : no;
  }
  if (selector.workspacePackage !== undefined) {
    const name = ctx.view.workspacePackage(file.path);
    return name !== null && nameOrGlob(selector.workspacePackage)(name) ? yes('workspacePackage') : no;
  }
  if (selector.framework !== undefined) return file.frameworkParts.has(selector.framework) ? yes('framework') : no;
  if (selector.layer !== undefined) return ctx.inLayer(element, selector.layer) ? yes('layer') : no;
  // A selector this version cannot evaluate (UNSUPPORTED_SELECTORS): no match, and no match under `not`.
  return inapplicable;
}

/** The selector keys in `selector` (nested ones included) that this version cannot evaluate. */
export function unsupportedKeys(selector: Selector): string[] {
  const out: string[] = [];
  const visit = (s: Selector) => {
    for (const key of Object.keys(s)) if (key in UNSUPPORTED_SELECTORS) out.push(key);
    s.all?.forEach(visit);
    s.any?.forEach(visit);
    if (s.not) visit(s.not);
  };
  visit(selector);
  return out;
}
