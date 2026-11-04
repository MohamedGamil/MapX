// The `package`, `builtin` and `ambient` selectors (M5-24; AR-04, Deptrac's `composer` and
// `php_internal` collectors, and `superglobal`). They match external elements only: what the scan
// attributed a reference outside the workspace to (src/arch/elements.ts, the `external_refs` view
// of M5-19 to M5-23).
//   package (+ dev, direct)  origin package, by name: the package, or for one no input provides
//                            (package null) the name as written, so `"*"` covers every package
//   builtin                  origin builtin (Node, PHP extensions, Python and Go standard libraries)
//   ambient                  origin ambient, by element: process-global access (`env`, `argv`, `window`,
//                            `$_GET`, M5-24-R1), cgo's `C`, PECL extensions (`ext-redis`)
// A name pattern's `*` matches any run of characters, `/` included: package names are not paths
// (`@acme/*`, `guzzlehttp/*`, `golang.org/x/*`, `*`). `/regex/flags` is a regex. Names compare as
// each ecosystem compares them (review of M5-24): npm and Composer ignore case; pypi also treats
// runs of `-`, `_` and `.` as one `-` (PEP 503: `Flask_SQLAlchemy` is `flask-sqlalchemy`); Go
// module and package paths are case-sensitive.
import type { Element } from '../elements.js';
import type { Selector } from '../schema.js';
import { AMBIENT_ELEMENTS } from '../../core/external-refs.js';

const patterns = new Map<string, (s: string) => boolean>();

/** PEP 503: a distribution name, lowercased, with each run of `-`, `_` and `.` as one `-`. */
const pep503 = (s: string) => s.replace(/[-_.]+/g, '-').toLowerCase();

/** A name pattern for an ecosystem's names of an origin: a glob whose `*` crosses `/`, or `/regex/flags`. */
export function namePattern(pattern: string, ecosystem = '', origin = 'package'): (s: string) => boolean {
  const pypi = ecosystem === 'pypi' && origin === 'package';
  // Go module and package paths are exact; an ambient element is MapX's own name, so it is not (M5-24-R1).
  const caseSensitive = ecosystem === 'go' && origin !== 'ambient';
  const key = `${pypi ? 'p' : caseSensitive ? 'c' : 'i'}:${pattern}`;
  let fn = patterns.get(key);
  if (!fn) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
    if (m) {
      const re = new RegExp(m[1]!, m[2]);
      fn = (s) => re.test(s);
    } else {
      const glob = pypi ? pep503(pattern) : pattern;
      const re = new RegExp(`^${glob.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`, caseSensitive ? '' : 'i');
      fn = pypi ? (s) => re.test(pep503(s)) : (s) => re.test(s);
    }
    patterns.set(key, fn);
  }
  return fn;
}

/** Does the external selector key `key` of `selector` match the external element `el`? */
export function externalMatch(selector: Selector, key: 'package' | 'builtin' | 'ambient', el: Element): boolean {
  const ext = el.external!;
  if (key === 'package') {
    if (ext.origin !== 'package' || !namePattern(selector.package!, ext.ecosystem)(ext.name)) return false;
    if (selector.dev !== undefined && ext.dev !== selector.dev) return false;
    if (selector.direct !== undefined && ext.direct !== selector.direct) return false;
    return true;
  }
  if (ext.origin !== key) return false;
  const value = selector[key];
  return value === true || (typeof value === 'string' && namePattern(value, ext.ecosystem, key)(ext.name));
}

/** The expressions people write for an element (`process.env`), and the element each one means. */
const ELEMENT_OF_ACCESS: Record<string, string> = {
  'process.env': 'env', 'os.environ': 'env', 'os.getenv': 'env', 'getenv': 'env', '$_env': 'env', 'os.getenv()': 'env', 'getenv()': 'env',
  'sys.argv': 'argv', 'os.args': 'argv', 'process.argv': 'argv', '$argv': 'argv',
};

/**
 * The ambient names of a selector (any depth) that name no element a scan records (M5-24-R1): a
 * glob or name that matches none of the element names, `C` or an `ext-` PECL name, each with a hint.
 * A regular expression is not checked. Such a selector matches nothing, which validates fine, so the
 * report says so.
 */
export function unknownAmbientNames(selector: Selector): Array<{ name: string; hint: string }> {
  const out: Array<{ name: string; hint: string }> = [];
  const walk = (s: Selector | undefined) => {
    if (!s) return;
    const value = s.ambient;
    if (typeof value === 'string' && !/^\/.*\/[a-z]*$/s.test(value)) {
      const known = namePattern(value, '', 'ambient');
      if (!AMBIENT_ELEMENTS.some((e) => known(e)) && !known('C') && !/^ext-/i.test(value) && !(value.includes('*') && known('ext-redis'))) {
        const means = ELEMENT_OF_ACCESS[value.toLowerCase()] ?? AMBIENT_ELEMENTS.find((e) => e.toLowerCase() === value.toLowerCase().replace(/^\$?/, '$')) ;
        out.push({ name: value, hint: `${means ? `did you mean "${means}"? ` : ''}Element names: ${AMBIENT_ELEMENTS.join(', ')}; "C"; "ext-*" (PECL).` });
      }
    }
    for (const sub of [...(s.all ?? []), ...(s.any ?? [])]) walk(sub);
    if (s.not) walk(s.not);
  };
  walk(selector);
  return out;
}
