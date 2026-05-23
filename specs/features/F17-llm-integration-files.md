# F17 — LLM Agent Integration Files

| Field | Value |
|-------|-------|
| ID | F17 |
| Status | `planned` |
| Iteration | I09 |
| Branch | `feat/i09-llm-integration-files` |
| Depends on | — (independent; richer with F17-context after F18/F19 if search/context features land) |
| Blocked by | — |

---

## Problem

When a user installs mapx in a project, their LLM has no way to know mapx is available. Every conversation starts from scratch: "what is mapx?", "how do I get a code summary?", "can I use it through MCP?".

Additionally:
- Different LLM tools consume guidance files at different paths and in different formats — there is no universal file
- The existing `AGENTS.md` in the mapx repo is self-referential (it teaches LLMs about the mapx codebase, not about using mapx in someone else's project)
- Provider-specific features (MCP config blocks, MDC frontmatter, slash command registration) require per-provider content that can't live in a single generic file
- Keeping these files up-to-date manually across user projects does not scale

---

## Goal

1. Implement `AgentGenerator` — generates provider-specific LLM integration files from internal templates
2. Add `mapx agents` CLI subcommand group: `generate`, `list`, `update`
3. Integrate provider selection into the `mapx init` workflow
4. Ship templates for all major LLM/agentic tools
5. Version-stamp generated files so `mapx agents update` can detect and refresh stale content

---

## Provider support matrix

| Provider | Output file | Format | MCP config | Notes |
|----------|------------|--------|-----------|-------|
| Generic / Amp / Devin / OpenCode | `AGENTS.md` | Markdown | CLI workflow only | Canonical template |
| Claude Desktop | `CLAUDE.md` | Markdown | ✓ stdio + SSE blocks | CLAUDE.md is loaded by Claude projects |
| Cursor | `.cursor/rules/mapx.mdc` | MDC (YAML frontmatter + markdown) | ✓ `.cursor/mcp.json` reference | `alwaysApply: false`; triggered on any file |
| GitHub Copilot | `.github/copilot-instructions.md` | Markdown | — (MCP via VS Code settings) | Appended to existing file |
| Windsurf | `.windsurf/rules/mapx.md` | Markdown with frontmatter | ✓ `.windsurf/mcp_config.json` reference | `trigger: model_decided` |
| Cline | `.clinerules` | Markdown | ✓ VS Code MCP settings reference | Appended to existing |
| Aider | `AIDER.md` | Markdown | — (Aider is CLI-only) | CLI workflow + `--read` flag note |
| Gemini CLI | `GEMINI.md` | Markdown | — | CLI workflow |
| Continue | `.continue/mapx.yaml` | YAML | ✓ context provider block | Slash command registration |
| Zed | `.zed/mapx-instructions.md` | Markdown | — | `assistant.default_context` path |

---

## Template system

### Location in source tree

```
src/agents/
├── templates/
│   ├── AGENTS.md.template
│   ├── CLAUDE.md.template
│   ├── cursor-rule.mdc.template
│   ├── copilot-instructions.template
│   ├── windsurf-rule.template
│   ├── clinerules.template
│   ├── AIDER.md.template
│   ├── GEMINI.md.template
│   ├── continue-provider.yaml.template
│   └── zed-instructions.template
└── agent-generator.ts
```

Templates are plain text files bundled at build time into the binary via `import.meta.glob` (Bun) or embedded via `fs.readFileSync` at build (Node). They are **not** fetched at runtime.

### Template variable substitutions

| Variable | Replaced with | Example |
|----------|--------------|---------|
| `{{PROJECT_NAME}}` | Directory base name of target project | `my-app` |
| `{{PROJECT_DIR}}` | Absolute path to target project | `/home/user/my-app` |
| `{{MAPX_VERSION}}` | Installed mapx version from `package.json` | `0.1.6` |
| `{{MCP_PORT}}` | SSE port (default 45123, override with `--mcp-port`) | `45123` |
| `{{MAPX_BIN}}` | Resolved path to mapx binary (`which mapx`) | `/usr/local/bin/mapx` |
| `{{TIMESTAMP}}` | ISO-8601 generation timestamp | `2026-05-22T10:00:00Z` |

---

## Template content specification

Each template shares a **common content core** wrapped in `<!-- mapx VERSION -->` / `<!-- /mapx -->` sentinel comments. The sentinel is always the outermost wrapper so update detection works regardless of provider-specific additions outside the block.

### Common core (all templates)

```markdown
<!-- mapx {{MAPX_VERSION}} -->
# MapxGraph — Code Intelligence for Your LLM

**MapxGraph** scans source files and builds a persistent, queryable code graph —
symbols, dependencies, and PageRank scores — stored in `.mapx/`. Use it to get
fast, token-efficient codebase context without reading every file.

## Discovery

Before answering questions about this codebase, check if the index exists:

```bash
mapx status          # show index health, file count, last scan date
```

If the index is missing or stale, run:

```bash
mapx scan            # full scan (first time or after major changes)
mapx update          # incremental: only re-scan changed files (fast)
```

## Session start

At the start of a task involving this codebase, run:

```bash
mapx export          # compact LLM summary (~8K tokens)
mapx export --tokens=16384  # larger budget when needed
```

This gives you the top-ranked files, key symbols, and dependency map — without
reading every file.

## Targeted lookups

```bash
mapx query <SymbolName>        # find where a class/function is defined
mapx deps <file-path>          # show what a file imports and what imports it
mapx summary                   # high-level stats: files, symbols, edge counts
```

## After editing files

After changing source files, refresh the index before asking questions:

```bash
mapx update          # fast incremental refresh
```

## Reference

Full documentation: https://github.com/YourOrg/mapx
<!-- /mapx -->
```

### Provider-specific sections

Each template prepends or appends provider-specific content **outside** the common core, or adds syntax wrappers (frontmatter, YAML, etc.).

---

### `AGENTS.md` template

Identical to the common core. No additions. Used for Generic, Amp, Devin, OpenCode.

---

### `CLAUDE.md` template

Prepends a Claude-specific header and appends an MCP configuration block:

```markdown
# Instructions for Claude

{{COMMON_CORE}}

## MCP Server (recommended)

Instead of CLI commands, you can use mapx as an MCP server for direct tool access:

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "mapx": {
      "command": "{{MAPX_BIN}}",
      "args": ["serve", "--dir", "{{PROJECT_DIR}}"]
    }
  }
}
```

### Available MCP tools

| Tool | Purpose |
|------|---------|
| `mapx_scan` | Scan or incrementally update the index |
| `mapx_export` | Get compact LLM summary |
| `mapx_query` | Search symbols by name |
| `mapx_dependencies` | Get imports/importers for a file |
| `mapx_status` | Check index health |

**Workflow**: call `mapx_export` at session start, then `mapx_query` or `mapx_dependencies` for targeted lookups. Call `mapx_scan` only when the index is missing.
```

---

### Cursor MDC template (`.cursor/rules/mapx.mdc`)

```markdown
---
description: "MapxGraph code intelligence — use these commands to explore the codebase graph"
globs:
  - "**/*"
alwaysApply: false
---

{{COMMON_CORE}}

## MCP (Cursor native)

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mapx": {
      "command": "{{MAPX_BIN}}",
      "args": ["serve", "--dir", "{{PROJECT_DIR}}"]
    }
  }
}
```

When MCP is configured, prefer MCP tools (`mapx_export`, `mapx_query`, `mapx_dependencies`) over running CLI commands directly.
```

