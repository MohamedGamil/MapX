// The site's base path and origin, read from SITE_BASE and SITE_URL. No imports, so the root test
// suite can unit-test it without installing the site's dependencies.

/** The default base: the project page https://mohamedgamil.github.io/mapx/. */
export const DEFAULT_BASE = '/mapx/';

/**
 * `/mapx/`, `/x/` or `/`: always a leading and a trailing slash. An unset or blank value is the
 * default; the site root is written `/`. A URL, a `..` segment or an empty segment is refused, since
 * the base is meant to be a path.
 */
export function normaliseBase(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_BASE;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || (value.startsWith('//') && /[^/]/.test(value))) {
    throw new Error(`SITE_BASE must be a path such as /mapx/, not a URL: ${value}`);
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
