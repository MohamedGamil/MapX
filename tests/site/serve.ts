// Builds the site into a temp folder and serves it under its base path, for the browser specs.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';
import { buildSite, REPO } from '../helpers/site-build.js';
import { DEFAULT_BASE } from '../../site/.vitepress/base.js';

export const BASE = DEFAULT_BASE;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.map': 'application/json',
};

/** Why the browser specs cannot run, or null. */
export function browserMissing(): string | null {
  let path = '';
  try { path = chromium.executablePath(); } catch { /* unknown platform */ }
  if (!(path && existsSync(path))) return 'Chromium is not installed, so the site browser tests are skipped: run `npx playwright install chromium`.';
  if (!existsSync(join(REPO, 'site', 'node_modules', 'vitepress'))) return 'site/node_modules is missing, so the site browser tests are skipped: run `npm ci --prefix site`.';
  return null;
}

export interface Served { origin: string; dir: string; close(): Promise<void> }

export async function buildAndServe(): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), 'mapx-site-'));
  try {
    const out = join(dir, 'out');
    buildSite(out);
    return await serve(dir, out);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Serves `out` under BASE the way GitHub Pages does: a folder without a trailing slash is redirected to it, and a missing path gets 404.html with status 404. */
async function serve(dir: string, out: string): Promise<Served> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === BASE.slice(0, -1)) { res.writeHead(301, { location: BASE }).end(); return; }
    if (!url.pathname.startsWith(BASE)) { res.writeHead(404).end('outside the base path'); return; }
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length))).replace(/^(\.\.[/\\])+/, '');
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
    const direct = [rel, `${rel}.html`].map((c) => join(out, c)).find(isFile);
    const dirIndex = join(out, rel, 'index.html');
    if (!direct && isFile(dirIndex) && rel !== '' && !url.pathname.endsWith('/')) {
      res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
      return;
    }
    const hit = direct ?? (isFile(dirIndex) ? dirIndex : undefined);
    const file = hit ?? join(out, '404.html');
    res.writeHead(hit ? 200 : 404, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    dir,
    close: async () => {
      await new Promise<void>((ok) => server.close(() => ok()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
