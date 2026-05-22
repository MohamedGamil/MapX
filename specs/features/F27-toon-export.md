# F27 — TOON Export Format

| Field | Value |
|-------|-------|
| ID | F27 |
| Status | `planned` |
| Iteration | I14 |
| Branch | `feat/i14-toon-export` |
| Depends on | — (independent) |
| Spec version | TOON v3.3 (2026-05-20 Working Draft) |
| Reference | https://toonformat.dev/reference/spec.html |

---

## Overview

TOON (Token-Oriented Object Notation) is a line-oriented, indentation-based data format that shares JSON's data model but minimises the number of tokens a large language model must consume. It uses tabular arrays for uniform object lists, inline arrays for primitive sequences, and key folding for deeply nested single-key chains. These features make it substantially more compact than JSON or YAML for the kinds of structured data mapx exports.

Ref: [TOON spec v3.3](https://toonformat.dev/reference/spec.html) — media type `text/toon`, file extension `.toon`.

After F27, `mapx export --format=toon` emits a `.toon` document that represents the same information as the existing LLM (Markdown) exporter but in valid, decodable TOON — allowing tooling that ingests TOON to round-trip the graph data and allowing LLMs that are TOON-aware to process the export more efficiently.

---

## TOON syntax primer (for implementers)

### Object fields

```toon
id: 123
name: Ada
active: true
```

Key–value pairs, one per line, colon + space separator. Indentation (2 spaces default) replaces braces.

### Nested objects

```toon
project:
  name: myapp
  language: typescript
  fileCount: 42
```

### Primitive arrays (inline)

```toon
tags[3]: admin,ops,dev
```

Header: `key[N]:`, values comma-separated. Values containing the active delimiter are quoted.

### Tabular arrays (arrays of uniform objects)

```toon
files[3]{path,language,symbols}:
  src/cli.ts,typescript,12
  src/core/graph.ts,typescript,8
  src/parsers/php.ts,php,31
```

Header: `key[N]{field1,field2,...}:`, one row per line. All rows must have the same fields and only primitive values.

### List arrays (non-uniform / mixed)

```toon
items[3]:
  - 42
  - name: Ada
  - hello world
```

Each element prefixed with `- ` at the next indentation level.

### Empty containers

```toon
metadata:
tags: []
```

### Key folding (optional — single-key chains collapse)

```toon
# Without folding:
project:
  meta:
    version: 1.0.0

# With keyFolding: 'safe':
project.meta.version: 1.0.0
```

### Quoting rules

Strings must be quoted when they:
- Are empty (`""`)
- Equal `true`, `false`, or `null`
- Look like numbers (`"42"`, `"-3.14"`, `"1e-6"`)
- Contain `:`, `"`, `\`, `[`, `]`, `{`, `}`, or control characters (U+0000–U+001F)
- Contain the active delimiter (comma by default in array scopes)
- Equal `"-"` or start with `"-"` followed by any character
- Have leading or trailing whitespace

All other strings (including those with Unicode, emoji, or internal spaces) are unquoted.

---

## Data mapping: mapx graph → TOON

### Root document structure

```toon
version: 1
generated: 2026-05-22T10:00:00Z
repo: myapp
tokenBudget: 8192

summary:
  files: 42
  symbols: 318
  edges: 891
  languages[3]: typescript,php,javascript

files[42]{path,language,symbols,pagerank}:
  src/cli.ts,typescript,12,0.042
  src/core/graph.ts,typescript,8,0.031
  ...

symbols[N]{name,kind,file,scope,pagerank}:
  ...

edges[N]{sourceFile,targetFile,edgeType,sourceSymbol,targetSymbol,weight}:
  ...
```

### `files` section

Each file row contains:
- `path` — relative file path (string, quoted only if necessary per quoting rules)
- `language` — detected language name
- `symbols` — count of symbols in the file
- `pagerank` — PageRank score (number, 6 significant digits)

Use tabular form when all rows have uniform primitive-valued fields. This is always the case for the files table.

### `symbols` section

Each symbol row contains:
- `name` — symbol name
- `kind` — `class | function | method | interface | enum | type | property | constant | variable`
- `file` — file path
- `scope` — parent scope / class name, or empty string `""` for top-level symbols
- `pagerank` — PageRank score

Because `name`, `file`, and `scope` are strings that may contain characters requiring quoting (colons, backslashes, etc.), the encoder must apply TOON quoting rules per §7 of the spec.

### `edges` section

Each edge row contains:
- `sourceFile` — source file path
- `targetFile` — target file path (may be empty string `""` if unresolved)
- `edgeType` — one of the `ReferenceType` values: `import | require | extends | implements | call | instantiation | return_type | param_type | relation | route | middleware | binding | dispatch | notify | hook | graphql_resolver | message_handler | websocket_handler`
- `sourceSymbol` — originating symbol (may be empty string)
- `targetSymbol` — target symbol (may be empty string)
- `weight` — numeric edge weight

### Budget-aware truncation

When `--tokens=N` is specified, the exporter trims lower-ranked symbols and edges from the output — same strategy as the LLM exporter — until the estimated token count fits. Token estimation: `ceil(byteLength / 4)` (same heuristic as existing exporters).

When the output is truncated, append a footer:

```toon
truncated: true
truncatedAt: symbols
includedSymbols: 200
totalSymbols: 318
```

---

## Complete example

A small project with 3 files, 6 symbols, 8 edges:

```toon
version: 1
generated: 2026-05-22T10:00:00Z
repo: myapp
tokenBudget: 8192

summary:
  files: 3
  symbols: 6
  edges: 8
  languages[2]: typescript,php

files[3]{path,language,symbols,pagerank}:
  src/index.ts,typescript,2,0.058
  src/core/store.ts,typescript,3,0.041
  src/parsers/php.ts,php,1,0.022

symbols[6]{name,kind,file,scope,pagerank}:
  main,function,src/index.ts,"",0.058
  bootstrap,function,src/index.ts,"",0.031
  Store,class,src/core/store.ts,"",0.041
  getAllFiles,method,src/core/store.ts,Store,0.034
  getAllEdges,method,src/core/store.ts,Store,0.029
  PhpParser,class,src/parsers/php.ts,"",0.022

edges[8]{sourceFile,targetFile,edgeType,sourceSymbol,targetSymbol,weight}:
  src/index.ts,src/core/store.ts,import,main,Store,1
  src/index.ts,src/core/store.ts,call,main,getAllFiles,1
  src/index.ts,src/core/store.ts,call,bootstrap,getAllEdges,1
  src/index.ts,src/parsers/php.ts,import,main,PhpParser,1
  src/core/store.ts,src/parsers/php.ts,import,Store,PhpParser,1
  src/core/store.ts,src/parsers/php.ts,call,getAllFiles,PhpParser,1
  src/core/store.ts,src/parsers/php.ts,instantiation,Store,PhpParser,1
  src/parsers/php.ts,src/core/store.ts,import,PhpParser,Store,1
```

---

## Implementation

### File location

`src/exporters/toon-exporter.ts`

### Class structure

```typescript
import type { Store } from '../core/store.js';
import type { MapxGraph } from '../core/graph.js';
import type { ExportOptions } from '../types.js';

export class ToonExporter {
  private store: Store;
  private graph: MapxGraph;

  constructor(store: Store, graph: MapxGraph) {
    this.store = store;
    this.graph = graph;
  }

  export(options: ExportOptions): string {
    // Returns a valid TOON document string
  }
}
```

### Key implementation rules (from TOON spec §13.1 encoder checklist)

1. **UTF-8 + LF** — output must be UTF-8 with `\n` line endings; no `\r\n`
2. **Indentation** — 2 spaces per level, no tabs; no trailing spaces on any line
3. **No trailing newline** — last character of the document is the last content character
4. **Array lengths** — `[N]` must match the actual number of rows/elements emitted
5. **Quoting** — apply quoting rules from §7; only quote when required
6. **Tabular detection** — use tabular format (`{fields}:` header) when all objects in an array have the same set of keys and all values are primitive; fall back to list form otherwise (§9)
7. **Number formatting** — canonical decimal for values in `[1e-6, 1e21)` or zero; exponent form elsewhere; `-0` → `0`; `NaN`/`±Infinity` → `null`
8. **Boolean/null** — emit `true`, `false`, `null` (lowercase only)
9. **Empty strings** — emit as `""`
10. **Key order** — preserve insertion order of object keys

### Quoting helper

```typescript
function toonQuote(value: string, activeDelimiter: ',' | '\t' | '|' = ','): string {
  const needsQuoting =
    value === '' ||
    /^\s|\s$/.test(value) ||
    value === 'true' || value === 'false' || value === 'null' ||
    /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || // looks like number
    /[:"\\\[\]{}\u0000-\u001F]/.test(value) ||
    value === '-' || /^-\S/.test(value) ||     // TOON spec: "-" alone, or "-" followed by any non-space char
    value.includes(activeDelimiter);
  if (!needsQuoting) return value;
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\u0000-\u001F]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`) + '"';
}
```

### Tabular row emitter

```typescript
function tabularRows(rows: Record<string, unknown>[], fields: string[], indent: string, delimiter: string): string[] {
  return rows.map(row =>
    fields.map(f => toonQuote(String(row[f] ?? ''), delimiter as ',' | '\t' | '|')).join(delimiter)
  ).map(line => indent + line);
}
```

### `mapx export` CLI integration

Add `'toon'` as a valid `--format` value alongside existing `llm | json | dot | svg`:

```
mapx export --format=toon            # TOON to stdout
mapx export --format=toon -o graph.toon  # TOON to file
mapx export --format=toon --tokens=16384  # larger budget
```

### `src/exporters/index.ts` update

```typescript
export { ToonExporter } from './toon-exporter.js';
```

### `src/cli.ts` update

In the `export` command handler, add a `case 'toon':` branch that instantiates `ToonExporter` and calls `.export(options)`.

---

## Optional: `--delimiter` flag

TOON supports three delimiters: comma (default), tab (`\t`), and pipe (`|`). Tab delimiters often produce fewer tokens for data with few quoted strings. Expose via:

```
mapx export --format=toon --delimiter=tab
mapx export --format=toon --delimiter=pipe
```

The flag is `toon`-only; other formats ignore it. Default: comma.

---

## Optional: `--key-folding` flag

When `--key-folding` is set, collapse single-key object chains into dotted paths per TOON spec §13.4. This can further reduce token count when the graph data has deep nested objects (e.g., `summary.files` → `summary.files`). Default: off (disabled) for maximum decoder compatibility.

---

## `mapx export --format=toon` vs `--format=llm`

| Property | `llm` (Markdown) | `toon` |
|----------|-----------------|-------|
| Human readable | Yes (Markdown) | Yes (TOON is readable) |
| Machine parseable | No | Yes (round-trippable) |
| Token efficiency | Baseline | Lower (tabular rows, less punctuation) |
| Token count validation | None | `[N]` array lengths enable truncation detection |
| Suitable for TOON-aware tools | No | Yes |
| File extension | `.md` | `.toon` |
| Media type | `text/markdown` | `text/toon` |

The TOON export is intended as a complement to the LLM export, not a replacement. LLMs that support TOON natively can use `--format=toon`; those that work better with Markdown prose continue using `--format=llm`.

---

## Acceptance Criteria

- [ ] `mapx export --format=toon` exits 0 and writes valid TOON to stdout
- [ ] `mapx export --format=toon -o graph.toon` writes to file
- [ ] Output is valid TOON: UTF-8, LF endings, no trailing spaces, no trailing newline
- [ ] `files[N]{...}:` array length `N` matches the actual number of file rows emitted
- [ ] `symbols[N]{...}:` array length `N` matches the actual number of symbol rows emitted
- [ ] `edges[N]{...}:` array length `N` matches the actual number of edge rows emitted
- [ ] Strings containing commas, colons, or TOON-reserved characters are correctly quoted
- [ ] Empty-scope symbols emit `""` for the `scope` field (not blank / missing)
- [ ] `true`, `false`, `null` are unquoted when used as boolean/null values
- [ ] Numbers emit in canonical decimal form (not `"0.042"` string form)
- [ ] `--tokens=N` truncates output and appends `truncated: true` footer
- [ ] `--delimiter=tab` uses tab delimiter in array headers and rows
- [ ] `--key-folding` collapses single-key chains into dotted paths
- [ ] `mapx export --format=json | toon-cli decode` round-trips to identical data (using reference TOON CLI tool)
- [ ] `npx tsc --noEmit` passes with 0 errors
- [ ] `mapx export --help` lists `toon` as a valid format option
