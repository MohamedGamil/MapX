// M4-28: the docs follow the code. Every MCP tool the server lists has a section in
// docs/mcp-integration.md naming each of its parameters; every CLI command, subcommand and flag is
// in docs/cli-reference.md, in the section about that command; the counts the docs state (MCP tools,
// frameworks, presets) equal the code's; and every relative link in README.md and docs/*.md reaches
// an existing file and heading. Language counts are checked by tests/legacy-languages.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { buildCLI } from '../src/cli.js';
import { FrameworkRegistry } from '../src/frameworks/framework-registry.js';
import { PRESETS } from '../src/arch/config.js';
import { FORMATS, GRAPH_FORMATS } from '../src/arch/reporters/index.js';

const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// docs/baton and docs/research hold dated records; they quote the surface as it was.
const DOCS = ['README.md', ...(readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`))];

/** Markdown split at headings of the given levels, fenced code blocks left whole. */
function sections(text: string, levels: RegExp): { head: string; body: string }[] {
  const out: { head: string; body: string }[] = [{ head: '', body: '' }];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced;
    if (!fenced && levels.test(line)) out.push({ head: line, body: '' });
    out[out.length - 1]!.body += `${line}\n`;
  }
  return out;
}

interface Tool { name: string; inputSchema: { properties?: Record<string, unknown> } }
let tools: Tool[] = [];
let client: Client;
beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  client = new Client({ name: 'docs-surface', version: '1.0.0' });
  await client.connect(clientSide);
  tools = (await client.listTools()).tools as Tool[];
});
afterAll(async () => {
  await client?.close();
});

describe('docs/mcp-integration.md documents every MCP tool', () => {
  const doc = read('docs/mcp-integration.md');
  const byTool = new Map<string, string>();
  for (const s of sections(doc, /^#{2,4} /)) {
    if (!s.head.startsWith('#### ')) continue;
    for (const m of s.head.matchAll(/`(mapx_[a-z_]+)`/g)) byTool.set(m[1]!, s.body);
  }

  it('has one section per registered tool, and none for a tool the server does not list', () => {
    expect([...byTool.keys()].sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it('names every parameter of each tool in its section, and documents no parameter it does not take', () => {
    const problems: string[] = [];
    for (const t of tools) {
      const section = byTool.get(t.name) ?? '';
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const p of props) if (!section.includes(`\`${p}\``)) problems.push(`${t.name}: ${p} undocumented`);
      // A parameter line: "- `name` (type, …)". Result fields are written without the type.
      for (const m of section.matchAll(/^- `([A-Za-z_]+)` \(/gm)) if (!props.includes(m[1]!)) problems.push(`${t.name}: documents ${m[1]}`);
    }
    expect(problems).toEqual([]);
  });

  it('states the tool count the server has, wherever a count is given', () => {
    const counts: string[] = [];
    for (const f of [...DOCS, 'src/agents.stub.md'])
      for (const m of read(f).matchAll(/\b(\d+)\s+(?:MCP\s+)?tools\b|\((\d+) total\)/g)) {
        if (f === 'docs/framework-integration.md') continue; // "(22 total)" frameworks
        if (Number(m[1] ?? m[2]) !== tools.length) counts.push(`${f}: "${m[0]}"`);
      }
    expect(counts).toEqual([]);
  });
});

