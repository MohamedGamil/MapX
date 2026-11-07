// M7-03: the landing page. Every figure on it is read from the code at build time. These tests compute
// each figure straight from its source (not through the site generator), so a wrong generator fails.
// The built-page tests skip without site/node_modules (REQUIRE_SITE=1 makes that a failure).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { getBuiltinLanguages, supportedLanguageCount } from '../src/languages/registry.js';
import { FrameworkRegistry } from '../src/frameworks/framework-registry.js';
import { PRESETS } from '../src/arch/config.js';
import { AgentGenerator } from '../src/agents/generator.js';
import { buildSite, builtFileFor } from './helpers/site-build';
import { AGENT_NAMES, LANGUAGE_NAMES, QUICKSTART_COMMANDS, agentKeys, languageIds, siteFacts, type SiteFacts } from '../scripts/site/site-facts';

const ROOT = resolve(__dirname, '..');
const SITE = join(ROOT, 'site');
const installed = existsSync(join(SITE, 'node_modules', 'vitepress'));
const run = installed || process.env.REQUIRE_SITE === '1' ? describe : describe.skip;
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** The text of an HTML fragment with tags removed and the common entities decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

describe('site facts come from the code (M7-03)', () => {
  let facts: SiteFacts;
  let toolNames: string[] = [];
  let client: Client;
  beforeAll(async () => {
    facts = await siteFacts();
    const [c, s] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(s);
    client = new Client({ name: 'site-landing', version: '1.0.0' });
    await client.connect(c);
    toolNames = (await client.listTools()).tools.map((t) => t.name);
  });
  afterAll(async () => {
    await client?.close();
  });

  it('counts MCP tools, languages, frameworks and presets as the code reports them', () => {
    expect(facts.mcpTools).toBe(toolNames.length);
    expect(facts.languages.length).toBe(supportedLanguageCount());
    expect(facts.frameworks).toBe(FrameworkRegistry.getInstance().getDetectors().length);
    expect(facts.presets).toBe(Object.keys(PRESETS).length);
    expect(facts.version).toBe(readFileSync(join(ROOT, 'VERSION'), 'utf8').trim());
  });

  it('lists exactly the registry languages, each with a display name', () => {
    const ids = Object.values(getBuiltinLanguages())
      .filter((l) => l.tier !== 'static' && l.name !== 'tsx')
      .map((l) => l.name)
      .sort();
    expect(facts.languages.map((l) => l.id).sort()).toEqual(ids);
    for (const l of facts.languages) expect(l.name, l.id).toBe(LANGUAGE_NAMES[l.id]);
    expect([...languageIds()].sort()).toEqual(ids);
  });

  it('lists the agent targets the generator can write, each with a display name', () => {
    // The generator's own list of targets (hidden helper templates excluded), without the generic AGENTS.md.
    const keys = new AgentGenerator().listProviders().filter((p) => p !== 'generic');
    expect(keys.length).toBeGreaterThan(5);
    expect([...agentKeys()].sort()).toEqual(keys.sort());
    expect(facts.agents.map((a) => a.id).sort()).toEqual(keys.sort());
    for (const a of facts.agents) expect(a.name).toBe(AGENT_NAMES[a.id]);
  });

  it('takes the install commands and the MCP configuration from README.md, verbatim', () => {
    expect(facts.install.npm).toBe('npm install -g @mgamil/mapx');
    expect(readme).toContain(facts.install.npm);
    expect(readme).toContain(facts.install.npx);
    for (const line of facts.quickstart) expect(readme, line).toContain(line);
    // Copying the block must work: the architecture configuration is proposed before `mapx check` needs it.
    const heads = facts.quickstart.map((l) => QUICKSTART_COMMANDS.find((c) => l === c || l.startsWith(`${c} `)));
    expect(heads).toEqual([...QUICKSTART_COMMANDS]);
    const at = (c: string) => facts.quickstart.findIndex((l) => l === c || l.startsWith(`${c} `));
    expect(at('mapx arch init')).toBeGreaterThan(-1);
    expect(at('mapx arch init')).toBeLessThan(at('mapx check'));
    expect(at('mapx init')).toBeLessThan(at('mapx scan'));
    expect(at('mapx scan')).toBeLessThan(at('mapx query'));
    expect(facts.quickstart.join('\n')).not.toContain('\r');
    expect(facts.install.npm).not.toContain('\r');
    expect(readme).toContain(facts.mcpConfig);
    expect(JSON.parse(facts.mcpConfig).mcpServers.mapx.command).toBe('mapx');
  });
});

