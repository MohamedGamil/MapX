// The `decorator` selector (M5-10; AR-04, Deptrac's `attribute`). A plain value matches a stored
// decorator (`metadata.decorators`, src/parsers/annotations.ts), case-insensitively, when:
// - the value equals its name, or is a suffix of it on a namespace boundary (`\` or `.`):
//   `Entity` and `Mapping\Entity` match `Doctrine\ORM\Mapping\Entity`, `tity` does not;
// - the same holds for the name as written, kept when PHP resolution changed it: `ORM\Entity`
//   (`use Doctrine\ORM\Mapping as ORM`) and an alias `Baz` match;
// - outside PHP, where names are stored as written, the stored name is such a suffix of the value:
//   `System.Obsolete` matches `[Obsolete]`, `javax.persistence.Entity` matches `@Entity`.
// In C#, `X` and `XAttribute` match each other. `/regex/flags` is a regex on the name and on the
// name as written.
import type { Element } from '../elements.js';
import type { SymbolDecorator } from '../../types.js';

const matchers = new Map<string, (d: SymbolDecorator, language: string) => boolean>();

/** `Entity` → [entity]; `@ORM\Entity` → [orm, entity]; `#[\Deprecated]` → [deprecated]. */
function segments(name: string): string[] {
  return name.trim().replace(/^(#\[|\[|@)/, '').replace(/\]$/, '').replace(/^\\/, '').toLowerCase().split(/\\|\./).filter(Boolean);
}

const withoutAttributeSuffix = (s: string) => (s.length > 'attribute'.length && s.endsWith('attribute') ? s.slice(0, -'attribute'.length) : s);

/** Whether `tail` ends `whole` segment by segment; in C# the last segments may differ by `Attribute`. */
function endsWith(whole: string[], tail: string[], csharp: boolean): boolean {
  if (!tail.length || whole.length < tail.length) return false;
  const offset = whole.length - tail.length;
  return tail.every((t, i) => {
    const w = whole[offset + i]!;
    return w === t || (csharp && i === tail.length - 1 && withoutAttributeSuffix(w) === withoutAttributeSuffix(t));
  });
}

/** A compiled `decorator` value: does a stored decorator, in a file of `language`, match it? */
export function decoratorMatcher(pattern: string): (d: SymbolDecorator, language: string) => boolean {
  let fn = matchers.get(pattern);
  if (!fn) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
    if (m) {
      const re = new RegExp(m[1]!, m[2]);
      fn = (d) => re.test(d.name) || (d.written !== undefined && re.test(d.written));
    } else {
      const want = segments(pattern);
      fn = (d, language) => {
        const csharp = language === 'c-sharp';
        const name = segments(d.name);
        return endsWith(name, want, csharp)
          || (d.written !== undefined && endsWith(segments(d.written), want, csharp))
          || (language !== 'php' && endsWith(want, name, csharp));
      };
    }
    matchers.set(pattern, fn);
  }
  return fn;
}

/** Does the symbol element carry a decorator matching `pattern`? */
export function hasDecorator(element: Element, pattern: string): boolean {
  if (!element.decorators?.length) return false;
  const matches = decoratorMatcher(pattern);
  return element.decorators.some((d) => matches(d, element.file.language));
}
