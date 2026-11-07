// The `member` selector (M5-09; AR-04): a type with an own member (method, property, field,
// constant, nested type …) whose name the regex matches, case-insensitive unless written
// `/body/flags`. A PHP property's `$` is optional (`^total$` matches `$total`). Inherited members
// do not count. Symbol-level: inapplicable to a file; a member is judged by its type.
import type { Element, ElementView } from '../elements.js';
import { regex } from './patterns.js';
import { hierarchyOf } from './hierarchy.js';

/** The first own member of the type `el` whose name matches `pattern`, or null. */
export function matchingMember(view: ElementView, el: Element, pattern: string): Element | null {
  const test = regex(pattern);
  return hierarchyOf(view).members(el).find((m) => test(m.name!) || (m.name!.startsWith('$') && test(m.name!.slice(1)))) ?? null;
}
