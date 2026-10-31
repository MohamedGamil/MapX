import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, mapx, workspace } from './helpers/e2e.js';

// M0-09-R1: agent integration file defects.
describe('agent integration files', () => {
  let root: string;
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  beforeAll(() => {
    root = workspace({ 'src/a.ts': 'export const a = 1;\n' });
    mapx(root, 'agents', 'generate', '--providers=all');
  }, 60000);
  afterAll(() => cleanup(root));

  it('accepts --providers=all and writes every provider file', () => {
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'AIDER.md', '.clinerules', '.cursor/rules/mapx.mdc', '.windsurf/rules/mapx.md', '.github/copilot-instructions.md', '.continue/mapx.yaml', '.zed/mapx-instructions.md'])
      expect(read(f).length, f).toBeGreaterThan(0);
  });

  it('keeps frontmatter at byte 0 for Cursor and Windsurf rules, also after updates', () => {
    for (const f of ['.cursor/rules/mapx.mdc', '.windsurf/rules/mapx.md']) {
      expect(read(f).startsWith('---\n'), f).toBe(true);
      expect(read(f).split('\n---\n').length, `${f}: one frontmatter`).toBe(2);
    }
    // An outdated block is refreshed without duplicating the frontmatter.
    const f = '.cursor/rules/mapx.mdc';
    writeFileSync(join(root, f), read(f).replace(/mapx v[\d.]+/, 'mapx v0.0.1'));
    mapx(root, 'agents', 'update');
    expect(read(f).startsWith('---\n')).toBe(true);
    expect(read(f).match(/^---$/gm)).toHaveLength(2);
    expect(read(f)).not.toContain('v0.0.1');
  });

  it('keeps text after the block on its own line when updating', () => {
    writeFileSync(join(root, 'CLAUDE.md'), read('CLAUDE.md').replace(/mapx v[\d.]+/, 'mapx v0.0.1') + '\nkeep-after\n');
    mapx(root, 'agents', 'update');
    // The generated file ends with a newline (M0-09-R3), so the leading '\n' above is a blank line, kept as is.
    expect(read('CLAUDE.md')).toMatch(/<!-- \/mapx -->\n\nkeep-after\n$/);
  });

  it('does not overwrite an edited block without a TTY unless --force', () => {
    writeFileSync(join(root, 'AIDER.md'), read('AIDER.md').replace('<!-- /mapx -->', 'MY EDIT\n<!-- /mapx -->'));
    mapx(root, 'agents', 'update');
    expect(read('AIDER.md')).toContain('MY EDIT');
    mapx(root, 'agents', 'update', '--force');
    expect(read('AIDER.md')).not.toContain('MY EDIT');
  });

  it('treats a block that is both edited and outdated as edited, not as a clean update', () => {
    mapx(root, 'agents', 'update', '--force');
    const edited = read('AIDER.md').replace('<!-- /mapx -->', 'MY EDIT\n<!-- /mapx -->').replace(/mapx v[\d.]+/, 'mapx v0.0.1');
    writeFileSync(join(root, 'AIDER.md'), edited);
    mapx(root, 'agents', 'update');
    expect(read('AIDER.md')).toContain('MY EDIT');
  });

  it('reports per-file status in agents list', () => {
    writeFileSync(join(root, 'GEMINI.md'), read('GEMINI.md').replace(/mapx v[\d.]+/, 'mapx v0.0.1'));
    writeFileSync(join(root, 'AIDER.md'), read('AIDER.md').replace('<!-- /mapx -->', 'MY EDIT\n<!-- /mapx -->'));
    const out = mapx(root, 'agents', 'list');
    expect(out).toMatch(/claude\s+-> CLAUDE\.md\s+\[current\]/);
    expect(out).toMatch(/gemini\s+-> GEMINI\.md\s+\[outdated\]/);
    expect(out).toMatch(/aider\s+-> AIDER\.md\s+\[edited\]/);
  });
});

