// The site's base path and origin, read from SITE_BASE and SITE_URL. No imports, so the root test
// suite can unit-test it without installing the site's dependencies.

/**
 * The default base: the project page https://mohamedgamil.github.io/MapX/. The repository is named `MapX` and a
 * Pages address is case-sensitive in that segment (`/mapx/` is a 404), so the case is the repository's own.
 * The Pages workflow does not rely on this default: it sets SITE_BASE from the repository's name.
 */
export const DEFAULT_BASE = '/MapX/';

/**
 * `/MapX/`, `/x/` or `/`: always a leading and a trailing slash. An unset or blank value is the
 * default; the site root is written `/`. A URL, a `..` segment or an empty segment is refused, since
 * the base is meant to be a path.
 */
export function normaliseBase(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_BASE;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || (value.startsWith('//') && /[^/]/.test(value))) {
    throw new Error(`SITE_BASE must be a path such as /MapX/, not a URL: ${value}`);
  }
  const inner = value.replace(/^\/+|\/+$/g, '');
  if (inner === '') return '/';
  const segments = inner.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`SITE_BASE has an empty or relative segment: ${value}`);
  }
  return `/${segments.join('/')}/`;
}

/** The canonical origin without a trailing slash; M7-06 uses it for the sitemap and canonical links. */
export function siteOrigin(raw: string | undefined): string {
  return (raw?.trim() || 'https://mohamedgamil.github.io').replace(/\/+$/, '');
}

/**
 * A heading's anchor the way GitHub makes it: lower case, punctuation dropped, spaces to hyphens. The
 * guides link to these anchors (tests/docs-surface.test.ts checks them in the repository), and
 * VitePress's own slugs differ for headings with an apostrophe, a slash or a plus sign.
 */
export function githubSlug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
}
