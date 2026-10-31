import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getBuiltinLanguages, getLanguageForFile, languageFromShebang, supportedLanguageCount } from '../src/languages/registry.js';
import { buildServer } from '../src/mcp.js';
import { TEMPLATES } from '../src/agents/templates.js';
import { cleanup, init, mapx, mapxEnv, query, workspace } from './helpers/e2e.js';

// Preload fixture that makes named grammar files look missing (M0-12-R6).
const HIDE_GRAMMAR = pathToFileURL(join(__dirname, 'fixtures/languages/hide-grammar.mjs')).href;

// M0-12-R2 (D010): all grammars bundled, lang info, install/uninstall no-ops, shebang detection.
describe('language CLI', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({ 'a.ts': 'export const a = 1;\n' });
    init(root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('lists every grammar, tsx included, as bundled', () => {
    const out = mapx(root, 'lang', 'list');
    expect(out).toMatch(/- tsx \(.*status: bundled\)/);
    expect(out).not.toMatch(/Not Installed|unavailable/);
  });

  it('describes a language with its grammar file', () => {
    const out = mapx(root, 'lang', 'info', 'bash');
    expect(out).toContain('.sh, .bash, .zsh');
    expect(out).toMatch(/Grammar:\s+\S+tree-sitter-bash\.wasm/);
    expect(out).not.toContain('missing!');
  });

  it('treats install and uninstall as informative no-ops', () => {
    expect(mapx(root, 'lang', 'install', 'bash')).toContain('nothing to install');
    expect(mapx(root, 'lang', 'uninstall', 'bash')).toContain('cannot be uninstalled');
    expect(() => mapx(root, 'lang', 'install', 'klingon')).toThrow();
  });
});

