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

Download from releases/ and add to your `PATH`.

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

### Built-in (Tier 1) — Dedicated Parsers

| Language | Extensions | Symbols Extracted |
|----------|-----------|-------------------|
| PHP | `.php`, `.phtml` | classes, methods, functions, interfaces, traits, enums, constants, properties, namespaces |
| JavaScript | `.js`, `.mjs`, `.cjs` | classes, methods, functions, interfaces, constants, enums, properties, namespaces |
| TypeScript | `.ts`, `.cts`, `.mts` | classes, methods, functions, interfaces, constants, enums, properties, namespaces |
| Vue | `.vue` | functions, classes, methods, properties (SFC script blocks) |

### Bundled (Tier 2) — Generic WASM Parsers (Always Available)

| Language | Extensions | Symbols Extracted |
|----------|-----------|-------------------|
| Python | `.py` | classes, functions, methods (auto-promoted), constants |
| Go | `.go` | structs, interfaces, functions, methods, constants, packages, variables, type aliases |
| Rust | `.rs` | structs, traits, enums, functions, impl blocks, constants, statics, modules, macros |
| Java | `.java` | classes, interfaces, enums, methods, constructors, fields, constants, annotations, packages |
| C# | `.cs` | classes, interfaces, enums, structs, methods, properties, constants, namespaces, records, delegates |
| Ruby | `.rb` | classes, modules, methods, constants, properties (attr_*) |
| C | `.c`, `.h` | structs, functions, enums, typedefs, macros, unions |
| C++ | `.cpp`, `.hpp`, `.cc` | classes, structs, functions, namespaces, enums, templates |
| Swift | `.swift` | classes, structs, protocols, enums, functions, properties, extensions |
| Kotlin | `.kt`, `.kts` | classes, objects, functions, interfaces, properties, enum entries |
| Scala | `.scala`, `.sc` | classes, objects, traits, functions, vals, vars, packages |
| Svelte | `.svelte` | functions, classes, methods, props, constants |
| Lua | `.lua` | functions, methods, local functions, variables |
| Elixir | `.ex`, `.exs` | modules, functions (def/defp), macros, structs, protocols |
| Zig | `.zig` | functions, structs, constants, tests, error sets |
| Bash | `.sh`, `.bash` | functions, variables, aliases |
| Pascal | `.pas`, `.pp` | procedures, functions, classes, records, interfaces, methods, constants, units |
| Dart | `.dart` | classes, functions, methods, getters/setters, factory/named constructors, enums, mixins, extensions, typedefs, extension types (Dart 3.3+), constants, library namespaces |

## Dependencies Tracked

All languages track applicable reference types:

- **Imports**: `import`, `require`, `use`, `include`, `#include`, `using`, `@import`, `alias`
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

You can also import `@mgamil/mapx` programmatically in Node.js or TypeScript applications to manage code graphs, run scans, or generate token-efficient context.

```typescript
import { Config, Store, Scanner, MapxGraph, ContextBuilder } from '@mgamil/mapx';

// 1. Load configuration and open database
const dir = '/path/to/project';
const config = await Config.load(dir);
const store = new Store(`${dir}/.mapx/mapx.db`);

// 2. Perform an incremental scan
const scanner = new Scanner(dir, store);
await scanner.scanIncremental();

// 3. Load graph data
const graph = new MapxGraph(config.repo.name);
for (const file of store.getAllFiles()) {
  graph.addFileNode(file.path, file.language, file.size_bytes, file.lines);
}
for (const edge of store.getAllEdges()) {
  graph.addDependencyEdge({
    sourceFile: edge.source_file,
    targetFile: edge.target_file,
    sourceSymbol: edge.source_symbol,
    targetSymbol: edge.target_symbol,
    edgeType: edge.edge_type,
    repo: edge.repo,
    weight: edge.weight,
    verifiability: edge.verifiability,
    targetRepo: edge.target_repo
  });
}

// 4. Build a token-budgeted LLM context for a specific task
const builder = new ContextBuilder(store, graph);
const context = await builder.buildContext({
  task: 'Debug memory leaks in SQLite connections',
  tokens: 8000
});

console.log(context.text); // Prints structured Markdown context
console.log(`Estimated token count: ${context.tokens}`);

// 5. Always close the SQLite database store when done
store.close();
```

## Building a Standalone Binary

```bash
# Build for current platform
make build-linux       # or build-mac-arm, build-win

# Cross-compile for all platforms
make build-all

# Build npm package
npm run build:npm

# Package + installers
make package-all
```

Binaries are output to `dist/` (~85-100MB each).

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
