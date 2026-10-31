import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
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
    expect(read('CLAUDE.md')).toMatch(/<!-- \/mapx -->\nkeep-after\n$/);
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