describe('shebang detection and extensions', () => {
  it('maps interpreters to languages', () => {
    expect(languageFromShebang('#!/bin/bash -e')?.name).toBe('bash');
    expect(languageFromShebang('#!/usr/bin/env python3')?.name).toBe('python');
    expect(languageFromShebang('#!/usr/bin/env -S node --no-warnings')?.name).toBe('javascript');
    expect(languageFromShebang('#!/usr/bin/env ruby')?.name).toBe('ruby');
    expect(languageFromShebang('echo hi')).toBeNull();
  });

  it('recognises the F20 extension list additions', () => {
    for (const [file, lang] of [['a.pyw', 'python'], ['Rakefile.rake', 'ruby'], ['x.gemspec', 'ruby'], ['a.zsh', 'bash'], ['a.luau', 'lua'], ['a.dpr', 'pascal'], ['a.lpr', 'pascal'], ['a.h++', 'cpp']])
      expect(getLanguageForFile(file)?.name, file).toBe(lang);
  });

  let root: string;
  beforeAll(() => {
    root = workspace({
      'bin/deploy': '#!/bin/bash\ngreet() { echo hi; }\ngreet\n',
      'bin/tool': '#!/usr/bin/env python3\ndef main():\n    return 1\n',
      'bin/notes': 'just text, no shebang\n',
    });
    for (const f of ['bin/deploy', 'bin/tool']) chmodSync(join(root, f), 0o755);
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('indexes extensionless scripts by their shebang', () => {
    const files = query<{ path: string; language: string }>(root, 'SELECT path, language FROM files ORDER BY path');
    expect(files).toEqual([{ path: 'bin/deploy', language: 'bash' }, { path: 'bin/tool', language: 'python' }]);
    const symbols = query<{ name: string }>(root, 'SELECT name FROM symbols ORDER BY name').map((s) => s.name);
    expect(symbols).toEqual(expect.arrayContaining(['greet', 'main']));
  });
});

// Review 2026-10-31 (post-acceptance defect): sync ignored extensionless shebang scripts.
describe('sync and shebang scripts', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({ 'bin/deploy': '#!/bin/bash\ngreet() { echo hi; }\n' }, ['.']);
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('indexes new and changed extensionless scripts', () => {
    writeFileSync(join(root, 'bin/deploy'), '#!/bin/bash\ngreet() { echo hi; }\nbye() { echo bye; }\n');
    writeFileSync(join(root, 'bin/newrb'), '#!/usr/bin/env ruby\nclass NewThing\nend\n');
    mapx(root, 'sync', root);
    const symbols = query<{ name: string }>(root, 'SELECT name FROM symbols').map((s) => s.name);
    expect(symbols).toEqual(expect.arrayContaining(['greet', 'bye', 'NewThing']));
  });
});

// M0-12-R3: shebang scripts take part in reference resolution; F20 file names; worker path; MCP/CLI parity.
describe('shebang scripts in the graph, F20 file names (M0-12-R3)', () => {
  it('maps ts-node/tsx to typescript and fish to fish; Rakefile, Gemfile and .fish have a language', () => {
    expect(languageFromShebang('#!/usr/bin/env ts-node')?.name).toBe('typescript');
    expect(languageFromShebang('#!/usr/bin/env -S tsx --watch')?.name).toBe('typescript');
    expect(languageFromShebang('#!/usr/bin/env node')?.name).toBe('javascript');
    expect(languageFromShebang('#!/usr/bin/fish')?.name).toBe('fish');
    for (const [file, lang] of [['Rakefile', 'ruby'], ['Gemfile', 'ruby'], ['tools/Rakefile', 'ruby'], ['conf.d/env.fish', 'fish']])
      expect(getLanguageForFile(file)?.name, file).toBe(lang);
    expect(getLanguageForFile('MyRakefile')).toBeNull();
  });

  // More than 10 files to parse, so the scan goes through the worker pool (scanner.parseFilesParallel).
  let root: string;
  beforeAll(() => {
    const files: Record<string, string> = {
      'bin/tool': '#!/usr/bin/env python3\ndef helper():\n    return 1\n\ndef main():\n    return helper() + shared_util()\n',
      'bin/ops': '#!/usr/bin/env python3\ndef ops_entry():\n    return 2\n',
      'lib/util.py': 'def shared_util():\n    return 2\n',
      'app.py': 'def run():\n    return ops_entry()\n',
      Rakefile: "class BuildTasks\n  def build; end\nend\ntask :default do\nend\n",
      Gemfile: "source 'https://rubygems.org'\ngem 'rake'\n",
      'config/fish/config.fish': 'function greet\n  echo hi\nend\n',
    };
    for (let i = 0; i < 12; i++) files[`pad/m${i}.py`] = `def pad_${i}():\n    return ${i}\n`;
    root = workspace(files);
    for (const f of ['bin/tool', 'bin/ops']) chmodSync(join(root, f), 0o755);
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  const calls = (source: string) =>
    query<{ source_symbol: string; target_symbol: string; target_file: string }>(
      root, "SELECT source_symbol, target_symbol, target_file FROM edges WHERE source_file = ? AND edge_type = 'call' ORDER BY target_symbol", source);

  it('a python shebang script gets its call edges, in the same file and across files', () => {
    expect(calls('bin/tool')).toEqual([
      { source_symbol: 'main', target_symbol: 'helper', target_file: 'bin/tool' },
      { source_symbol: 'main', target_symbol: 'shared_util', target_file: 'lib/util.py' },
    ]);
  });

  it('a shebang script is a call target too', () => {
    expect(calls('app.py')).toEqual([{ source_symbol: 'run', target_symbol: 'ops_entry', target_file: 'bin/ops' }]);
  });

  it('indexes Rakefile and Gemfile as Ruby and .fish files (with their functions, M0-12-R5), through the workers', () => {
    const files = query<{ path: string; language: string }>(root, "SELECT path, language FROM files WHERE path NOT LIKE 'pad/%' ORDER BY path");
    expect(files).toEqual([
      { path: 'Gemfile', language: 'ruby' },
      { path: 'Rakefile', language: 'ruby' },
      { path: 'app.py', language: 'python' },
      { path: 'bin/ops', language: 'python' },
      { path: 'bin/tool', language: 'python' },
      { path: 'config/fish/config.fish', language: 'fish' },
      { path: 'lib/util.py', language: 'python' },
    ]);
    const symbols = (file: string) => query<{ name: string }>(root, 'SELECT name FROM symbols WHERE file_path = ? ORDER BY name', file).map((s) => s.name);
    expect(symbols('Rakefile')).toEqual(expect.arrayContaining(['BuildTasks', 'build']));
    expect(symbols('bin/tool')).toEqual(['helper', 'main']);
    expect(symbols('config/fish/config.fish')).toEqual(['greet']);
  });
});

// M0-12-R5 (D014): a bundled fish grammar gives .fish files function symbols and call edges.
// Fewer than 10 files, so this scan parses on the main thread; the fixture above covers the workers.
describe('fish functions and calls (M0-12-R5)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'functions/deploy.fish': 'function deploy; build; end\n',
      'functions/build.fish': "function build --description 'compile everything'\n    compile (count $argv)\n    echo built\nend\n\nfunction compile\n    set -l n $argv[1]\nend\n",
      'bin/release': '#!/usr/bin/env fish\nfunction release\n    deploy\nend\n',
      'conf.d/env.fish': 'source ../functions/deploy.fish\n',
      // Same-named functions in other languages must not capture fish calls.
      'tools/build.py': 'def build():\n    return 1\n',
      'scripts/build.sh': 'build() { echo bash; }\n',
    });
    chmodSync(join(root, 'bin/release'), 0o755);
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  const calls = (source: string) =>
    query<{ source_symbol: string; target_symbol: string; target_file: string }>(
      root, "SELECT source_symbol, target_symbol, target_file FROM edges WHERE source_file = ? AND edge_type = 'call' ORDER BY target_symbol", source);

  it('reports the fish grammar in lang list and lang info', () => {
    expect(mapx(root, 'lang', 'list')).toMatch(/- fish \(\.fish \| tier: bundled \| status: bundled\)/);
    const info = mapx(root, 'lang', 'info', 'fish');
    expect(info).toMatch(/Grammar:\s+\S+tree-sitter-fish\.wasm\n/);
    expect(info).toMatch(/Queries:\s+\S+queries\/fish\/symbols\.scm, \S+queries\/fish\/references\.scm/);
  });

  it('extracts fish functions as function symbols', () => {
    const symbols = query<{ file_path: string; kind: string; name: string }>(
      root, "SELECT file_path, kind, name FROM symbols WHERE file_path LIKE '%.fish' OR file_path = 'bin/release' ORDER BY file_path, name");
    expect(symbols).toEqual([
      { file_path: 'bin/release', kind: 'function', name: 'release' },
      { file_path: 'functions/build.fish', kind: 'function', name: 'build' },
      { file_path: 'functions/build.fish', kind: 'function', name: 'compile' },
      { file_path: 'functions/deploy.fish', kind: 'function', name: 'deploy' },
    ]);
  });

  it('links fish calls to fish functions, in the same file and across files', () => {
    expect(calls('functions/deploy.fish')).toEqual([{ source_symbol: 'deploy', target_symbol: 'build', target_file: 'functions/build.fish' }]);
    expect(calls('functions/build.fish')).toEqual([{ source_symbol: 'build', target_symbol: 'compile', target_file: 'functions/build.fish' }]);
    expect(calls('bin/release')).toEqual([{ source_symbol: 'release', target_symbol: 'deploy', target_file: 'functions/deploy.fish' }]);
  });

  it('resolves `source FILE` relative to the sourcing file', () => {
    expect(query(root, "SELECT target_file FROM edges WHERE source_file = 'conf.d/env.fish' AND edge_type = 'import'"))
      .toEqual([{ target_file: 'functions/deploy.fish' }]);
  });
});

