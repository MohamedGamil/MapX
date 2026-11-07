// M7-03: the facts the landing page shows, read from the code and the README when the site is built.
//
// Nothing on the landing page is a typed number: the counts come from the same sources that
// tests/docs-surface.test.ts checks the docs against, and the install commands are the README's own
// fenced blocks. The result is written to site/.vitepress/facts.json (gitignored) so VitePress, which
// builds the pages, never imports src/ and its native modules.
//
//   tsx scripts/site/site-facts.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/mcp.js';
import { getBuiltinLanguages } from '../../src/languages/registry.js';
import { FrameworkRegistry } from '../../src/frameworks/framework-registry.js';
import { PRESETS } from '../../src/arch/config.js';
import { AgentGenerator } from '../../src/agents/generator.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Display names of the languages. An id without a name stops the sync, so none appears unnamed. */
export const LANGUAGE_NAMES: Record<string, string> = {
  php: 'PHP', javascript: 'JavaScript', typescript: 'TypeScript', vue: 'Vue', svelte: 'Svelte', python: 'Python',
  go: 'Go', rust: 'Rust', java: 'Java', 'c-sharp': 'C#', ruby: 'Ruby', c: 'C', cpp: 'C++', swift: 'Swift',
  kotlin: 'Kotlin', scala: 'Scala', dart: 'Dart', lua: 'Lua', elixir: 'Elixir', zig: 'Zig', bash: 'Bash',
  fish: 'Fish', pascal: 'Pascal',
};

/** Display names of the agent tools `mapx agents generate` writes instructions for. */
export const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude', cursor: 'Cursor', copilot: 'GitHub Copilot', windsurf: 'Windsurf', cline: 'Cline',
  aider: 'Aider', gemini: 'Gemini', continue: 'Continue', zed: 'Zed', antigravity: 'Antigravity',
};

export interface SiteFacts {
  version: string;
  mcpTools: number;
  frameworks: number;
  presets: number;
  languages: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  install: { npm: string; npx: string };
  quickstart: string[];
  mcpConfig: string;
}

/** The ids of the languages MapX has a grammar for: not a static file type, and TSX counts as TypeScript. */
export function languageIds(): string[] {
  return Object.values(getBuiltinLanguages())
    .filter((l) => l.tier !== 'static' && l.name !== 'tsx')
    .map((l) => l.name);
}

/** The agent tools `mapx agents generate` writes for: the generator's own list, without the generic AGENTS.md. */
export function agentKeys(): string[] {
  return new AgentGenerator().listProviders().filter((p) => p !== 'generic');
}

/** The body of the first fenced block after the heading that matches `heading`. */
export function fencedBlockAfter(markdown: string, heading: RegExp, lang?: string): string {
  const lines = markdown.split('\n');
  const at = lines.findIndex((l) => heading.test(l));
  if (at === -1) throw new Error(`README.md has no heading matching ${heading}`);
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,3} /.test(lines[i]!)) break;
    const open = /^```(\w*)\s*$/.exec(lines[i]!);
    if (open && (lang === undefined || open[1] === lang)) {
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && !/^```\s*$/.test(lines[j]!); j++) body.push(lines[j]!);
      return body.join('\n');
    }
  }
  throw new Error(`README.md has no ${lang ?? ''} code block under ${heading}`);
}

/** The README quick-start commands the page shows, in README order. `arch init` comes before `check`: without a configuration `mapx check` exits 3. */
export const QUICKSTART_COMMANDS = ['mapx init', 'mapx scan', 'mapx export', 'mapx query', 'mapx callers', 'mapx impact', 'mapx arch init', 'mapx check', 'mapx sync'];

export async function siteFacts(root: string = ROOT): Promise<SiteFacts> {
  const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  const client = new Client({ name: 'site-facts', version: '1.0.0' });
  await client.connect(clientSide);
  const mcpTools = (await client.listTools()).tools.length;
  await client.close();

  const named = <T extends string>(ids: string[], names: Record<string, string>, what: string) =>
    ids.map((id) => {
      const name = names[id];
      if (!name) throw new Error(`site-facts: ${what} "${id}" has no display name; add it to ${what.toUpperCase()}_NAMES`);
      return { id, name };
    });

  const npm = fencedBlockAfter(readme, /^### From npm/, 'bash').split('\n').find((l) => l.startsWith('npm install'));
  const npx = fencedBlockAfter(readme, /^### Zero Installation/, 'bash').split('\n').find((l) => l.startsWith('npx @mgamil/mapx init'));
  if (!npm || !npx) throw new Error('site-facts: the README install blocks changed shape');

  const quickstart = fencedBlockAfter(readme, /^## Quick start/, 'bash')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => QUICKSTART_COMMANDS.some((c) => l === c || l.startsWith(`${c} `)));
  if (quickstart.length !== QUICKSTART_COMMANDS.length) throw new Error('site-facts: the README quick start no longer has the expected commands');

  return {
    version: readFileSync(join(root, 'VERSION'), 'utf8').trim(),
    mcpTools,
    frameworks: FrameworkRegistry.getInstance().getDetectors().length,
    presets: Object.keys(PRESETS).length,
    languages: named(languageIds(), LANGUAGE_NAMES, 'language'),
    agents: named(agentKeys(), AGENT_NAMES, 'agent'),
    install: { npm, npx },
    quickstart,
    mcpConfig: fencedBlockAfter(readme, /^### Claude Desktop/, 'json'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = join(ROOT, 'site', '.vitepress', 'facts.json');
  // A failed run must not leave the previous numbers behind for a later build to publish.
  rmSync(out, { force: true });
  const facts = await siteFacts();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(facts, null, 2)}\n`);
  console.log(`site facts: ${facts.mcpTools} MCP tools, ${facts.languages.length} languages, ${facts.frameworks} frameworks, ${facts.presets} presets`);
  // The MCP server and the framework registry leave handles open; the facts are written.
  process.exit(0);
}
