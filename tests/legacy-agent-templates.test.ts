import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, mapx, mapxWithStderr, workspace } from './helpers/e2e.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { supportedLanguageCount } from '../src/languages/registry.js';

const CONTINUE_SERVER = '.continue/mcpServers/mapx.yaml';
const CONTINUE_PROMPTS = ['mapx-impact', 'mapx-callers', 'mapx-context', 'mapx-sync'].map((n) => `.continue/prompts/${n}.md`);
const CONTINUE_FILES = [CONTINUE_SERVER, ...CONTINUE_PROMPTS];

/**
 * Strict parser for the YAML subset these Continue files use: block mappings, block sequences,
 * plain or quoted scalars and comments. Throws on anything else and on duplicate keys.
 */
function parseYaml(text: string): any {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;
  const scalar = (s: string): unknown => {
    if (s.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(s)) throw new Error(`bad quoted scalar: ${s}`);
      return s.slice(1, -1).replaceAll("''", "'");
    }
    if (s.startsWith('"')) return JSON.parse(s);
    if (s === 'true' || s === 'false') return s === 'true';
    if (/:\s|\s#|^[[{&*!|>%@`']/.test(s)) throw new Error(`unsupported plain scalar: ${s}`);
    return s;
  };
  const block = (indent: number): unknown => {
    if (lines[i]!.text.startsWith('- ')) {
      const items: unknown[] = [];
      while (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('- ')) {
        const rest = lines[i]!.text.slice(2);
        if (/^[\w.-]+:(\s|$)/.test(rest)) {
          lines[i] = { indent: indent + 2, text: rest };
          items.push(block(indent + 2));
        } else {
          items.push(scalar(rest));
          i++;
        }
      }
      return items;
    }
    const obj: Record<string, unknown> = {};
    while (i < lines.length && lines[i]!.indent === indent) {
      const m = lines[i]!.text.match(/^([\w.-]+):(?:\s+(.*))?$/);
      if (!m) throw new Error(`not a mapping entry: ${lines[i]!.text}`);
      if (m[1]! in obj) throw new Error(`duplicate key: ${m[1]}`);
      i++;
      if (m[2] !== undefined) obj[m[1]!] = scalar(m[2]);
      else if (i < lines.length && (lines[i]!.indent > indent || lines[i]!.text.startsWith('- '))) obj[m[1]!] = block(lines[i]!.indent);
      else obj[m[1]!] = null;
    }
    return obj;
  };
  const doc = block(0);
  if (i !== lines.length) throw new Error(`unparsed line: ${lines[i]!.text}`);
  return doc;
}

/** The shape of a Continue config or block file, per docs.continue.dev/reference (checked 2026-10-31). */
function continueBlockErrors(doc: any): string[] {
  const errors: string[] = [];
  const TOP = ['name', 'version', 'schema', 'models', 'context', 'rules', 'prompts', 'docs', 'mcpServers', 'data'];
  const SERVER = ['name', 'command', 'args', 'env', 'cwd', 'requestOptions', 'connectionTimeout'];
  for (const k of ['name', 'version', 'schema']) if (typeof doc?.[k] !== 'string' || !doc[k]) errors.push(`missing required ${k}`);
  if (doc?.schema !== 'v1') errors.push('schema is not v1');
  for (const k of Object.keys(doc ?? {})) if (!TOP.includes(k)) errors.push(`unknown top-level key ${k}`);
  if (doc?.mcpServers !== undefined) {
    if (!Array.isArray(doc.mcpServers)) errors.push('mcpServers is not a list');
    for (const s of doc.mcpServers ?? []) {
      for (const k of ['name', 'command']) if (typeof s?.[k] !== 'string' || !s[k]) errors.push(`server missing required ${k}`);
      if (s?.args !== undefined && !(Array.isArray(s.args) && s.args.every((a: unknown) => typeof a === 'string'))) errors.push('args is not a list of strings');
      for (const k of Object.keys(s ?? {})) if (!SERVER.includes(k)) errors.push(`unknown server key ${k}`);
    }
  }
  return errors;
}

/** Front matter of a markdown prompt, which must start at byte 0. */
function frontMatter(md: string): any {
  const m = md.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('no front matter at byte 0');
  return parseYaml(m[1]!);
}