// D010 parity: mapx_lang_list / mapx_lang_info return the CLI's text; unknown languages are tool errors.
describe('language tools: MCP and CLI agree (M0-12-R3)', () => {
  let root: string;
  let client: Client;
  beforeAll(async () => {
    root = workspace({ 'a.ts': 'export const a = 1;\n' });
    init(root);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
  }, 60000);
  afterAll(async () => {
    await client.close();
    cleanup(root);
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
  };

  it('mapx_lang_list matches `mapx lang list`, says bundled, never Installed', async () => {
    const { text, isError } = await call('mapx_lang_list');
    expect(isError).toBe(false);
    expect(text).toBe(mapx(root, 'lang', 'list').trimEnd());
    expect(text).toMatch(/- ruby \(\.rb, \.rake, \.gemspec, Rakefile, Gemfile \| tier: bundled \| status: bundled\)/);
    expect(text).toMatch(/- fish \(\.fish \| tier: bundled \| status: bundled\)/);
    expect(text).not.toMatch(/Installed/);
  });

  it('mapx_lang_info matches `mapx lang info`', async () => {
    const { text, isError } = await call('mapx_lang_info', { lang: 'ruby' });
    expect(isError).toBe(false);
    expect(text).toBe(mapx(root, 'lang', 'info', 'ruby').trimEnd());
    expect(text).toContain('File names: Rakefile, Gemfile');
  });

  it('unknown or missing languages are errors in both', async () => {
    for (const tool of ['mapx_lang_info', 'mapx_lang_install', 'mapx_lang_uninstall']) {
      const unknown = await call(tool, { lang: 'klingon' });
      expect(unknown.isError, tool).toBe(true);
      expect(unknown.text, tool).toContain("Unknown language 'klingon'");
      expect((await call(tool, {})).isError, tool).toBe(true);
    }
    expect(() => mapx(root, 'lang', 'info', 'klingon')).toThrow();
    expect((await call('mapx_lang_install', { lang: 'ruby' })).isError).toBe(false);
  });

  // M0-12-R6: a missing WASM file was still listed as bundled.
  it('reports a grammar whose WASM file is missing as missing, in both', async () => {
    const cli = mapxEnv(root, { MAPX_TEST_HIDE_GRAMMAR: 'tree-sitter-fish.wasm', NODE_OPTIONS: `--import=${HIDE_GRAMMAR}` }, 'lang', 'list');
    expect(cli).toMatch(/- fish \(\.fish \| tier: bundled \| status: missing\)/);
    expect(cli).toMatch(/- bash \(.* \| status: bundled\)/);
    expect(cli.split('\n')[0]).toBe('Supported languages (1 grammar file is missing; reinstall MapX):');

    const { hideGrammars } = (await import(HIDE_GRAMMAR)) as { hideGrammars: (names: string[]) => () => void };
    const restore = hideGrammars(['tree-sitter-fish.wasm']);
    try {
      const { text, isError } = await call('mapx_lang_list');
      expect(isError).toBe(false);
      expect(text).toBe(cli.trimEnd());
    } finally {
      restore();
    }
    expect((await call('mapx_lang_list')).text).toMatch(/- fish \(\.fish \| tier: bundled \| status: bundled\)/);
  });
});

// No doc or generated agent template tells users to install a language (D010).
describe('docs and templates follow D010 (M0-12-R3)', () => {
  const repo = join(__dirname, '..');
  const sources: Record<string, string> = {
    'README.md': readFileSync(join(repo, 'README.md'), 'utf8'),
    'docs/mcp-integration.md': readFileSync(join(repo, 'docs/mcp-integration.md'), 'utf8'),
    'docs/cli-reference.md': readFileSync(join(repo, 'docs/cli-reference.md'), 'utf8'),
    'src/agents.stub.md': readFileSync(join(repo, 'src/agents.stub.md'), 'utf8'),
  };
  for (const [key, t] of Object.entries(TEMPLATES)) sources[`template:${key}`] = t.content;

  it.each(Object.keys(sources))('%s does not describe installing a language', (key) => {
    const text = sources[key]!;
    expect(text).not.toMatch(/\b(?:un)?install(?:s|ing|ation)?\b[^.,|\n]{0,40}\b(?:language|grammar)/i);
    expect(text).not.toMatch(/\b(?:language|grammar)s?\s+(?:un)?install/i);
  });

  it('documents mapx_lang_info wherever the language tools are listed', () => {
    for (const [key, text] of Object.entries(sources)) if (text.includes('mapx_lang_list')) expect(text, key).toContain('mapx_lang_info');
  });
});

// M0-12-R6: language counts in docs and templates follow the registry (23 after fish, M0-12-R5).
describe('language counts match the registry (M0-12-R6)', () => {
  const repo = join(__dirname, '..');
  const count = supportedLanguageCount();
  const sources: Record<string, string> = {
    'README.md': readFileSync(join(repo, 'README.md'), 'utf8'),
    'src/agents.stub.md': readFileSync(join(repo, 'src/agents.stub.md'), 'utf8'),
  };
  // docs/baton holds dated plan records; they quote counts as they were.
  for (const f of readdirSync(join(repo, 'docs'), { recursive: true }) as string[])
    if (f.endsWith('.md') && !f.startsWith('baton')) sources[`docs/${f}`] = readFileSync(join(repo, 'docs', f), 'utf8');
  for (const [key, t] of Object.entries(TEMPLATES)) sources[`template:${key}`] = t.content;

  it('counts 23 languages: every grammar, TSX as TypeScript, no static file types', () => {
    expect(count).toBe(23);
  });

  it.each(Object.keys(sources))('%s states the registry count', (key) => {
    // "Tier 1 languages" names a tier, not a count.
    for (const m of sources[key]!.matchAll(/(?<!\btier\s)\b(\d+)\s+(?:supported\s+)?languages\b/gi)) expect(Number(m[1]), `${key}: "${m[0]}"`).toBe(count);
  });

  it('docs/configuration.md lists the registry tiers with their counts', () => {
    const tiers = Object.values(getBuiltinLanguages()).filter((l) => l.tier !== 'static' && l.name !== 'tsx');
    const text = sources['docs/configuration.md']!;
    for (const [label, tier] of [['Built-in', 'built-in'], ['Bundled', 'bundled']]) {
      const row = text.match(new RegExp(`^\\| \\*\\*${label}\\*\\* \\| ([^|]+) \\| (\\d+) \\|$`, 'm'));
      expect(row, label).not.toBeNull();
      const names = row![1]!.split(',').map((n) => n.trim());
      expect(Number(row![2]), label).toBe(names.length);
      expect(names.length, label).toBe(tiers.filter((l) => l.tier === tier).length);
    }
  });
});