// Review 2026-10-31 (post-acceptance defect): init, agents update and the MCP tool replaced
// user-written files that have no mapx block.
describe('user-written agent files are never replaced without consent', () => {
  const USER_AGENTS = '# Team agent rules\nAlways run make lint.\n';
  const USER_CLAUDE = '# My claude notes\nKeep me.\n';
  let root: string;
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  beforeAll(() => {
    root = workspace({ 'src/a.ts': 'export const a = 1;\n', 'AGENTS.md': USER_AGENTS, 'CLAUDE.md': USER_CLAUDE });
  });
  afterAll(() => cleanup(root));

  it('mapx init keeps an AGENTS.md without a mapx block', () => {
    mapx(root, 'init', root, '--no-suggestions', '--no-mcp-configs', '--no-discover', '--no-workspaces');
    expect(read('AGENTS.md')).toBe(USER_AGENTS);
  });

  it('agents update keeps a CLAUDE.md without a mapx block unless --force', () => {
    mapx(root, 'agents', 'update');
    expect(read('CLAUDE.md')).toBe(USER_CLAUDE);
  });

  it('mapx_agents_generate skips user-written and edited files unless force is passed', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      const call = async (args: Record<string, unknown>) =>
        ((await client.callTool({ name: 'mapx_agents_generate', arguments: { dir: root, ...args } })) as any).content[0].text as string;
      expect(await call({ providers: ['claude'] })).toMatch(/CLAUDE\.md: Skipped/);
      expect(read('CLAUDE.md')).toBe(USER_CLAUDE);
      // providers: ['all'] is accepted like the CLI's --providers=all.
      expect(await call({ providers: ['all'] })).not.toContain('No valid providers');
      expect(read('AGENTS.md')).toBe(USER_AGENTS);
      await call({ providers: ['claude'], force: true });
      expect(read('CLAUDE.md')).toContain('<!-- mapx v');
    } finally {
      await client.close();
    }
  }, 60000);
});