// M0-09-R3: JSONC merges keep string values; Aider's `read:` is never duplicated.
describe('agent config merges', () => {
  const tmp: string[] = [];
  afterAll(() => tmp.forEach(cleanup));
  const run = (root: string, ...args: string[]) => {
    const r = mapxWithStderr(root, ...args);
    return r.stdout + r.stderr;
  };

  it('keeps JSONC string values containing `,]`, `,}` and `key:` and reports dropped comments (AC3)', () => {
    const settings = [
      '// my zed settings',
      '{',
      '  "file_scan_exclusions": ["**/[,]", "a,}", "b, ]"],',
      '  "note": "{ key: v, }",',
      '  /* theme */',
      '  "theme": "One Dark",',
      '}',
      '',
    ].join('\n');
    const root = workspace({ '.zed/settings.json': settings });
    tmp.push(root);
    const out = run(root, 'agents', 'generate', '--providers=zed');
    const merged = JSON.parse(readFileSync(join(root, '.zed/settings.json'), 'utf8'));
    expect(merged.file_scan_exclusions).toEqual(['**/[,]', 'a,}', 'b, ]']);
    expect(merged.note).toBe('{ key: v, }');
    expect(merged.theme).toBe('One Dark');
    expect(merged.context_servers.mapx).toBeDefined();
    expect(out).toMatch(/\.zed\/settings\.json[^\n]*comments/i);
  }, 60000);

  // M0-09-R5: the merge compared the raw JSONC text with plain JSON, so an identical entry was a change.
  it('leaves a JSONC config that already holds the identical mapx entry untouched, comments included (M0-09-R5)', () => {
    const root = workspace({ '.zed/settings.json': '{ "theme": "One Dark" }\n' });
    tmp.push(root);
    run(root, 'agents', 'generate', '--providers=zed');
    run(root, 'agents', 'mcp', '--tools', 'vscode-mcp');
    // The same settings as JSONC: comments and a trailing comma around the mapx entry mapx wrote.
    const jsonc = (f: string) => {
      const plain = readFileSync(join(root, f), 'utf8');
      const text = `// my settings\n${plain.replace(/^\{/, '{\n  /* servers */').replace(/\n\}\s*$/, ', // last\n}\n')}`;
      writeFileSync(join(root, f), text);
      return text;
    };
    const zed = jsonc('.zed/settings.json');
    const vscode = jsonc('.vscode/mcp.json');

    const out = run(root, 'agents', 'generate', '--providers=zed');
    expect(readFileSync(join(root, '.zed/settings.json'), 'utf8')).toBe(zed);
    expect(out).not.toMatch(/settings\.json/);
    const mcpOut = run(root, 'agents', 'mcp', '--tools', 'vscode-mcp');
    expect(readFileSync(join(root, '.vscode/mcp.json'), 'utf8')).toBe(vscode);
    expect(mcpOut).toMatch(/\.vscode\/mcp\.json: Up to date/);
    expect(mcpOut).not.toMatch(/comments/i);
  }, 60000);

  it('does not add a second top-level `read:` key to .aider.conf.yml', () => {
    const conf = 'model: gpt-4o\nread:\n  - CONVENTIONS.md\n';
    const root = workspace({ '.aider.conf.yml': conf });
    tmp.push(root);
    const out = run(root, 'agents', 'generate', '--providers=aider');
    expect(readFileSync(join(root, '.aider.conf.yml'), 'utf8')).toBe(conf);
    expect(out).toMatch(/\.aider\.conf\.yml[^\n]*read/);
    expect(existsSync(join(root, 'AIDER.md'))).toBe(true);
  }, 60000);
});

