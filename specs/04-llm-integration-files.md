# LLM Integration Files — Overview

This document describes mapx's strategy for generating **provider-specific LLM integration files** — markdown (and config) files that teach each major LLM and agentic coding tool how to discover, configure, and use mapx for a given project.

---

## Problem

mapx already ships `AGENTS.md` for its own repository, which teaches LLMs how to use the tool. However:

1. Users who install mapx in their own projects get no equivalent guidance file — their LLM has no idea mapx is available unless they manually write instructions.
2. Different LLM providers and agentic coding tools consume guidance files in different locations and formats — Claude reads `CLAUDE.md`, Cursor reads `.cursor/rules/*.mdc` with YAML frontmatter, GitHub Copilot reads `.github/copilot-instructions.md`, etc.
3. The content of these files needs to stay up to date as mapx evolves. Manual maintenance across dozens of user projects is impractical.
4. The AGENTS.md template shipped with mapx only covers CLI usage — each provider needs tailored content covering MCP configuration, provider-specific syntax, and tool-calling workflows.

---

## Solution: `mapx agents`

A new `mapx agents` command that generates, lists, and updates provider-specific LLM integration files for a target project. Files are derived from a set of **provider templates** maintained inside mapx's own source tree under `src/agents/`.

During `mapx init`, the user is offered an interactive selection of providers to generate files for. Afterwards, `mapx agents update` refreshes stale files when mapx gets new capabilities.

---

## Supported Providers

| Provider / Tool | Integration File | Notes |
|----------------|-----------------|-------|
| **Claude Desktop** (Anthropic) | `CLAUDE.md` | Plain markdown; MCP config block included |
| **Cursor** | `.cursor/rules/mapx.mdc` | MDC format with YAML frontmatter (`alwaysApply: false`; triggered by glob) |
| **GitHub Copilot** | `.github/copilot-instructions.md` | Plain markdown; appended to existing file if present |
| **Windsurf** (Codeium) | `.windsurf/rules/mapx.md` | Markdown with `trigger: always` frontmatter |
| **Cline** | `.clinerules` | Plain markdown; appended to existing file |
| **Aider** | `AIDER.md` | Plain markdown; CLI workflow focused |
| **Gemini CLI** | `GEMINI.md` | Plain markdown |
| **Amp** | `AGENTS.md` | Same content as generic `AGENTS.md` |
| **OpenCode** | `AGENTS.md` | Same content as generic `AGENTS.md` |
| **Devin** | `AGENTS.md` | Same content as generic `AGENTS.md` |
| **Continue** | `.continue/mapx.yaml` | YAML context provider registration |
| **Zed** | `.zed/mapx-instructions.md` | Plain markdown; loaded via `assistant.default_context` |
| **Generic / Custom** | `AGENTS.md` | Canonical template; all others are derived from this |

---

## Content Architecture

All provider files share a **common content core** derived from the project's installed docs + AGENTS.md. Provider-specific wrappers add the syntax, frontmatter, or config stanzas each tool requires.

### Common content sections

1. **Identity block** — `<!-- mapx -->` / `<!-- /mapx -->` sentinel comments (for update detection)
2. **What mapx is** — one-sentence description + link to docs
3. **Discovery check** — detect if `.mapx/` exists; run `mapx status` to verify index health
4. **Session start workflow** — `mapx export` to get the graph summary
5. **Key CLI commands** — query, deps, update, summary
6. **MCP configuration** (MCP-capable providers only) — copy-paste JSON/YAML config stanza
7. **Tool-calling workflow** (MCP providers only) — sequence: `mapx_scan` → `mapx_export` → `mapx_query` → `mapx_dependencies`
8. **When to update the index** — "after editing files, run `mapx update` before asking questions about the codebase"
9. **Token budget guidance** — `--tokens` flag for larger contexts

### Provider-specific additions

- **Cursor MDC**: `alwaysApply: false`, `globs: ["**/*"]`, `description:` field
- **Copilot**: appended under existing instructions rather than separate file
- **Windsurf**: `trigger: model_decided` frontmatter
- **Continue**: YAML provider block with `mapx export` as a slash command
- **Cline**: `.clinerules` markdown with Cline-specific note about MCP server auto-start

---

## Template Source Structure

```
src/agents/
├── templates/
│   ├── AGENTS.md.template           ← canonical; all others derive from this
│   ├── CLAUDE.md.template
│   ├── cursor-rule.mdc.template
│   ├── copilot-instructions.template
│   ├── windsurf-rule.template
│   ├── clinerules.template
│   ├── AIDER.md.template
│   ├── GEMINI.md.template
│   ├── continue-provider.yaml.template
│   └── zed-instructions.template
└── agent-generator.ts               ← AgentGenerator class
```

Templates use a minimal substitution syntax: `{{PROJECT_NAME}}`, `{{MAPX_VERSION}}`, `{{PROJECT_DIR}}`, `{{MCP_PORT}}` (for SSE configs).

---

## Relationship to `mapx init`

The F17 work intersects with the `mapx init` workflow improvement (tracked separately). After the basic init completes, the user is presented with an optional provider selection:

```
  Which LLM/agent tools do you use in this project?
  (Space to select, Enter to confirm, Esc to skip)

  ◉ Generic (AGENTS.md)           — works with most tools
  ○ Claude Desktop (CLAUDE.md)
  ○ Cursor (.cursor/rules/mapx.mdc)
  ○ GitHub Copilot (.github/copilot-instructions.md)
  ○ Windsurf (.windsurf/rules/mapx.md)
  ○ Cline (.clinerules)
  ○ Aider (AIDER.md)
  ○ Gemini CLI (GEMINI.md)
  ○ All providers
```

The user can re-run `mapx agents generate` at any time outside of init.

---

## Update Detection

Each generated file includes:
```markdown
<!-- mapx v0.1.6 -->
...content...
<!-- /mapx -->
```

`mapx agents update` reads the version comment in each file. If the installed mapx version is newer than the version recorded in the file, the user is prompted to update (interactive; default: yes).

If the user has manually edited content inside the `<!-- mapx -->` block, the update shows a diff and prompts for confirmation before overwriting.

---

## Scope

### In scope for F17

- All provider templates listed above
- `mapx agents generate`, `mapx agents list`, `mapx agents update` CLI commands
- `mapx init` integration (provider selection step)
- Version sentinel comment in generated files
- `--providers=<list>` and `--all` flags
- `--dry-run` flag (show what would be written, no writes)
- `--force` flag (overwrite without confirmation)
- MCP JSON config stanzas for stdio and SSE transports
- Continue YAML provider block

### Out of scope for F17

- IDE plugin/extension generation (VS Code `.vscode/` settings injection — deferred)
- Automatic git commit of generated files
- Remote template synchronisation (pulling latest templates from mapx CDN)
- Per-project customisation hooks (user-provided template overrides — deferred)
- OpenAI ChatGPT / GPT4-Turbo — no project-level instruction file mechanism