---

### GitHub Copilot template (`.github/copilot-instructions.md`)

The generator checks if `.github/copilot-instructions.md` already exists. If it does, the `<!-- mapx -->` block is **appended** to the existing file rather than replacing it. If it does not exist, the file is created with the common core only (no MCP block — Copilot uses VS Code settings for MCP).

```markdown
{{COMMON_CORE}}
```

When appending to an existing file, the generator adds a horizontal rule separator:

```markdown

---

{{COMMON_CORE}}
```

---

### Windsurf template (`.windsurf/rules/mapx.md`)

```markdown
---
trigger: model_decided
description: "MapxGraph code intelligence tools"
---

{{COMMON_CORE}}

## MCP (Windsurf native)

Add to `.windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mapx": {
      "command": "{{MAPX_BIN}}",
      "args": ["serve", "--dir", "{{PROJECT_DIR}}"]
    }
  }
}
```
```

---

### Cline template (`.clinerules`)

If `.clinerules` exists, the `<!-- mapx -->` block is appended. Otherwise, the file is created.

```markdown
{{COMMON_CORE}}

## MCP (Cline)

Configure in VS Code MCP settings (`settings.json`):

```json
{
  "mcp": {
    "servers": {
      "mapx": {
        "type": "stdio",
        "command": "{{MAPX_BIN}}",
        "args": ["serve", "--dir", "{{PROJECT_DIR}}"]
      }
    }
  }
}
```
```

