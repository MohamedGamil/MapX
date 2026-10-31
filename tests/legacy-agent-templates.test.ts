import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, mapx, mapxWithStderr, workspace } from './helpers/e2e.js';

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

  it('gives Continue slash commands', () => {
    const yaml = read('.continue/mapx.yaml');
    expect(yaml).toMatch(/^slashCommands:$/m);
    const commands = yaml.slice(yaml.indexOf('slashCommands:')).match(/^ {2}- name: (\S+)$/gm)!.map((l) => l.split(': ')[1]);
    expect(commands).toEqual(['mapx-impact', 'mapx-callers', 'mapx-context', 'mapx-sync']);
    expect(yaml).toContain('mapx impact {{{ input }}}');
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