// M0-09-R2: the F17 template deliverables (SSE stanza, Continue slash commands, Aider config,
// Zed MCP registration).
describe('agent template deliverables', () => {
  let root: string;
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  beforeAll(() => {
    root = workspace({
      'src/a.ts': 'export const a = 1;\n',
      '.zed/settings.json': '// Zed settings\n{\n  "theme": "One Dark",\n  "context_servers": { "other": { "command": "x" } },\n  "tab_size": 2,\n}\n',
    });
    mapx(root, 'agents', 'generate', '--providers=claude,continue,aider,zed', '--mcp-port', '4567');
  }, 60000);
  afterAll(() => cleanup(root));

  it('documents both the stdio and the SSE MCP stanza in CLAUDE.md', () => {
    const md = read('CLAUDE.md');
    expect(md).toMatch(/"command": "npx"[\s\S]*"serve",\s*"--dir"/);
    expect(md).toContain('mapx serve --sse --port 4567');
    expect(md).toContain('"url": "http://localhost:4567/sse"');
  });

  it('states the registry language count in generated files (M0-12-R6)', () => {
    const count = supportedLanguageCount();
    expect(read('CLAUDE.md')).toContain(`across **${count} languages**`);
    expect(read('AIDER.md')).toContain(`across **${count} languages**`);
    expect(read('.zed/mapx-instructions.md')).toContain(`(${count} languages,`);
  });

  it('gives Continue slash commands as invokable prompts (M0-09-R4)', () => {
    const names = CONTINUE_PROMPTS.map((f) => frontMatter(read(f)).name);
    expect(names).toEqual(['mapx-impact', 'mapx-callers', 'mapx-context', 'mapx-sync']);
    expect(read('.continue/prompts/mapx-impact.md')).toContain('mapx impact <symbol>');
  });

  it('documents aider --read and writes .aider.conf.yml', () => {
    expect(read('AIDER.md')).toContain('aider --read AIDER.md');
    expect(read('.aider.conf.yml')).toMatch(/^read:\n {2}- AIDER\.md$/m);
  });

  it('merges the mapx server into .zed/settings.json without losing existing keys', () => {
    const settings = JSON.parse(read('.zed/settings.json'));
    expect(settings.theme).toBe('One Dark');
    expect(settings.tab_size).toBe(2);
    expect(settings.context_servers.other).toEqual({ command: 'x' });
    expect(settings.context_servers.mapx).toMatchObject({ command: 'mapx', args: ['serve', '--dir', root] });
  });

  it('never overwrites an unparseable editor config', () => {
    const other = workspace({ '.zed/settings.json': '{ "theme": "One Dark", oops' });
    try {
      mapx(other, 'agents', 'generate', '--providers=zed');
      expect(readFileSync(join(other, '.zed/settings.json'), 'utf8')).toBe('{ "theme": "One Dark", oops');
      expect(existsSync(join(other, '.zed/mapx-instructions.md'))).toBe(true);
    } finally {
      cleanup(other);
    }
  });

  it('does not offer the Aider config as a provider of its own', () => {
    expect(mapx(root, 'agents', 'list')).not.toContain('aider-conf');
  });
});