---

### Aider template (`AIDER.md`)

```markdown
# MapxGraph Instructions for Aider

{{COMMON_CORE}}

## Using with Aider

Aider does not support MCP. Use mapx via CLI and pass the output to Aider:

```bash
# Generate a code summary and pipe into aider context
mapx export > /tmp/mapx-context.txt
aider --read /tmp/mapx-context.txt <your-files>

# Or query a specific symbol first
mapx query MyClass
mapx deps app/Services/UserService.php
```

To include the mapx summary automatically in every aider session, add to `.aider.conf.yml`:

```yaml
read:
  - /tmp/mapx-context.txt
```

Then run `mapx export > /tmp/mapx-context.txt` before starting aider.
```

---

### Gemini CLI template (`GEMINI.md`)

```markdown
# MapxGraph Instructions for Gemini

{{COMMON_CORE}}
```

---

### Continue provider template (`.continue/mapx.yaml`)

YAML, not markdown. Registers mapx export as a slash command and context provider:

```yaml
# MapxGraph context provider for Continue
# Generated by mapx {{MAPX_VERSION}} on {{TIMESTAMP}}

name: mapx
description: "MapxGraph code intelligence"
version: "{{MAPX_VERSION}}"

contextProviders:
  - name: mapx-summary
    description: "Get compact code graph summary for this project"
    type: command
    command: "{{MAPX_BIN}} export --dir {{PROJECT_DIR}}"

slashCommands:
  - name: mapx-update
    description: "Update the mapx code index after file changes"
    command: "{{MAPX_BIN}} update --dir {{PROJECT_DIR}}"
  - name: mapx-query
    description: "Search for a symbol in the code graph"
    command: "{{MAPX_BIN}} query {{input}} --dir {{PROJECT_DIR}}"
```

---

### Zed template (`.zed/mapx-instructions.md`)

Plain markdown; path is added to `assistant.default_context` in `.zed/settings.json` (the generator updates this file):

```markdown
{{COMMON_CORE}}
```

The generator also runs:
```json
// .zed/settings.json — merged (not replaced)
{
  "assistant": {
    "default_context": [".zed/mapx-instructions.md"]
  }
}
```

---

## `AgentGenerator` class

New file: `src/agents/agent-generator.ts`

```typescript
export type Provider =
  | 'generic'     // AGENTS.md
  | 'claude'      // CLAUDE.md
  | 'cursor'      // .cursor/rules/mapx.mdc
  | 'copilot'     // .github/copilot-instructions.md
  | 'windsurf'    // .windsurf/rules/mapx.md
  | 'cline'       // .clinerules
  | 'aider'       // AIDER.md
  | 'gemini'      // GEMINI.md
  | 'continue'    // .continue/mapx.yaml
  | 'zed';        // .zed/mapx-instructions.md

export type WriteMode =
  | 'create'      // file doesn't exist — create it
  | 'replace'     // file exists with <!-- mapx --> block — replace block
  | 'append'      // file exists without <!-- mapx --> block — append block
  | 'skip';       // file exists, user chose not to update

export interface GenerateOptions {
  projectDir: string;
  providers: Provider[] | 'all';
  dryRun?: boolean;           // default false
  force?: boolean;            // default false — skip confirmation prompts
  mcpPort?: number;           // default 45123
  interactive?: boolean;      // default true
}

export interface GenerateResult {
  provider: Provider;
  outputPath: string;
  mode: WriteMode;
  written: boolean;
}

export class AgentGenerator {
  constructor(private version: string) {}

  generate(options: GenerateOptions): Promise<GenerateResult[]> { ... }
  list(projectDir: string): Promise<GenerateResult[]> { ... }
  update(projectDir: string, options: Omit<GenerateOptions, 'providers'>): Promise<GenerateResult[]> { ... }

  private renderTemplate(provider: Provider, vars: TemplateVars): string { ... }
  private detectWriteMode(provider: Provider, projectDir: string): WriteMode { ... }
  private extractMapxBlock(content: string): { block: string; version: string } | null { ... }
  private replaceMapxBlock(content: string, newBlock: string): string { ... }
  private appendMapxBlock(content: string, newBlock: string): string { ... }
}
```

