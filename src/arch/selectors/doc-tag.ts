// The `docTag` selector (M5-10; AR-04, Deptrac's `tagValueRegex`): the symbol's doc block has the
// tag (`metadata.docTags`, src/parsers/annotations.ts), compared case-insensitively with the `@`
// optional, and with `value` one occurrence's value matches. In Python a `@deprecated` decorator
// (any qualifier) counts as the `@deprecated` tag, its arguments as the value. M5-11 reads internal
// markers (`visibility.internalTags`) through `docTagsOf` and `hasDocTag`.
import type { Element } from '../elements.js';
import type { SymbolDocTag } from '../../types.js';

const bare = (tag: string) => tag.trim().replace(/^@/, '').toLowerCase();

/** The element's doc tags, with Python's `@deprecated` decorators as tags. */
export function docTagsOf(element: Element): SymbolDocTag[] {
  const tags = element.docTags ?? [];
  if (element.file.language !== 'python' || !element.decorators?.length) return tags;
  const deprecations = element.decorators
    .filter((d) => /(^|\.)deprecated$/i.test(d.name))
    .map((d) => ({ tag: '@deprecated', value: d.args ?? '' }));
  return deprecations.length ? [...tags, ...deprecations] : tags;
}

/** Does the symbol element have doc tag `tag` (`@internal` or `internal`), with a value `value` accepts? */
export function hasDocTag(element: Element, tag: string, value?: (v: string) => boolean): boolean {
  const want = bare(tag);
  return docTagsOf(element).some((t) => bare(t.tag) === want && (!value || value(t.value)));
}