// M0-09-R4 (D014, amends F17): Continue's documented layout instead of `.continue/mapx.yaml`.
describe('Continue integration files', () => {
  const tmp: string[] = [];
  afterAll(() => tmp.forEach(cleanup));
  const ws = (files: Record<string, string> = {}) => {
    const r = workspace({ 'src/a.ts': 'export const a = 1;\n', ...files });
    tmp.push(r);
    return r;
  };
  const run = (root: string, ...args: string[]) => {
    const r = mapxWithStderr(root, ...args);
    return r.stdout + r.stderr;
  };
  // What released versions wrote, byte for byte: a hashless sentinel block that Continue never
  // loads. The tool count was 25 in 0.1.9–0.2.7, 26 in 0.3.0–0.3.1 and 32 in 0.3.2–0.3.5.
  const shipped = (version: string, tools: number) =>
    `# mapx v${version}\n# Continue configuration for MapxGraph (22 languages, ${tools} MCP tools)\ncontextProviders:\n  - name: cmd\n    args:\n      name: mapx-export\n      cmd: mapx export --tokens=4000\n  - name: cmd\n    args:\n      name: mapx-status\n      cmd: mapx status\n\n# /mapx\n`;
  const LEGACY = shipped('0.3.5', 32);

  it('writes an MCP server block and invokable prompts in the shape of Continue\'s reference (AC1)', () => {
    // A quote in the project path must survive YAML quoting.
    const dir = join(ws(), "it's here");
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    const out = run(dir, 'agents', 'generate', '--providers=continue');
    const read = (f: string) => readFileSync(join(dir, f), 'utf8');

    const server = parseYaml(read(CONTINUE_SERVER));
    expect(continueBlockErrors(server)).toEqual([]);
    expect(server.mcpServers).toHaveLength(1);
    expect(server.mcpServers[0]).toMatchObject({ name: 'mapx', command: 'mapx', args: ['serve', '--dir', dir] });

    for (const f of CONTINUE_PROMPTS) {
      const fm = frontMatter(read(f));
      expect(fm.invokable, f).toBe(true);
      expect(fm.name, f).toBe(f.slice('.continue/prompts/'.length, -3));
      expect(typeof fm.description, f).toBe('string');
      expect(Object.keys(fm).sort(), f).toEqual(['description', 'invokable', 'name']);
    }
    expect(existsSync(join(dir, '.continue/mapx.yaml'))).toBe(false);
    for (const f of CONTINUE_FILES) expect(out, f).toContain(f);
  }, 60000);

  it('is idempotent, keeps CRLF and needs consent for edited files (AC2)', () => {
    const root = ws();
    const read = (f: string) => readFileSync(join(root, f), 'utf8');
    mapx(root, 'agents', 'generate', '--providers=continue');
    const first = Object.fromEntries(CONTINUE_FILES.map((f) => [f, read(f)]));
    mapx(root, 'agents', 'generate', '--providers=continue');
    for (const f of CONTINUE_FILES) expect(read(f), f).toBe(first[f]);
    // A CRLF checkout is still current and gets no second block.
    for (const f of CONTINUE_FILES) writeFileSync(join(root, f), first[f]!.replace(/\n/g, '\r\n'));
    mapx(root, 'agents', 'generate', '--providers=continue');
    for (const f of CONTINUE_FILES) expect(read(f), f).toBe(first[f]!.replace(/\n/g, '\r\n'));
    const list = mapx(root, 'agents', 'list');
    for (const f of CONTINUE_FILES) expect(list, f).toMatch(new RegExp(`${f.replaceAll('.', '\\.')}[^\\n]*\\[current\\]`));

    // Edits inside a mapx block are kept without --force, in a prompt and in the server block.
    for (const f of CONTINUE_FILES) writeFileSync(join(root, f), first[f]!);
    const prompt = CONTINUE_PROMPTS[0]!;
    writeFileSync(join(root, prompt), read(prompt).replace('<!-- /mapx -->', 'MY EDIT\n<!-- /mapx -->'));
    writeFileSync(join(root, CONTINUE_SERVER), read(CONTINUE_SERVER).replace('# /mapx', '    env:\n      MY_EDIT: x\n# /mapx'));
    mapx(root, 'agents', 'generate', '--providers=continue');
    expect(read(prompt)).toContain('MY EDIT');
    expect(read(CONTINUE_SERVER)).toContain('MY_EDIT');
    expect(mapx(root, 'agents', 'list')).toMatch(/mapx-impact\.md[^\n]*\[edited\]/);
    mapx(root, 'agents', 'generate', '--providers=continue', '--force');
    expect(read(prompt)).toBe(first[prompt]);
    expect(read(CONTINUE_SERVER)).toBe(first[CONTINUE_SERVER]);

    // A user-written prompt file of the same name is never replaced without consent.
    const MINE = '---\nname: mine\ninvokable: true\n---\nMy own prompt.\n';
    writeFileSync(join(root, prompt), MINE);
    mapx(root, 'agents', 'generate', '--providers=continue');
    expect(read(prompt)).toBe(MINE);
  }, 60000);

  it('removes a legacy .continue/mapx.yaml written by mapx, with a message, and leaves a user-written one alone (AC3)', () => {
    const legacy = ws({ '.continue/mapx.yaml': LEGACY });
    const out = run(legacy, 'agents', 'generate', '--providers=continue');
    expect(existsSync(join(legacy, '.continue/mapx.yaml'))).toBe(false);
    expect(out).toMatch(/\.continue\/mapx\.yaml[^\n]*[Rr]emoved|[Rr]emoved[^\n]*\.continue\/mapx\.yaml/);
    for (const f of CONTINUE_FILES) expect(existsSync(join(legacy, f)), f).toBe(true);

    const USER = 'models:\n  - name: my-model\n    provider: ollama\n';
    const user = ws({ '.continue/mapx.yaml': USER });
    run(user, 'agents', 'generate', '--providers=continue');
    expect(readFileSync(join(user, '.continue/mapx.yaml'), 'utf8')).toBe(USER);

    // User text next to the legacy block is kept; only the block goes.
    const mixed = ws({ '.continue/mapx.yaml': `${LEGACY}${USER}` });
    run(mixed, 'agents', 'generate', '--providers=continue');
    expect(readFileSync(join(mixed, '.continue/mapx.yaml'), 'utf8')).toBe(USER);

    // A legacy block edited after mapx hashed it needs consent.
    const edited = ws({ '.continue/mapx.yaml': '# mapx v0.4.0 #000000000000\ncontextProviders: []\n# /mapx\n' });
    run(edited, 'agents', 'generate', '--providers=continue');
    expect(existsSync(join(edited, '.continue/mapx.yaml'))).toBe(true);
    run(edited, 'agents', 'generate', '--providers=continue', '--force');
    expect(existsSync(join(edited, '.continue/mapx.yaml'))).toBe(false);
  }, 60000);

  it.each([['0.2.7', 25], ['0.3.1', 26], ['0.3.5', 32]])('removes the hashless block mapx %s wrote without asking (M0-09-R5)', (version, tools) => {
    const root = ws({ '.continue/mapx.yaml': shipped(version, tools).replace(/\n/g, '\r\n') });
    run(root, 'agents', 'generate', '--providers=continue');
    expect(existsSync(join(root, '.continue/mapx.yaml'))).toBe(false);
  }, 60000);

  // M0-09-R5: a hashless block predates hashes, so only its body tells a hand edit from mapx's own.
  it('keeps an edited hashless legacy block in generate, update and MCP until --force (M0-09-R5)', async () => {
    const EDITED = LEGACY.replace('cmd: mapx status', 'cmd: mapx status --verbose');
    const root = ws({ '.continue/mapx.yaml': EDITED });
    const out = run(root, 'agents', 'generate', '--providers=continue');
    expect(readFileSync(join(root, '.continue/mapx.yaml'), 'utf8')).toBe(EDITED);
    expect(out).toMatch(/Skipped \.continue\/mapx\.yaml/);
    for (const f of CONTINUE_FILES) expect(existsSync(join(root, f)), f).toBe(true);
    mapx(root, 'agents', 'update');
    expect(readFileSync(join(root, '.continue/mapx.yaml'), 'utf8')).toBe(EDITED);

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      const res = (await client.callTool({ name: 'mapx_agents_generate', arguments: { dir: root, providers: ['continue'] } })) as any;
      expect(res.content[0].text).toMatch(/\.continue\/mapx\.yaml: Skipped/);
      expect(readFileSync(join(root, '.continue/mapx.yaml'), 'utf8')).toBe(EDITED);
    } finally {
      await client.close();
    }

    run(root, 'agents', 'generate', '--providers=continue', '--force');
    expect(existsSync(join(root, '.continue/mapx.yaml'))).toBe(false);
  }, 60000);

  it('agents update migrates a legacy-only project; list and uninit cover the new files (AC3, AC4)', () => {
    const root = ws({ '.continue/mapx.yaml': LEGACY });
    expect(mapx(root, 'agents', 'list')).toMatch(/\.continue\/mapx\.yaml[^\n]*legacy/);
    mapx(root, 'agents', 'update');
    expect(existsSync(join(root, '.continue/mapx.yaml'))).toBe(false);
    for (const f of CONTINUE_FILES) expect(existsSync(join(root, f)), f).toBe(true);
    const list = mapx(root, 'agents', 'list');
    expect(list).toMatch(/continue\s+-> \.continue\/mcpServers\/mapx\.yaml/);
    expect(list).not.toMatch(/\.continue\/mapx\.yaml/);
    // uninit removes every generated Continue file; prompts are not left as bare front matter.
    mapx(root, 'uninit', root, '--force');
    expect(existsSync(join(root, '.continue'))).toBe(false);
  }, 60000);

  it('mapx_agents_generate names the new files and the legacy removal (AC4)', async () => {
    const root = ws({ '.continue/mapx.yaml': LEGACY });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      const res = (await client.callTool({ name: 'mapx_agents_generate', arguments: { dir: root, providers: ['continue'] } })) as any;
      const text = res.content[0].text as string;
      for (const f of CONTINUE_FILES) expect(text, f).toContain(f);
      expect(text).toMatch(/\.continue\/mapx\.yaml: Removed/);
      expect(existsSync(join(root, '.continue/mapx.yaml'))).toBe(false);
    } finally {
      await client.close();
    }
  }, 60000);
});
