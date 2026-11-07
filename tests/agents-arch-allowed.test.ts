// M5-24-R3: the agent templates describe what `mapx_arch_allowed` takes as `to`, as its schema does
// since M5-24: a layer, a file, a symbol, a package (`npm:express`, `express`) or a built-in
// (`node:fs`), with one example each. Every template line that names the tool and `to` carries the
// same list, and each example in it is a target the tool resolves, on a synthetic workspace
// (tests/fixtures/agents-arch-allowed) that has one of each. Review of M5-24-R3: a bare package name
// beats a same-named workspace symbol (src/util/express.ts exports `express`), and a package the
// manifest lists but no file imports yet (lodash), or a built-in no file uses (node:path), is
// decided by the selectors and policy, not refused.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { TEMPLATES } from '../src/agents/templates.js';
import { init, mapx, mapxResult } from './helpers/e2e.js';

const TARGETS = 'a layer `Domain`, a file `src/domain/Order.ts`, a symbol `Order::total`, a package `npm:express` or `express`, or a built-in `node:fs`';
const EXAMPLES = [...TARGETS.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** The lines of every instruction template that describe `mapx_arch_allowed`'s `to`. */
function toLines(): Array<[string, string]> {
  return Object.entries(TEMPLATES).filter(([, t]) => !t.isMcpConfig)
    .flatMap(([id, t]) => t.content.split('\n').filter((l) => l.includes('mapx_arch_allowed') && l.includes('`to`')).map((l) => [id, l] as [string, string]));
}

describe('agent templates: the targets mapx_arch_allowed takes (M5-24-R3)', () => {
  it('every line that describes `to` names a layer, file, symbol, package and built-in, with one example each', () => {
    const lines = toLines();
    // The architecture workflow (CLAUDE.md, AGENTS.md, Cursor, Copilot, Antigravity, instructions) and the tool reference.
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const [id, line] of lines) expect([id, line.includes(TARGETS)], line).toEqual([id, true]);
    expect(EXAMPLES).toEqual(['Domain', 'src/domain/Order.ts', 'Order::total', 'npm:express', 'express', 'node:fs']);
  });

  describe('each example is a target the tool resolves', { timeout: 300_000 }, () => {
    let tmp = '';
    let root = '';
    let client: Client;
    beforeAll(async () => {
      tmp = mkdtempSync(join(tmpdir(), 'mapx-agents-allowed-'));
      root = join(tmp, 'app');
      cpSync(resolve(__dirname, 'fixtures/agents-arch-allowed'), root, { recursive: true });
      init(root);
      mapx(root, 'scan');
      mkdirSync(join(root, '.mapx'), { recursive: true });
      writeFileSync(join(root, '.mapx/architecture.jsonc'), JSON.stringify({
        layers: [
          { name: 'Domain', selectors: [{ path: 'src/domain/**' }] },
          { name: 'Web', selectors: [{ path: 'src/web/**' }] },
          { name: 'Util', selectors: [{ path: 'src/util/**' }] },
          { name: 'Packages', selectors: [{ package: '*' }] },
        ],
        rules: { Web: ['Domain', 'Packages'], Domain: [], Util: [] },
      }));
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await buildServer().connect(serverSide);
      client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(clientSide);
    }, 300_000);
    afterAll(async () => {
      await client?.close();
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    // What each example resolves to: the kind the template says it is.
    const KINDS: Record<string, string> = { Domain: 'layer', 'src/domain/Order.ts': 'file', 'Order::total': 'symbol', 'npm:express': 'external', express: 'external', 'node:fs': 'external' };
    for (const to of EXAMPLES) {
      it(`src/web/server.ts → ${to}`, async () => {
        const r = await client.callTool({ name: 'mapx_arch_allowed', arguments: { dir: root, from: 'src/web/server.ts', to } }) as { isError?: boolean; content: Array<{ text: string }> };
        expect(r.isError, r.content[0]!.text).toBeFalsy();
        expect(JSON.parse(r.content[0]!.text)).toMatchObject({ to: { query: to, kind: KINDS[to] }, allowed: true });
      });
    }

    const allowed = async (to: string) => {
      const r = await client.callTool({ name: 'mapx_arch_allowed', arguments: { dir: root, from: 'src/web/server.ts', to } }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError, r.content[0]!.text).toBeFalsy();
      return JSON.parse(r.content[0]!.text);
    };

    it('a bare `express` is the package the manifest lists, not the workspace symbol `express`', async () => {
      expect((await allowed('express')).to).toMatchObject({ kind: 'external', element: 'express', layers: ['Packages'] });
      // The symbol is still named by its file.
      expect(await allowed('src/util/express.ts')).toMatchObject({ to: { kind: 'file', layers: ['Util'] }, allowed: false, rule: 'disallowed-layer' });
      // `mapx arch which` resolves the bare name the same way.
      const which = mapxResult(root, 'arch', 'which', 'express', '--format', 'json');
      expect(which.status, which.stderr).toBe(0);
      expect(JSON.parse(which.stdout).matches.map((m: { element: string; kind: string }) => [m.element, m.kind])).toEqual([['express', 'external']]);
    });

    it('a listed package no file imports yet (lodash, npm:lodash) is decided by the selectors: in Packages, allowed', async () => {
      for (const to of ['lodash', 'npm:lodash']) {
        expect(await allowed(to)).toMatchObject({ to: { kind: 'external', element: 'lodash', layers: ['Packages'] }, allowed: true, rule: 'allowed' });
      }
    });

    it('a built-in no file uses yet (node:path) is decided by the policy: out of scope while uncovered.builtins is false', async () => {
      expect(await allowed('node:path')).toMatchObject({ to: { kind: 'external', element: 'node:path', layers: [] }, allowed: true, rule: 'out-of-scope' });
    });

    it('a package no manifest lists is still unknown: exit 3', async () => {
      const r = await client.callTool({ name: 'mapx_arch_allowed', arguments: { dir: root, from: 'src/web/server.ts', to: 'npm:left-pad' } }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text)).toMatchObject({ exitCode: 3 });
    });
  });
});