run('built landing page (M7-03)', () => {
  let tmp = '';
  let html = '';
  let facts: SiteFacts;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mapx-site-'));
    buildSite(join(tmp, 'out'));
    html = readFileSync(join(tmp, 'out', 'index.html'), 'utf8');
    facts = await siteFacts();
  }, 240_000);
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  /** The value shown for a stat, by its label. */
  const stat = (label: string): number => {
    const m = new RegExp(`<dt[^>]*>\\s*${label}\\s*</dt>\\s*<dd[^>]*>\\s*(\\d+)\\s*</dd>`).exec(html) ?? new RegExp(`<dd[^>]*>\\s*(\\d+)\\s*</dd>\\s*<dt[^>]*>\\s*${label}\\s*</dt>`).exec(html);
    expect(m, `stat "${label}"`).not.toBeNull();
    return Number(m![1]);
  };

  it('states the counts the code reports', async () => {
    // Counted here from the server itself, not taken from the generator that fed the page.
    const [c, srv] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(srv);
    const probe = new Client({ name: 'site-landing-built', version: '1.0.0' });
    await probe.connect(c);
    const tools = (await probe.listTools()).tools.length;
    await probe.close();
    expect(stat('MCP tools')).toBe(tools);
    expect(stat('Languages')).toBe(supportedLanguageCount());
    expect(stat('Framework detectors')).toBe(FrameworkRegistry.getInstance().getDetectors().length);
    expect(stat('Architecture presets')).toBe(Object.keys(PRESETS).length);
  });

  it('states the same counts in the prose, not only in the numbers strip', () => {
    const prose = text(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ''));
    const languages = supportedLanguageCount();
    expect(prose).toContain(`${languages} languages`);
    expect(prose).toContain(`from ${languages} languages`);
    expect(prose).toContain(`through ${facts.mcpTools} MCP tools`);
    // No other count of languages or tools appears anywhere in the prose.
    for (const m of prose.matchAll(/(\d+) (languages|MCP tools)/g)) {
      expect(Number(m[1]), m[0]).toBe(m[2] === 'languages' ? languages : facts.mcpTools);
    }
  });

  it('shows every language and every agent once', () => {
    const langs = [...html.matchAll(/data-lang="([^"]+)"/g)].map((m) => m[1]!).sort();
    expect(langs).toEqual([...languageIds()].sort());
    const agents = [...html.matchAll(/data-agent="([^"]+)"/g)].map((m) => m[1]!).sort();
    expect(agents).toEqual([...agentKeys()].sort());
  });

  it('shows the README install commands and MCP configuration', () => {
    const blocks = [...html.matchAll(/<pre[^>]*class="[^"]*landing-code[^"]*"[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => text(m[1]!));
    const all = blocks.join('\n');
    expect(all).toContain(facts.install.npm);
    expect(all).toContain(facts.install.npx);
    for (const line of facts.quickstart) expect(all, line).toContain(line);
    expect(blocks.some((b) => b.trim() === facts.mcpConfig.trim())).toBe(true);
  });

  it('has one h1, a 50-160 character description and Open Graph tags', () => {
    expect([...html.matchAll(/<h1[\s>]/g)].length).toBe(1);
    const desc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(desc.length).toBeGreaterThanOrEqual(50);
    expect(desc.length).toBeLessThanOrEqual(160);
    for (const p of ['og:title', 'og:description', 'og:image', 'og:type']) {
      expect(html, p).toMatch(new RegExp(`<meta property="${p}" content="[^"]+"`));
    }
  });

  it('shows no literal Markdown in the prose (Vue does not render it)', () => {
    const prose = text(html.replace(/<(script|pre|style)[\s\S]*?<\/\1>/g, ''));
    expect(prose).not.toContain('`');
    expect(prose).not.toMatch(/\*\*[^*]+\*\*/);
  });

  it('resolves every link and image on the page to a built page, file and id', () => {
    const base = '/mapx/';
    const out = join(tmp, 'out');
    const refs = [
      ...[...html.matchAll(/<a [^>]*?\bhref="([^"]+)"/g)].map((m) => m[1]!),
      ...[...html.matchAll(/<img [^>]*?\bsrc="([^"]+)"/g)].map((m) => m[1]!),
    ];
    const broken: string[] = [];
    let internal = 0;
    for (const ref of refs) {
      const href = ref.replace(/&amp;/g, '&');
      if (/^(https?:|mailto:|data:|\/\/)/.test(href)) continue;
      internal++;
      const url = new URL(href, `http://site.test${base}`);
      const file = builtFileFor(out, base, url.pathname);
      if (!file) { broken.push(`${href}: no file`); continue; }
      const frag = decodeURIComponent(url.hash.slice(1));
      if (frag && !new RegExp(`\\sid="${frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(readFileSync(file, 'utf8'))) broken.push(`${href}: no id`);
    }
    expect(broken).toEqual([]);
    // The cards, the call to action, the nav and the hero image: a regex that matched nothing must fail.
    expect(internal).toBeGreaterThan(10);
    for (const guide of ['getting-started', 'mcp-integration', 'cli-reference', 'architecture-rules']) {
      expect(refs, guide).toContain(`${base}docs/${guide}`);
    }
  });

  it('gives Open Graph an absolute image and this page its own url', () => {
    expect(html).toMatch(/<meta property="og:image" content="https:\/\/mohamedgamil\.github\.io\/mapx\/mapx-logo\.png"/);
    expect(html).toMatch(/<meta property="og:url" content="https:\/\/mohamedgamil\.github\.io\/mapx\/"/);
    expect(existsSync(join(tmp, 'out', 'mapx-logo.png'))).toBe(true);
  });

  it('links the primary button to the getting-started guide under the base path', () => {
    expect(html).toMatch(/href="\/mapx\/docs\/getting-started"/);
  });
});
