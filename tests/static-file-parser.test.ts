import { describe, it, expect } from 'vitest';
import { StaticFileParser } from '../src/parsers/static-file-parser.js';
import { getLanguageForFile, getBuiltinLanguages } from '../src/languages/registry.js';

const parser = new StaticFileParser();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function parse(filePath: string, source: string) {
  return parser.parse(filePath, source);
}

function targets(result: Awaited<ReturnType<typeof parse>>) {
  return result.references.map(r => r.targetName);
}

// ---------------------------------------------------------------------------
// Parser meta
// ---------------------------------------------------------------------------

describe('StaticFileParser — meta', () => {
  it('languageName is "static"', () => {
    expect(parser.languageName).toBe('static');
  });

  it('supportedExtensions covers all static types', () => {
    const exts = parser.supportedExtensions;
    for (const e of ['.md', '.mdx', '.markdown', '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.json', '.jsonc', '.json5', '.yaml', '.yml']) {
      expect(exts).toContain(e);
    }
  });

  it('always returns empty symbols array', async () => {
    const result = await parse('README.md', '# Hello\n[link](./foo.md)');
    expect(result.symbols).toHaveLength(0);
  });

  it('always returns empty errors array', async () => {
    const result = await parse('README.md', '# Hello');
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

describe('StaticFileParser — Markdown', () => {
  it('extracts inline links with relative paths', async () => {
    const result = await parse('docs/README.md', '[Guide](./guide.md) and [API](../api/index.md)');
    expect(targets(result)).toContain('./guide.md');
    expect(targets(result)).toContain('../api/index.md');
  });

  it('ignores image links (non-markdown targets)', async () => {
    const result = await parse('docs/README.md', '![logo](./images/logo.png)');
    expect(result.references).toHaveLength(0);
  });

  it('ignores absolute HTTP links', async () => {
    const result = await parse('README.md', '[External](https://example.com/page)');
    expect(result.references).toHaveLength(0);
  });

  it('ignores anchor-only links', async () => {
    const result = await parse('README.md', '[Section](#section)');
    expect(result.references).toHaveLength(0);
  });

  it('strips optional title from link target', async () => {
    const result = await parse('README.md', '[link](./file.md "My Title")');
    expect(targets(result)).toContain('./file.md');
    expect(targets(result)[0]).not.toContain('"');
  });

  it('extracts links on multiple lines', async () => {
    const src = `# Doc\n\n[first](./a.md)\n\nSome text\n\n[second](../b.md)\n`;
    const result = await parse('docs/index.md', src);
    expect(targets(result)).toContain('./a.md');
    expect(targets(result)).toContain('../b.md');
  });

  it('records correct startLine', async () => {
    const src = `line1\nline2\n[link](./target.md)`;
    const result = await parse('README.md', src);
    expect(result.references[0].startLine).toBe(3);
  });

  it('referenceType is import', async () => {
    const result = await parse('README.md', '[link](./foo.md)');
    expect(result.references[0].referenceType).toBe('import');
  });

  it('sourceSymbol is null', async () => {
    const result = await parse('README.md', '[link](./foo.md)');
    expect(result.references[0].sourceSymbol).toBeNull();
  });

  it('verifiability is inferred', async () => {
    const result = await parse('README.md', '[link](./foo.md)');
    expect(result.references[0].verifiability).toBe('inferred');
  });

  it('handles .mdx extension', async () => {
    const result = await parse('docs/page.mdx', '[link](./other.mdx)');
    expect(targets(result)).toContain('./other.mdx');
  });

  it('handles .markdown extension', async () => {
    const result = await parse('page.markdown', '[link](./other.md)');
    expect(targets(result)).toContain('./other.md');
  });

  it('ignores non-markdown targets in .markdown files', async () => {
    const result = await parse('page.markdown', '[link](./style.css)');
    expect(result.references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

describe('StaticFileParser — HTML', () => {
  it('extracts href attributes', async () => {
    const result = await parse('index.html', '<a href="./about.html">About</a>');
    expect(targets(result)).toContain('./about.html');
  });

  it('extracts src attributes', async () => {
    const result = await parse('index.html', '<script src="./app.js"></script>');
    expect(targets(result)).toContain('./app.js');
  });

  it('extracts link rel stylesheet href', async () => {
    const result = await parse('index.html', '<link rel="stylesheet" href="./styles.css">');
    expect(targets(result)).toContain('./styles.css');
  });

  it('extracts img src', async () => {
    const result = await parse('index.html', '<img src="../assets/logo.png" alt="logo">');
    expect(targets(result)).toContain('../assets/logo.png');
  });

  it('ignores absolute http src/href', async () => {
    const src = '<script src="https://cdn.example.com/lib.js"></script>\n<a href="https://example.com">link</a>';
    const result = await parse('index.html', src);
    expect(result.references).toHaveLength(0);
  });

  it('ignores query strings and fragments in href', async () => {
    const result = await parse('index.html', '<a href="#section">Go</a>');
    expect(result.references).toHaveLength(0);
  });

  it('extracts @import inside style tag', async () => {
    const result = await parse('index.html', '<style>\n@import "./theme.css";\n</style>');
    expect(targets(result)).toContain('./theme.css');
  });

  it('extracts url() inside style tag', async () => {
    const result = await parse('index.html', '<style>background: url("./bg.png");</style>');
    expect(targets(result)).toContain('./bg.png');
  });

  it('handles .htm extension', async () => {
    const result = await parse('page.htm', '<a href="./other.htm">link</a>');
    expect(targets(result)).toContain('./other.htm');
  });

  it('handles .xhtml extension', async () => {
    const result = await parse('page.xhtml', '<a href="./page.xhtml">link</a>');
    expect(targets(result)).toContain('./page.xhtml');
  });
});

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

describe('StaticFileParser — CSS / SCSS / Sass / Less', () => {
  it('extracts @import "…"', async () => {
    const result = await parse('styles/main.css', '@import "./base.css";');
    expect(targets(result)).toContain('./base.css');
  });

  it('extracts @import with single quotes', async () => {
    const result = await parse('styles/main.css', "@import './reset.css';");
    expect(targets(result)).toContain('./reset.css');
  });

  it('extracts url() with quotes', async () => {
    const result = await parse('styles/main.css', 'background: url("./images/bg.png");');
    expect(targets(result)).toContain('./images/bg.png');
  });

  it('extracts url() without quotes', async () => {
    const result = await parse('styles/main.css', 'background: url(./images/bg.png);');
    expect(targets(result)).toContain('./images/bg.png');
  });

  it('ignores absolute urls', async () => {
    const result = await parse('styles/main.css', 'background: url(https://cdn.example.com/bg.png);');
    expect(result.references).toHaveLength(0);
  });

  it('handles .scss extension', async () => {
    const result = await parse('main.scss', '@import "./variables";');
    expect(targets(result)).toContain('./variables');
  });

  it('handles .sass extension', async () => {
    const result = await parse('main.sass', '@import "./mixins"');
    expect(targets(result)).toContain('./mixins');
  });

  it('handles .less extension', async () => {
    const result = await parse('main.less', '@import "./theme.less";');
    expect(targets(result)).toContain('./theme.less');
  });

  it('extracts multiple imports', async () => {
    const src = '@import "./reset.css";\n@import "./typography.css";\n@import "./layout.css";';
    const result = await parse('main.css', src);
    expect(targets(result)).toContain('./reset.css');
    expect(targets(result)).toContain('./typography.css');
    expect(targets(result)).toContain('./layout.css');
  });
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('StaticFileParser — JSON', () => {
  it('extracts $ref relative path', async () => {
    const result = await parse('schema.json', JSON.stringify({ $ref: './other.json' }));
    expect(targets(result)).toContain('./other.json');
  });

  it('extracts $schema relative path', async () => {
    const result = await parse('tsconfig.json', JSON.stringify({ $schema: './schemas/tsconfig.schema.json' }));
    expect(targets(result)).toContain('./schemas/tsconfig.schema.json');
  });

  it('extracts extends relative path (string)', async () => {
    const result = await parse('tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json' }));
    expect(targets(result)).toContain('./tsconfig.base.json');
  });

  it('extracts extends as array of paths', async () => {
    const result = await parse('tsconfig.json', JSON.stringify({ extends: ['./base.json', './overrides.json'] }));
    expect(targets(result)).toContain('./base.json');
    expect(targets(result)).toContain('./overrides.json');
  });

  it('ignores $ref absolute URL', async () => {
    const result = await parse('schema.json', JSON.stringify({ $ref: 'https://json-schema.org/schema' }));
    expect(result.references).toHaveLength(0);
  });

  it('ignores non-path string values', async () => {
    const result = await parse('package.json', JSON.stringify({ name: 'myapp', version: '1.0.0', license: 'MIT' }));
    expect(result.references).toHaveLength(0);
  });

  it('returns empty refs on invalid JSON', async () => {
    const result = await parse('broken.json', '{ this is not json }');
    expect(result.references).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('handles .jsonc extension', async () => {
    const result = await parse('config.jsonc', JSON.stringify({ $ref: './base.jsonc' }));
    expect(targets(result)).toContain('./base.jsonc');
  });

  it('handles .json5 extension', async () => {
    const result = await parse('config.json5', JSON.stringify({ extends: './base.json' }));
    expect(targets(result)).toContain('./base.json');
  });
});

// ---------------------------------------------------------------------------
// JSONC / JSON5 syntax handling
// ---------------------------------------------------------------------------

describe('StaticFileParser — JSONC / JSON5 syntax', () => {
  it('strips line comments', async () => {
    const src = `{
  // This is a comment
  "extends": "./tsconfig.base.json"
}`;
    const result = await parse('tsconfig.jsonc', src);
    expect(targets(result)).toContain('./tsconfig.base.json');
  });

  it('strips block comments', async () => {
    const src = `{
  /* multi
     line
     comment */
  "$ref": "./schema/base.json"
}`;
    const result = await parse('schema.jsonc', src);
    expect(targets(result)).toContain('./schema/base.json');
  });

  it('strips inline block comments', async () => {
    const src = `{
  "extends": /* override */ "./base.json"
}`;
    const result = await parse('tsconfig.json', src);
    expect(targets(result)).toContain('./base.json');
  });

  it('handles trailing commas', async () => {
    const src = `{
  "extends": "./base.json",
  "$ref": "./other.json",
}`;
    const result = await parse('config.jsonc', src);
    expect(targets(result)).toContain('./base.json');
    expect(targets(result)).toContain('./other.json');
  });

  it('handles trailing comma in arrays', async () => {
    const src = `{
  "extends": [
    "./base.json",
    "./overrides.json",
  ]
}`;
    const result = await parse('tsconfig.json', src);
    expect(targets(result)).toContain('./base.json');
    expect(targets(result)).toContain('./overrides.json');
  });

  it('handles single-quoted strings (JSON5)', async () => {
    const src = `{
  'extends': './base.json'
}`;
    const result = await parse('config.json5', src);
    expect(targets(result)).toContain('./base.json');
  });

  it('handles unquoted keys (JSON5)', async () => {
    const src = `{
  extends: "./base.json"
}`;
    const result = await parse('config.json5', src);
    expect(targets(result)).toContain('./base.json');
  });

  it('handles combined JSONC features', async () => {
    const src = `{
  // Project config
  "extends": "./tsconfig.base.json",
  /* Schema reference */
  "$ref": "./schemas/project.json",
}`;
    const result = await parse('tsconfig.json', src);
    expect(targets(result)).toContain('./tsconfig.base.json');
    expect(targets(result)).toContain('./schemas/project.json');
  });

  it('preserves strings containing // that are not comments', async () => {
    const src = `{
  "$ref": "./schemas/my-ref.json"
}`;
    const result = await parse('config.json', src);
    expect(targets(result)).toContain('./schemas/my-ref.json');
  });

  it('does not break on deeply invalid content', async () => {
    const src = `this is completely invalid {{{`;
    const result = await parse('broken.jsonc', src);
    expect(result.references).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

describe('StaticFileParser — YAML', () => {
  it('extracts relative paths ending in .yaml or .yml', async () => {
    const src = `
dependencies:
  core: ./core.yaml
  ui: '../ui/ui_config.yml'
    `;
    const result = await parse('pubspec.yaml', src);
    expect(targets(result)).toContain('./core.yaml');
    expect(targets(result)).toContain('../ui/ui_config.yml');
  });

  it('ignores paths pointing to non-YAML files', async () => {
    const src = `
dependencies:
  library: ./lib/main.dart
  asset: ./assets/logo.png
    `;
    const result = await parse('pubspec.yaml', src);
    expect(result.references).toHaveLength(0);
  });

  it('ignores absolute paths and external URLs', async () => {
    const src = `
schema: https://example.com/schema.yaml
absolute: /root/config.yaml
    `;
    const result = await parse('config.yaml', src);
    expect(result.references).toHaveLength(0);
  });

  it('records correct startLine for YAML references', async () => {
    const src = `line1\nline2\nconfig: ./sub.yaml`;
    const result = await parse('config.yaml', src);
    expect(result.references[0].startLine).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Unknown / fallback extension
// ---------------------------------------------------------------------------

describe('StaticFileParser — unknown extension', () => {
  it('returns empty references for unrecognised extension', async () => {
    const result = await parse('file.xyz', 'some content');
    expect(result.symbols).toHaveLength(0);
    expect(result.references).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

describe('Registry — static language entries', () => {
  it('resolves .md to the markdown language definition', () => {
    const lang = getLanguageForFile('README.md');
    expect(lang).not.toBeNull();
    expect(lang?.name).toBe('markdown');
    expect(lang?.tier).toBe('static');
  });

  it('resolves .mdx to markdown', () => {
    expect(getLanguageForFile('page.mdx')?.name).toBe('markdown');
  });

  it('resolves .html to html', () => {
    expect(getLanguageForFile('index.html')?.tier).toBe('static');
    expect(getLanguageForFile('index.html')?.name).toBe('html');
  });

  it('resolves .htm to html', () => {
    expect(getLanguageForFile('page.htm')?.name).toBe('html');
  });

  it('resolves .css to css', () => {
    expect(getLanguageForFile('main.css')?.name).toBe('css');
    expect(getLanguageForFile('main.css')?.tier).toBe('static');
  });

  it('resolves .scss to css', () => {
    expect(getLanguageForFile('main.scss')?.name).toBe('css');
  });

  it('resolves .sass to css', () => {
    expect(getLanguageForFile('main.sass')?.name).toBe('css');
  });

  it('resolves .less to css', () => {
    expect(getLanguageForFile('main.less')?.name).toBe('css');
  });

  it('resolves .json to json', () => {
    const lang = getLanguageForFile('config.json');
    expect(lang?.name).toBe('json');
    expect(lang?.tier).toBe('static');
  });

  it('resolves .jsonc to json', () => {
    expect(getLanguageForFile('settings.jsonc')?.name).toBe('json');
  });

  it('resolves .json5 to json', () => {
    expect(getLanguageForFile('config.json5')?.name).toBe('json');
  });

  it('resolves .yaml to yaml', () => {
    const lang = getLanguageForFile('pubspec.yaml');
    expect(lang?.name).toBe('yaml');
    expect(lang?.tier).toBe('static');
  });

  it('resolves .yml to yaml', () => {
    expect(getLanguageForFile('config.yml')?.name).toBe('yaml');
  });

  it('static entries appear in getBuiltinLanguages()', () => {
    const langs = getBuiltinLanguages();
    expect(langs).toHaveProperty('markdown');
    expect(langs).toHaveProperty('html');
    expect(langs).toHaveProperty('css');
    expect(langs).toHaveProperty('json');
    expect(langs).toHaveProperty('yaml');
    for (const key of ['markdown', 'html', 'css', 'json', 'yaml']) {
      expect(langs[key].tier).toBe('static');
    }
  });

  it('static entries have empty grammarWasm', () => {
    const langs = getBuiltinLanguages();
    for (const key of ['markdown', 'html', 'css', 'json', 'yaml']) {
      expect(langs[key].grammarWasm).toBe('');
    }
  });
});