---

## `mapx agents` CLI commands

### `mapx agents generate [dir]`

```
mapx agents generate [dir] [options]

Generate LLM integration files for one or more providers.

Options:
  --providers <list>   Comma-separated provider names, or "all" (default: interactive selection)
  --dry-run            Show what would be written without writing
  --force              Overwrite without confirmation
  --mcp-port <n>       SSE port for MCP config blocks (default: 45123)
  --dir <path>         Target project directory (default: cwd)
```

**Interactive mode** (default when no `--providers` given):

```
Which LLM/agent tools do you use in this project?
(Space to select, Enter to confirm, Esc to skip)

◉ Generic (AGENTS.md)                          works with most tools
○ Claude Desktop (CLAUDE.md)
○ Cursor (.cursor/rules/mapx.mdc)
○ GitHub Copilot (.github/copilot-instructions.md)
○ Windsurf (.windsurf/rules/mapx.md)
○ Cline (.clinerules)
○ Aider (AIDER.md)
○ Gemini CLI (GEMINI.md)
○ Continue (.continue/mapx.yaml)
○ Zed (.zed/mapx-instructions.md)
○ All providers
```

**Output after generation:**

```
Generated LLM integration files:

  ✓ AGENTS.md                                  created
  ✓ CLAUDE.md                                  created
  ✓ .cursor/rules/mapx.mdc                     created  (directory created)
  ✓ .github/copilot-instructions.md            appended  (existing file)
  ✗ .clinerules                                skipped   (user declined)

Run `mapx agents list` to see all generated files.
Run `mapx agents update` to refresh files when mapx is updated.
```

---

### `mapx agents list [dir]`

```
mapx agents list [dir]

List all mapx-generated LLM integration files found in the project directory.
```

**Output:**

```
LLM integration files in /path/to/project:

  AGENTS.md                                   mapx v0.1.6   ✓ current
  CLAUDE.md                                   mapx v0.1.5   ✗ outdated  (run `mapx agents update`)
  .cursor/rules/mapx.mdc                      mapx v0.1.6   ✓ current
  .github/copilot-instructions.md             mapx v0.1.6   ✓ current (appended block)

4 files found. 1 outdated.
```

The command detects the `<!-- mapx VERSION -->` sentinel in files and compares to the installed version.

---

### `mapx agents update [dir]`

```
mapx agents update [dir] [options]

Refresh outdated mapx blocks in LLM integration files.

Options:
  --force         Overwrite without confirmation even if content was manually edited
  --dry-run       Show diff without writing
  --dir <path>    Target project directory (default: cwd)
```

**Behaviour:**

1. Run `mapx agents list` to discover all generated files
2. For each file where the version is older than installed:
   - Show a diff of the `<!-- mapx -->` block (old vs new)
   - Prompt: `Update CLAUDE.md? [Y/n]` (default: Y)
   - If confirmed: replace the `<!-- mapx -->` block in-place
3. Preserve all content outside the `<!-- mapx -->` block

---

## Integration with `mapx init`

After the existing init steps (create `.mapx/`, write config), `mapx init` adds:

```
  Optional: Generate LLM integration files?

  mapx can create files for your LLM/agent tools so they know how to use
  the code graph. This is a one-time step — run `mapx agents generate`
  later to add more.

  Which tools do you use? (Space to select, Enter to skip)
  ...
```

If the user presses Enter/Esc without selecting, generation is skipped silently. The prompt only appears during interactive init (i.e., stdin is a TTY). `mapx init --no-agents` skips the prompt entirely.

---

## Update detection details

The sentinel comment format:

```
<!-- mapx 0.1.6 2026-05-22T10:00:00Z -->
```

Version + timestamp in the opening comment. The update command parses this with a regex:

```
/<!--\s*mapx\s+([\d.]+)\s+([^\s>]+)\s*-->/
```

Content between `<!-- mapx ... -->` and `<!-- /mapx -->` is the managed block. Content outside these markers is untouched by `mapx agents update`.

### Manual edit detection

