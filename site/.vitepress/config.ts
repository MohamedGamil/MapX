import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { defineConfig } from 'vitepress';
import { githubSlug, normaliseBase, siteOrigin } from './base';
import { docsSidebar } from './sidebar';

// The landing page reads site/.vitepress/facts.json, which `npm run site:sync` writes from the code.
if (!existsSync(new URL('./facts.json', import.meta.url))) {
  throw new Error('site/.vitepress/facts.json is missing: run `npm run site:sync` (`npm run site:build` and `npm run site:dev` do it for you)');
}
const version = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();

const base = normaliseBase(process.env.SITE_BASE);
const origin = siteOrigin(process.env.SITE_URL);

// SITE_OUT redirects the build output (the tests build into a temp folder). VitePress empties the
// output folder before it builds, so only an absolute path is accepted: a relative one would resolve
// against site/ and not against where the command was typed.
const outDir = process.env.SITE_OUT?.trim() || undefined;
if (outDir !== undefined && !isAbsolute(outDir)) throw new Error(`SITE_OUT must be an absolute path: ${outDir}`);

/** The path of a page under the base: `index.md` is the root, `docs/x.md` is `docs/x`, `docs/index.md` is `docs/`. */
function pageUrl(relativePath: string): string {
  return relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
}

const siteDescription =
  'Local code graph memory for LLMs: scan a codebase once, then query symbols, dependencies, impact and architecture rules without re-reading files.';

export default defineConfig({
  title: 'MapX',
  description: siteDescription,
  lang: 'en-US',
  base,
  cleanUrls: true,
  outDir,
  lastUpdated: false,
  // Absolute page URLs under the configured origin and base (the 404 page is left out by VitePress).
  sitemap: { hostname: `${origin}${base}` },
  // robots.txt names the sitemap by its absolute URL. Crawlers read it only at a host root, so under a
  // project-page address it has no effect; it is right for a custom domain or SITE_BASE=/.
  buildEnd(siteConfig) {
    mkdirSync(siteConfig.outDir, { recursive: true });
    writeFileSync(join(siteConfig.outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${origin}${base}sitemap.xml\n`);
  },
  markdown: {
    anchor: { slugify: githubSlug },
    config(md) {
      // The guides are documentation, not Vue templates: they quote Blade and Mustache `{{ … }}`, which
      // Vue would try to compile. Pages under docs/ render as plain HTML; the landing keeps Vue.
      const render = md.render.bind(md);
      md.render = (src, env) => {
        const html = render(src, env);
        return typeof env?.relativePath === 'string' && env.relativePath.startsWith('docs/')
          ? `<div v-pre>${html}</div>`
          : html;
      };
    },
  },
  // Canonical URL and Open Graph tags for every page; the card is site/public/og-card.png (M7-06).
  transformHead({ pageData }) {
    const title = pageData.frontmatter.title || pageData.title || 'MapX';
    const description = pageData.frontmatter.description || pageData.description || siteDescription;
    const url = `${origin}${base}${pageUrl(pageData.relativePath)}`;
    return [
      ['meta', { property: 'og:type', content: 'website' }],
      // The 404 page has no address of its own: no og:url and no canonical link for it.
      ...(pageData.isNotFound ? [] : [['meta', { property: 'og:url', content: url }] as [string, Record<string, string>]]),
      ['meta', { property: 'og:title', content: `${title}` }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:image', content: `${origin}${base}og-card.png` }],
      ['meta', { property: 'og:image:width', content: '1200' }],
      ['meta', { property: 'og:image:height', content: '630' }],
      ['meta', { property: 'og:image:alt', content: 'MapX: local code graph memory for LLMs' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ...(pageData.isNotFound ? [] : [['link', { rel: 'canonical', href: url }] as [string, Record<string, string>]]),
    ];
  },
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${base}favicon-32.png` }],
    ['link', { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` }],
    ['meta', { name: 'theme-color', content: '#14161a' }],
    ['meta', { property: 'og:site_name', content: 'MapX' }],
  ],
  themeConfig: {
    logo: '/mapx-logo.png',
    siteTitle: 'MapX',
    nav: [
      { text: 'Docs', link: '/docs/', activeMatch: '^/docs/' },
      { text: 'npm', link: 'https://www.npmjs.com/package/@mgamil/mapx' },
      { text: `v${version}`, link: 'https://github.com/MohamedGamil/mapx/blob/main/CHANGELOG.md' },
    ],
    // The home link's aria-label defaults to "go to home", which does not contain its visible text.
    notFound: { linkLabel: 'Take me home' },
    sidebar: { '/docs/': docsSidebar() },
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/MohamedGamil/mapx/edit/main/:path',
      text: 'Edit this page on GitHub',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/MohamedGamil/mapx' }],
    footer: {
      message:
        'MapX is created by Mohamed Gamil · <a href="https://gamil.io" target="_blank" rel="noopener">gamil.io</a> · Released under the Apache-2.0 license.',
    },
  },
});
