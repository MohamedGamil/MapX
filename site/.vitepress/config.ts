import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defineConfig } from 'vitepress';
import { githubSlug, normaliseBase, siteOrigin } from './base';
import { docsSidebar } from './sidebar';

const version = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();

const base = normaliseBase(process.env.SITE_BASE);
const origin = siteOrigin(process.env.SITE_URL);

// SITE_OUT redirects the build output (the tests build into a temp folder). VitePress empties the
// output folder before it builds, so only an absolute path is accepted: a relative one would resolve
// against site/ and not against where the command was typed.
const outDir = process.env.SITE_OUT?.trim() || undefined;
if (outDir !== undefined && !isAbsolute(outDir)) throw new Error(`SITE_OUT must be an absolute path: ${outDir}`);

export default defineConfig({
  title: 'MapX',
  description:
    'Local code graph memory for LLMs: scan a codebase once, then query symbols, dependencies, impact and architecture rules without re-reading files.',
  lang: 'en-US',
  base,
  cleanUrls: true,
  outDir,
  lastUpdated: false,
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
  // The theme's Inter font is never used (brand.css puts the system stack first), so its preload is a
  // wasted request and a console warning. The site makes no web-font requests.
  transformHtml: (code) => code.replace(/<link rel="preload" href="[^"]*\.woff2"[^>]*>/g, ''),
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${base}favicon-32.png` }],
    ['link', { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` }],
    ['meta', { name: 'theme-color', content: '#14161a' }],
    ['meta', { property: 'og:site_name', content: 'MapX' }],
    ['meta', { property: 'og:url', content: `${origin}${base}` }],
  ],
  themeConfig: {
    logo: '/mapx-logo.png',
    siteTitle: 'MapX',
    nav: [
      { text: 'Docs', link: '/docs/', activeMatch: '^/docs/' },
      { text: 'npm', link: 'https://www.npmjs.com/package/@mgamil/mapx' },
      { text: `v${version}`, link: 'https://github.com/MohamedGamil/mapx/blob/main/CHANGELOG.md' },
    ],
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