If the content inside the block differs from what mapx would generate today (even at the same version), the file is flagged as "manually edited" in `mapx agents list`:

```
  CLAUDE.md    mapx v0.1.6   ✓ current  (⚠ manually edited — update will show diff)
```

`mapx agents update` on a manually edited file always shows the diff and prompts, even if `--force` is passed (safety measure).

---

## MCP config generation details

For MCP-capable providers, the generator includes ready-to-use config stanzas using the resolved `MAPX_BIN` path. Both stdio and SSE variants are included:

**stdio (default — for local use):**
```json
{
  "mcpServers": {
    "mapx": {
      "command": "/usr/local/bin/mapx",
      "args": ["serve", "--dir", "/path/to/project"]
    }
  }
}
```

**SSE (for remote or multi-client use):**
```json
{
  "mcpServers": {
    "mapx": {
      "url": "http://localhost:45123/sse"
    }
  }
}
```

The SSE block is included as a commented alternative, not the default, since it requires running `mapx serve --sse` as a persistent process.

---

## New source files

```
src/agents/
├── templates/
│   ├── AGENTS.md.template
│   ├── CLAUDE.md.template
│   ├── cursor-rule.mdc.template
│   ├── copilot-instructions.template
│   ├── windsurf-rule.template
│   ├── clinerules.template
│   ├── AIDER.md.template
│   ├── GEMINI.md.template
│   ├── continue-provider.yaml.template
│   └── zed-instructions.template
└── agent-generator.ts
```

## Modified source files

```
src/cli.ts          ← add `mapx agents` subcommand group
src/main.ts         ← (if MCP tool mapx_agents_generate is added — deferred)
```

---

## Acceptance Criteria

- [ ] `mapx agents generate --providers=generic` creates `AGENTS.md` with correct content and sentinel
- [ ] `mapx agents generate --providers=claude` creates `CLAUDE.md` with MCP config block
- [ ] `mapx agents generate --providers=cursor` creates `.cursor/rules/mapx.mdc` with MDC frontmatter
- [ ] `mapx agents generate --providers=copilot` appends to existing `.github/copilot-instructions.md` without destroying existing content
- [ ] `mapx agents generate --providers=copilot` creates `.github/copilot-instructions.md` when it doesn't exist
- [ ] `mapx agents generate --providers=windsurf` creates `.windsurf/rules/mapx.md` with `trigger:` frontmatter
- [ ] `mapx agents generate --providers=cline` appends to `.clinerules` or creates it
- [ ] `mapx agents generate --providers=aider` creates `AIDER.md` with Aider-specific workflow notes
- [ ] `mapx agents generate --providers=gemini` creates `GEMINI.md`
- [ ] `mapx agents generate --providers=continue` creates `.continue/mapx.yaml` as valid YAML
- [ ] `mapx agents generate --providers=zed` creates `.zed/mapx-instructions.md` and patches `.zed/settings.json`
- [ ] `mapx agents generate --providers=all` generates all 10 provider files
- [ ] `mapx agents generate --dry-run` prints what would be written, writes nothing
- [ ] `mapx agents generate --force` overwrites without prompts
- [ ] `mapx agents list` detects all generated files and reports version + current/outdated
- [ ] `mapx agents update` replaces stale `<!-- mapx -->` blocks, preserves surrounding content
- [ ] `mapx agents update` shows diff and prompts before overwriting manually edited blocks
- [ ] `mapx init` interactive mode offers provider selection step
- [ ] `mapx init --no-agents` skips provider selection
- [ ] All template variables (`{{PROJECT_NAME}}`, `{{MAPX_BIN}}`, etc.) are substituted correctly
- [ ] `{{MAPX_BIN}}` resolves to actual binary path (`which mapx` equivalent)
- [ ] Generated files contain correct `<!-- mapx VERSION TIMESTAMP -->` sentinel
- [ ] TypeScript type-check passes with 0 errors

---

## Out of Scope for F17

- VS Code `settings.json` injection for Copilot MCP (provider-specific tooling detail, deferred)
- Remote template sync / CDN-hosted templates
- User-overridable template hooks
- `mapx_agents_generate` MCP tool (deferred — security consideration: MCP tools writing files needs careful scoping)
- Auto-commit generated files to git
- Per-provider "test" command to verify the LLM picks up the file (runtime verification)