describe('docs/cli-reference.md documents every CLI command and flag', () => {
  const doc = read('docs/cli-reference.md');
  const heads = sections(doc, /^#{2,3} /);
  const rows: { path: string; flags: string[] }[] = [];
  const walk = (cmd: Command, prefix: string[]) => {
    for (const sub of cmd.commands as Command[]) {
      if (sub.name() === 'help') continue;
      const path = [...prefix, sub.name()];
      rows.push({ path: path.join(' '), flags: sub.options.map((o) => o.long ?? o.short ?? o.flags) });
      walk(sub, path);
    }
  };
  walk(buildCLI(), []);
  /** The sections whose heading names `mapx <path>`, else the parent command's. */
  const sectionOf = (path: string): string | null => {
    const re = new RegExp(`\`mapx ${esc(path)}(?=[\\s\`<\\[])`);
    const hits = heads.filter((s) => re.test(s.head));
    if (hits.length) return hits.map((s) => s.body).join('\n');
    const parent = path.split(' ').slice(0, -1).join(' ');
    return parent ? sectionOf(parent) : null;
  };

  it('walks the whole program (arch, check, lang, agents and workspaces included)', () => {
    const paths = rows.map((r) => r.path);
    for (const p of ['check', 'arch init', 'arch graph', 'arch validate-config', 'lang info', 'agents generate', 'workspaces discover'])
      expect(paths).toContain(p);
  });

  it('has each command and its flags in the section about it', () => {
    const problems: string[] = [];
    for (const r of rows) {
      const section = sectionOf(r.path);
      if (!section || !doc.includes(`mapx ${r.path}`)) { problems.push(`mapx ${r.path}: no section`); continue; }
      for (const f of r.flags) {
        if (f === '--dir') continue; // the global target directory, documented once
        if (!new RegExp(`${esc(f)}(?![\\w-])`).test(section)) problems.push(`mapx ${r.path}: ${f}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('names no flag that no command takes', () => {
    const known = new Set(rows.flatMap((r) => r.flags));
    for (const f of ['--help', '--version', '--dir']) known.add(f);
    // Other tools' flags quoted in the text, and the `--report-*` family.
    const foreign = new Set(['--init', '--read', '--report-']);
    const unknown = [...new Set(doc.match(/(?<![\w-])--[a-z][a-z0-9-]*/g))]
      .filter((f) => !foreign.has(f) && !known.has(f) && !known.has(f.replace(/^--no-/, '--')) && !known.has(`--no-${f.slice(2)}`));
    expect(unknown).toEqual([]);
  });
});

describe('counts and lists the docs state follow the code', () => {
  it('frameworks: README and docs/framework-integration.md state the detector count', () => {
    const n = FrameworkRegistry.getInstance().getDetectors().length;
    const fw = read('docs/framework-integration.md');
    expect(fw).toContain(`## Supported Frameworks (${n} total)`);
    const rows = fw.slice(fw.indexOf('## Supported Frameworks')).split('\n## ')[0]!.match(/^\| \*\*/gm) ?? [];
    expect(rows).toHaveLength(n);
    for (const f of DOCS) for (const m of read(f).matchAll(/\b(\d+) (?:framework detectors|frameworks)\b/g)) expect(Number(m[1]), `${f}: "${m[0]}"`).toBe(n);
  });

  it('presets: README and docs/architecture-rules.md list every shipped preset', () => {
    const ids = Object.keys(PRESETS).sort();
    for (const f of ['README.md', 'docs/architecture-rules.md', 'docs/cli-reference.md', 'docs/mcp-integration.md']) {
      const text = read(f);
      const missing = ids.filter((id) => !text.includes(`\`${id}\``));
      expect(missing, f).toEqual([]);
    }
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
    for (const f of DOCS) for (const m of read(f).matchAll(/\b(\w+) (?:shipped )?presets\b/g)) {
      const n = words.indexOf(m[1]!.toLowerCase());
      if (n >= 0 || /^\d+$/.test(m[1]!)) expect(n >= 0 ? n : Number(m[1]), `${f}: "${m[0]}"`).toBe(ids.length);
    }
  });

  it('reporters: the check and graph formats are listed in README.md and docs/architecture-rules.md', () => {
    for (const f of ['README.md', 'docs/architecture-rules.md', 'docs/cli-reference.md']) {
      const text = read(f);
      const missing = [...FORMATS, ...GRAPH_FORMATS].filter((format) => !text.includes(`\`${format}\``));
      expect(missing, f).toEqual([]);
    }
  });
});

describe('relative links in README.md and docs/*.md resolve', () => {
  /** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
  const anchors = (path: string): Set<string> => {
    const seen = new Map<string, number>();
    const out = new Set<string>();
    for (const s of sections(read(path), /^#{1,6} /)) {
      if (!s.head) continue;
      const base = s.head.replace(/^#+\s+/, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n ? `${base}-${n}` : base);
    }
    return out;
  };

  it.each(DOCS)('%s', (file) => {
    const broken: string[] = [];
    let text = read(file);
    // Links inside code blocks and code spans are examples.
    text = text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]!;
      if (/^[a-z]+:/i.test(target) || target.startsWith('../../')) continue; // URLs, GitHub-relative pages
      const [path, anchor] = target.split('#') as [string, string | undefined];
      const resolved = path ? join(dirname(file), path) : file;
      if (!existsSync(join(ROOT, resolved))) { broken.push(`${target}: no file`); continue; }
      if (anchor && resolved.endsWith('.md') && !anchors(resolved).has(anchor)) broken.push(`${target}: no heading`);
    }
    expect(broken).toEqual([]);
  });
});
