import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { TEMPLATES } from '../src/agents/templates.js';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';

// I22 / M0-22-R1: the F38 usability deliverables, exercised through a real MCP client and store.
const many = Array.from({ length: 25 }, (_, i) => `export function fn${i}() { return ${i}; }`).join('\n');

describe('MCP usability (F38)', () => {
  let root: string;
  let client: Client;
  beforeAll(async () => {
    root = workspace({
      'src/many.ts': many,
      'src/models.ts': 'export class User {}\nexport class Order {}\nexport function helper() {}\n',
    });
    init(root);
    mapx(root, 'scan', root);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
  }, 60000);
  afterAll(async () => {
    await client?.close();
    cleanup(root);
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: { dir: root, ...args } })) as any;
    return res.content.map((c: any) => c.text).join('\n') as string;
  };
  const names = (text: string) => [...new Set(text.match(/\bfn\d+\b/g) ?? [])];

  it('wildcard term with a file filter lists every symbol in the file', async () => {
    const text = await call('mapx_search', { term: '*', file: 'src/many.ts' });
    expect(names(text)).toHaveLength(25);
  });

  it('says when results are truncated, with the real total', async () => {
    const text = await call('mapx_search', { term: 'fn' });
    expect(text).toContain('Found 20 of 25 symbols');
  });

  it('empty term behaves like the wildcard', async () => {
    const text = await call('mapx_search', { term: '', file: 'src/models.ts' });
    expect(text).toContain('User');
    expect(text).toContain('Order');
    expect(text).toContain('helper');
  });

  it('matches kind case-insensitively', async () => {
    const upper = await call('mapx_search', { term: '*', kind: 'CLASS', file: 'src/models.ts' });
    const lower = await call('mapx_search', { term: '*', kind: 'class', file: 'src/models.ts' });
    expect(upper).toContain('User');
    expect(upper).not.toContain('helper');
    const body = (t: string) => t.slice(t.indexOf(':\n'));
    expect(body(upper)).toBe(body(lower));
  });

  it('mapx_context rejects a call without task, naming the parameter', async () => {
    expect(await call('mapx_context', {})).toBe('Missing required parameter: task');
  });

  it('ships an MCP instructions guide through the agents templates', () => {
    const guide = (TEMPLATES as any).instructions;
    expect(guide.filename).toBe('.agents/rules/instructions.md');
    expect(guide.content).toContain('mapx_search');
    expect(guide.content).toContain('mapx_context');
  });
});

describe('MCP server identity (M0-07-R3)', () => {
  it('reports the package version in its initialize response, as mapx --version does', async () => {
    const { VERSION } = await import('../src/version.js');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      expect(client.getServerVersion()).toEqual({ name: 'mapx', version: VERSION });
      expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await client.close();
    }
  });
});
