# Getting Started with CodeGraph

## Installation

```bash
# From source (development)
git clone <repo-url>
cd mem-project
npm install

# Or use pre-built binary (no dependencies needed)
# Download from releases/ and add to PATH
```

## Quick Start

```bash
# 1. Initialize CodeGraph in your project
cd /path/to/your/project
codegraph init

# 2. Scan the codebase
codegraph scan

# 3. View the graph summary
codegraph export

# 4. Search for a symbol
codegraph query MyClass

# 5. Check dependencies
codegraph deps src/index.ts

# 6. Export as SVG visualization
codegraph export --format=svg -o graph.svg
```

All commands accept a target directory:

```bash
# Positional path
codegraph scan /path/to/project

# --dir / -d flag
codegraph scan --dir /path/to/project
codegraph query "MyClass" -d /path/to/project

# Global flag (works with any subcommand)
codegraph -d /path/to/project scan

# If no directory is specified, defaults to current working directory.
```

## What Gets Created

Running `init` creates a `.codegraph/` directory in your project and an `AGENTS.md` file:

```
.codegraph/
├── config.json       # Project configuration
├── codegraph.db      # SQLite database (after scan)
└── scan.lock         # Scan lock file (present only while a scan is running)

AGENTS.md             # CodeGraph documentation for LLMs (auto-generated)
```

Add `.codegraph/` to your `.gitignore` — it's a local development artifact.

## AGENTS.md

During `init`, CodeGraph creates or updates an `AGENTS.md` file in the project root. This file contains documentation that helps LLM tools discover and use CodeGraph's CLI and MCP tools.

The content is wrapped in markers:
```markdown
<!-- codegraph -->
...CodeGraph documentation...
<!-- /codegraph -->
```

- **No existing AGENTS.md**: Creates one with CodeGraph docs
- **Existing with markers**: Updates content between markers (preserves surrounding content)
- **Existing without markers**: Prompts to insert at beginning/end, or skip
- **`--no-agents` flag**: Skip AGENTS.md creation entirely

## Supported File Types

| Language | Extensions | Symbols Extracted |
|----------|-----------|-------------------|
| PHP | `.php`, `.phtml` | classes, methods, functions, interfaces, traits, enums, constants |
| JavaScript | `.js`, `.mjs`, `.cjs` | classes, methods, functions, arrow functions |
| TypeScript | `.ts`, `.cts`, `.mts` | classes, methods, functions, interfaces, enums, properties |

## Dependencies Tracked

- `require` / `include` (PHP)
- `import` / `from` (JS/TS)
- `extends` / `implements` (all)
- Class instantiation (`new`)
- Function/method calls

## Scan Resilience

Scans survive interruptions (Ctrl+C). Progress is saved in batches, so re-running `scan` resumes from where it left off.

```
$ codegraph scan
Scan interrupted after 15/32 files. Progress saved — run `scan` again to resume.

$ codegraph scan
Scanned 32 files in 523ms    # resumes from file 16
```

## Concurrent Scan Protection

Only one scan can run on a project at a time. `scanFull` and `scanIncremental` write a PID lock file (`.codegraph/scan.lock`) on entry. A second invocation targeting the same project fails immediately:

```
Error: Another scan is already running on this project (PID 12345).
Wait for it to finish or delete /path/to/.codegraph/scan.lock if it is stale.
```

Stale locks (process no longer alive) are cleared automatically.

## Building a Standalone Binary

```bash
# Build for current platform
bun build --compile --minify --bytecode ./src/main.ts --outfile codegraph

# Cross-compile for all platforms
make build-all

# Package with docs and installers
bash scripts/package.sh all
```

Binaries are output to `dist/` (~85-100MB each).
