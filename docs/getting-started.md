# Getting Started with MapxGraph

## Installation

### Global Installation (via npm)

```bash
npm install -g @mgamil/mapx
```

### Zero Installation (via npx)

Run commands directly without global installation:

```bash
npx @mgamil/mapx <command>
```

### From source (development)

```bash
git clone <repo-url>
cd mapx
npm install --legacy-peer-deps
```

### Pre-built binary (no dependencies)

Download from the GitHub Releases page and add to your `PATH`, or run the installer for your platform (more options in the [README](../README.md#pre-built-binary)):

```bash
curl -fsSL https://github.com/MohamedGamil/mapx/releases/latest/download/mapx-linux-x64-installer.sh | sh
```

## Quick Start

> [!TIP]
> If you are using the zero-installation method, replace `mapx` with `npx @mgamil/mapx` in the commands below (e.g. `npx @mgamil/mapx init`, `npx @mgamil/mapx scan`).

```bash
# 1. Initialize MapxGraph in your project
cd /path/to/your/project
mapx init

# 2. Scan the codebase
mapx scan

# 3. View the graph summary
mapx export

# 4. Search for a symbol
mapx query MyClass

# 5. Check dependencies
mapx deps src/index.ts

# 6. Export as SVG visualization
mapx export --format=svg -o graph.svg

# 7. Trace callers of a function
mapx callers handleRequest

# 8. Assess change impact
mapx impact UserService
```

All commands accept a target directory:

```bash
# Positional path
mapx scan /path/to/project

# --dir / -d flag
mapx scan --dir /path/to/project
mapx query "MyClass" -d /path/to/project

# Global flag (works with any subcommand)
mapx -d /path/to/project scan

# If no directory is specified, defaults to current working directory.
```

## What Gets Created

Running `init` creates a `.mapx/` directory, an `AGENTS.md` file, and updates `.gitignore`:

```
.mapx/
├── config.json       # Project configuration
├── mapx.db           # SQLite database (after scan)
└── scan.lock         # Scan lock file (present only while a scan is running)

AGENTS.md             # MapxGraph documentation for LLMs (auto-generated)
```

`.mapx/` is automatically added to `.gitignore` during init (if `.gitignore` exists or the project is a git repository).

## Reversing Installation

If you want to completely remove MapxGraph configurations, delete `.mapx/`, and reverse LLM integration changes (like `AGENTS.md` and custom provider instructions) in your project, run:

```bash
mapx uninit
```

## AGENTS.md

During `init`, MapxGraph creates or updates an `AGENTS.md` file in the project root. This file contains documentation that helps LLM tools discover and use MapxGraph's CLI and MCP tools.

The content is wrapped in markers:
```markdown
<!-- mapx -->
...MapxGraph documentation...
<!-- /mapx -->
```

- **No existing AGENTS.md**: Creates one with MapxGraph docs
- **Existing with markers**: Updates content between markers (preserves surrounding content)
- **Existing without markers**: Prompts to insert at beginning/end, or skip
- **`--no-agents` flag**: Skip AGENTS.md creation entirely

## Supported Languages

All 23 languages ship with their tree-sitter grammars; `mapx lang list` lists them with their extensions and tier.

### Dedicated parsers

| Language | Extensions | Symbols Extracted |
|----------|-----------|-------------------|
| PHP | `.php`, `.phtml`, `.php3`–`.php7` | classes, methods, functions, interfaces, traits, enums, constants, properties, namespaces |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx` | classes, methods, functions, interfaces, constants, enums, properties, namespaces |
| TypeScript | `.ts`, `.cts`, `.mts`, `.tsx` | classes, methods, functions, interfaces, constants, enums, properties, namespaces |
| Vue | `.vue` | functions, classes, methods, properties (SFC script blocks); a component symbol per file; template handler and binding calls, and render edges for locally or globally registered component tags; `props` / `emits` from `defineProps` / `defineEmits` on the component symbol; composable `useX()` calls and the functions destructured from them resolved through the import; navigate edges from Vue Router `push` / `replace` and `<router-link :to>` to the route's component |
| Svelte | `.svelte` | the component, `export let` props, and the functions, classes, methods and constants of its `<script>` blocks (`context="module"` too), with their imports, calls and instantiations as in a `.js` / `.ts` file; template calls, event handlers and `use:` actions link to the component's own or imported functions, and component tags (`<Child />`, `<ui.Button />`) give render edges |

### Query-driven parsers (tree-sitter queries)

| Language | Extensions | Symbols Extracted |
|----------|-----------|-------------------|
| Python | `.py`, `.pyw` | classes, functions, methods (auto-promoted), constants |
| Go | `.go` | structs, interfaces, functions, methods, constants, packages, variables, type aliases |
| Rust | `.rs` | structs, traits, enums, functions, impl blocks, constants, statics, modules, macros |
| Java | `.java` | classes, interfaces, enums, methods, constructors, fields, constants, annotations, packages |
| C# | `.cs` | classes, interfaces, enums, structs, methods, properties, constants, namespaces, records, delegates |
| Ruby | `.rb`, `.rake`, `.gemspec`, `Rakefile`, `Gemfile` | classes, modules, methods, constants, properties (attr_*) |
| C | `.c`, `.h` | structs, functions, enums, typedefs, macros, unions |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hh`, `.h++`, `.c++`; `.h` headers that use C++-only syntax outside preprocessor conditionals (`namespace`, `class`, `template`, …) | classes, structs, functions, namespaces, enums, templates |
| Swift | `.swift` | classes, structs, protocols, enums, functions, properties, extensions |
| Kotlin | `.kt`, `.kts` | classes, objects, functions, interfaces, properties, enum entries |
| Scala | `.scala`, `.sc` | classes, objects, traits, functions, vals, vars, packages |
| Lua | `.lua`, `.luau` | functions, methods, local functions, variables |
| Elixir | `.ex`, `.exs` | modules, functions (def/defp), macros, structs, protocols |
| Zig | `.zig` | functions, structs, constants, tests, error sets |
| Bash | `.sh`, `.bash`, `.zsh` | functions, variables, aliases |
| Fish | `.fish` | functions (calls and `source` imports tracked) |
| Pascal | `.pas`, `.pp`, `.dpr`, `.lpr` | procedures, functions, classes, records, interfaces, methods, constants, units |
| Dart | `.dart` | classes, functions, methods, getters/setters, factory/named constructors, enums, mixins, extensions, typedefs, extension types (Dart 3.3+), constants, library namespaces |

### Static (index-only)

| File type | Extensions | Tracked references |
|-----------|-----------|-------------------|
| Markdown | `.md`, `.mdx`, `.markdown` | links to other files |
| HTML | `.html`, `.htm`, `.xhtml` | `href`, `src` attributes |
| CSS/SCSS/Sass/Less | `.css`, `.scss`, `.sass`, `.less` | `@import`, `url()` references |
| JSON/JSONC/JSON5 | `.json`, `.jsonc`, `.json5` | `$ref`, `extends` values |
| YAML | `.yaml`, `.yml` | relative paths to other YAML files (`./config.yaml`) |

Extensionless scripts are indexed by their `#!` line (bash/sh/zsh, python, node/deno/bun, ts-node/tsx, ruby, php, lua, elixir, fish).

## Dependencies Tracked

All languages track applicable reference types:

- **Imports**: `import`, `require`, `use`, `include`, `#include`, `using`, `@import`, `alias`. JS/TS/Vue imports also resolve path aliases (`@/x`, `~/x`, `#x`) through the importing app's own configuration: the nearest tsconfig/jsconfig `compilerOptions.paths`, else the `vite.config.*`, `vue.config.js`, `webpack.config.js` or `webpack.mix.js` alias of the app root (the nearest folder with a `package.json` or bundler config), else `@/` → the app's `src/`. Configs are read statically, never executed, and a parent project's aliases never apply to a nested app ([details](framework-integration.md#import-aliases-js--ts))
- **Inheritance**: `extends`, `implements`, protocol conformance, mixins (`with`), `include`/`prepend`
- **Instantiation**: `new ClassName()`, `ClassName()`, `.new`, composite literals, constructor invocations
- **Calls**: function calls, method calls, remote calls, pipe operators, macro invocations
- **Other**: decorator references, annotations, type annotations

## Scan Resilience

Scans survive interruptions (Ctrl+C). Progress is saved in batches, so re-running `scan` resumes from where it left off.

```
$ mapx scan
Scan interrupted after 15/32 files. Progress saved — run `scan` again to resume.

$ mapx scan
Scanned 32 files in 523ms    # resumes from file 16
```

## Concurrent Scan Protection

Only one scan can run on a project at a time. `scanFull` and `scanIncremental` write a PID lock file (`.mapx/scan.lock`) on entry. A second invocation targeting the same project fails immediately:

```
Error: Another scan is already running on this project (PID 12345).
Wait for it to finish or delete /path/to/.mapx/scan.lock if it is stale.
```

Stale locks (process no longer alive) are cleared automatically.

## Programmatic Usage

MapX can be integrated programmatically as an ES Module in Node.js or TypeScript projects. This allows you to run scans, traverse dependency graphs, trace data flows, and build LLM-ready context dynamically.

For detailed documentation, module breakdowns, and e2e integration scripts, see the [Programmatic Usage Guide](programmatic-usage.md).

## Building a Standalone Binary

```bash
# Build for current platform
make build-linux       # or build-mac-arm, build-win

# Cross-compile for all platforms
make build-all

# Build npm package (tsup + dashboard; `npm pack` / `npm publish` build the dashboard too)
npm run build:npm

# Dashboard only (installs no longer build it; `mapx ui` from source builds it when stale)
npm run build:ui
```

The registry package (`npm install -g @mgamil/mapx`) ships the dashboard. Installing from git (`npm install github:…`), with `npm link` or from a `file:` path runs only `prepare`, which compiles the CLI. Run `npm run build:ui` in the MapX folder to add the dashboard (D020).

```bash

# Package + installers
make package-all
```

Binaries are output to `dist/` (~85-100MB each).

## Publishing to npm (maintainers)

The package is published as **`@mgamil/mapx`**; the unscoped name `mapx` belongs to someone else. Releases are owner-initiated. Pushing a `vX.Y.Z` tag runs `.github/workflows/publish-npm.yml`, which publishes with npm provenance. One-time setup:

1. Create an npm **automation** access token for an account with publish rights on `@mgamil/mapx`.
2. Add it to the GitHub repository as the Actions secret **`NPM_TOKEN`** (Settings → Secrets and variables → Actions).
3. Keep `VERSION`, `package.json` and the CHANGELOG in step (`npm run version-sync`) before tagging.

Native binaries must never be published: `npx tsx scripts/check-package.ts`, which CI runs, fails when the pack list contains a native ELF, Mach-O or PE binary.

## Development Shortcuts

All CLI commands are available as npm scripts and Makefile targets:

```bash
# npm scripts (pass args after --)
npm run scan
npm run query -- UserService
npm run impact -- handleRequest
npm run serve

# Makefile targets (use variables)
make scan DIR=/path
make query q=UserService
make impact s=handleRequest d=3
make serve DIR=/path

# Run `make help` for all 30+ targets
```
