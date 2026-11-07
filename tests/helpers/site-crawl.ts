// Crawls a built site the way a visitor's browser would (M7-06): from index.html, following every
// internal link, image, script and stylesheet, resolving each against the URL its page is served at.
// It reports references that reach no file, #fragments that name no id, and built pages that no link reaches.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { builtFileFor } from './site-build';

export interface CrawlResult {
  /** Pages reached from the entry, as paths relative to the output folder. */
  reached: string[];
  /** Built pages (not 404.html) that nothing links to. */
  orphans: string[];
  /** Each broken reference: where it is and what is wrong. */
  broken: string[];
  /** How many internal references were checked. */
  checked: number;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The values of `attr` on every `<tag …>` of a page, with double, single or no quotes. The attribute must
 * stand on its own (`href=`, not `data-href=`).
 */
function refsOf(html: string, tag: string, attr: string, keep: (tagText: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const t of html.matchAll(new RegExp(`<${tag}\\s(?:"[^"]*"|'[^']*'|[^>"'])*>`, 'g'))) {
    if (!keep(t[0])) continue;
    const m = new RegExp(`(?:^|\\s)${attr}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`).exec(t[0]);
    if (m) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function htmlFiles(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name), root) : e.name.endsWith('.html') ? [relative(root, join(dir, e.name)).split('\\').join('/')] : [],
  );
}

/** The URL path a built page is served at under `base` (cleanUrls: no .html). */
export function urlOf(base: string, file: string): string {
  if (file === 'index.html') return base;
  if (file.endsWith('/index.html')) return `${base}${file.slice(0, -'index.html'.length)}`;
  return `${base}${file.slice(0, -'.html'.length)}`;
}

export function crawlSite(out: string, base: string, entry = 'index.html'): CrawlResult {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  const broken: string[] = [];
  let checked = 0;

  while (queue.length) {
    const file = queue.shift()!;
    const html = readFileSync(join(out, file), 'utf8');
    const here = `http://site.test${urlOf(base, file)}`;
    // Script bodies hold JSON (the theme config, with its footer HTML) whose quotes are escaped: they are
    // not markup. A script's own `src` is read from the tag.
    const markup = html.replace(/(<script\b(?:"[^"]*"|'[^']*'|[^>"'])*>)[\s\S]*?<\/script>/g, '$1</script>');
    const refs = [
      ...refsOf(markup, 'a', 'href').map((value) => ({ kind: 'a', value })),
      ...refsOf(markup, 'img', 'src').map((value) => ({ kind: 'img', value })),
      ...refsOf(markup, 'script', 'src').map((value) => ({ kind: 'script', value })),
      ...refsOf(markup, 'link', 'href', (tag) => !/rel=["']canonical["']/.test(tag)).map((value) => ({ kind: 'link', value })),
    ];
    for (const { kind, value } of refs) {
      const href = value.replace(/&amp;/g, '&');
      if (href === '' || EXTERNAL.test(href)) continue;
      checked++;
      const url = new URL(href, here);
      const target = builtFileFor(out, base, safeDecode(url.pathname));
      if (!target) {
        broken.push(`${file}: <${kind}> ${href} reaches no file`);
        continue;
      }
      const rel = relative(out, target).split('\\').join('/');
      const frag = url.hash ? safeDecode(url.hash.slice(1)) : '';
      if (frag && !new RegExp(`\\sid="${escapeRe(frag)}"`).test(readFileSync(target, 'utf8'))) {
        broken.push(`${file}: <${kind}> ${href} names no id "${frag}" on ${rel}`);
      }
      if (kind === 'a' && rel.endsWith('.html') && !seen.has(rel)) {
        seen.add(rel);
        queue.push(rel);
      }
    }
  }

  const orphans = htmlFiles(out).filter((f) => f !== '404.html' && !seen.has(f));
  return { reached: [...seen].sort(), orphans: orphans.sort(), broken, checked };
}

/** The size in bytes of every file under a folder, summed. */
export function folderBytes(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? folderBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size),
    0,
  );
}