// M0-09-R3: line endings, final newlines, legacy and duplicate blocks, update scope.
describe('agent files: line endings, legacy blocks and update scope', () => {
  const SENTINEL_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'AIDER.md', '.aider.conf.yml', '.clinerules', '.cursor/rules/mapx.mdc', '.windsurf/rules/mapx.md', '.github/copilot-instructions.md', '.continue/mapx.yaml', '.zed/mapx-instructions.md', '.agents/rules/mapx.md', '.agents/rules/instructions.md'];
  const OPEN = /^(?:<!--|#) mapx v[\d.]+(?: #[0-9a-f]+)?(?: -->)?\r?$/gm;
  const blocks = (s: string) => (s.match(OPEN) ?? []).length;
  const tmp: string[] = [];
  const ws = (files: Record<string, string> = {}) => {
    const r = workspace({ 'src/a.ts': 'export const a = 1;\n', ...files });
    tmp.push(r);
    return r;
  };
  afterAll(() => tmp.forEach(cleanup));

  it('generating twice on CRLF files yields one block per file, keeps CRLF and lists every provider as current (AC1)', () => {
    const root = ws({ '.clinerules': 'user rule one\r\nuser rule two\r\n', '.github/copilot-instructions.md': '# Team\r\nBe nice.\r\n' });
    const read = (f: string) => readFileSync(join(root, f), 'utf8');
    mapx(root, 'agents', 'generate', '--providers=all');
    // A user CRLF file gets a CRLF block: no bare LF.
    for (const f of ['.clinerules', '.github/copilot-instructions.md']) expect(read(f), f).not.toMatch(/[^\r]\n/);
    // Simulate a checkout with core.autocrlf: every agent file becomes CRLF.
    for (const f of SENTINEL_FILES) writeFileSync(join(root, f), read(f).replace(/\r?\n/g, '\r\n'));
    const before = Object.fromEntries(SENTINEL_FILES.map((f) => [f, read(f)]));
    mapx(root, 'agents', 'generate', '--providers=all');
    for (const f of SENTINEL_FILES) {
      expect(blocks(read(f)), f).toBe(1);
      expect(read(f), f).toBe(before[f]);
    }
    const list = mapx(root, 'agents', 'list').split('\n').filter((l) => l.includes(' -> '));
    expect(list.length).toBeGreaterThan(5);
    expect(list.filter((l) => !l.includes('[current]'))).toEqual([]);
  }, 60000);

  it('refreshes an outdated block in a CRLF file in place, keeping CRLF', () => {
    const root = ws();
    const read = (f: string) => readFileSync(join(root, f), 'utf8');
    mapx(root, 'agents', 'generate', '--providers=cline');
    writeFileSync(join(root, '.clinerules'), read('.clinerules').replace(/mapx v[\d.]+/, 'mapx v0.0.1').replace(/\r?\n/g, '\r\n'));
    mapx(root, 'agents', 'update');
    expect(blocks(read('.clinerules'))).toBe(1);
    expect(read('.clinerules')).not.toContain('v0.0.1');
    expect(read('.clinerules')).not.toMatch(/[^\r]\n/);
  }, 60000);

  it('ends every generated file with a newline; appended text stays on its own line after update (AC2)', () => {
    const root = ws();
    const read = (f: string) => readFileSync(join(root, f), 'utf8');
    mapx(root, 'agents', 'generate', '--providers=all');
    for (const f of SENTINEL_FILES) expect(read(f).endsWith('\n'), f).toBe(true);
    appendFileSync(join(root, 'CLAUDE.md'), 'appended-line\n');
    appendFileSync(join(root, '.clinerules'), 'appended-rule\n');
    for (const f of ['CLAUDE.md', '.clinerules']) writeFileSync(join(root, f), read(f).replace(/mapx v[\d.]+/, 'mapx v0.0.1'));
    mapx(root, 'agents', 'update');
    expect(read('CLAUDE.md')).toMatch(/\n<!-- \/mapx -->\nappended-line\n$/);
    expect(read('.clinerules')).toMatch(/\n# \/mapx\nappended-rule\n$/);
    expect(read('CLAUDE.md')).not.toContain('v0.0.1');
  }, 60000);

  it('agents update only touches files that exist (AC4)', () => {
    const root = ws();
    const read = (f: string) => readFileSync(join(root, f), 'utf8');
    mapx(root, 'agents', 'generate', '--providers=claude,aider');
    rmSync(join(root, '.agents/rules/instructions.md'));
    rmSync(join(root, '.aider.conf.yml'));
    writeFileSync(join(root, 'CLAUDE.md'), read('CLAUDE.md').replace(/mapx v[\d.]+/, 'mapx v0.0.1'));
    mapx(root, 'agents', 'update');
    expect(read('CLAUDE.md')).not.toContain('v0.0.1');
    expect(existsSync(join(root, '.agents/rules/instructions.md'))).toBe(false);
    expect(existsSync(join(root, '.aider.conf.yml'))).toBe(false);
    expect(existsSync(join(root, 'GEMINI.md'))).toBe(false);
  }, 60000);

  it('treats an edited hashless legacy block as edited whatever its version; a clean one is refreshed', () => {
    const root = ws();
    const read = (f: string) => readFileSync(join(root, f), 'utf8');
    mapx(root, 'agents', 'generate', '--providers=claude,gemini');
    writeFileSync(join(root, 'CLAUDE.md'), '<!-- mapx v0.0.1 -->\nMY LEGACY EDIT\n<!-- /mapx -->\n');
    // An unedited hashless legacy block: the current body, no hash, an old version.
    writeFileSync(join(root, 'GEMINI.md'), read('GEMINI.md').replace(/<!-- mapx v[\d.]+ #[0-9a-f]+ -->/, '<!-- mapx v0.0.1 -->'));
    expect(mapx(root, 'agents', 'list')).toMatch(/claude\s+-> CLAUDE\.md\s+\[edited\]/);
    mapx(root, 'agents', 'update');
    expect(read('CLAUDE.md')).toContain('MY LEGACY EDIT');
    expect(read('GEMINI.md')).toMatch(/<!-- mapx v[\d.]+ #[0-9a-f]{12} -->/);
    expect(read('GEMINI.md')).not.toContain('v0.0.1');
    mapx(root, 'agents', 'update', '--force');
    expect(read('CLAUDE.md')).not.toContain('MY LEGACY EDIT');
  }, 60000);

  it('removes a second stale block when updating, and keeps text between them', () => {
    const root = ws();
    const read = (f: string) => readFileSync(join(root, f), 'utf8');
    mapx(root, 'agents', 'generate', '--providers=gemini');
    const old = read('GEMINI.md').replace(/mapx v[\d.]+/, 'mapx v0.0.1');
    writeFileSync(join(root, 'GEMINI.md'), `${old}\nmiddle-text\n${old}`);
    mapx(root, 'agents', 'update');
    expect(blocks(read('GEMINI.md'))).toBe(1);
    expect(read('GEMINI.md')).toContain('middle-text');
    expect(read('GEMINI.md')).not.toContain('v0.0.1');
    // An edited duplicate block is a customisation: it needs consent.
    const cur = read('GEMINI.md').replace('middle-text\n', '');
    writeFileSync(join(root, 'GEMINI.md'), `${cur}\n${cur.replace('<!-- /mapx -->', 'DUP EDIT\n<!-- /mapx -->')}`);
    mapx(root, 'agents', 'update');
    expect(read('GEMINI.md')).toContain('DUP EDIT');
  }, 60000);
});
