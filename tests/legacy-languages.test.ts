import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getLanguageForFile, languageFromShebang } from '../src/languages/registry.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

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
