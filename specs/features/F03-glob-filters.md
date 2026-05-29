# F03 — Glob Include / Exclude Filters

| Field | Value |
|-------|-------|
| ID | F03 |
| Status | `planned` |
| Iteration | I02 |
| Branch | `feat/i02-glob-filters` |
| Depends on | — |
| Blocked by | — |

---

## Problem

The current scanner has a hard-coded exclude list (`node_modules/`, `vendor/`, `.git/`, `dist/`, `.mapx/`). Projects commonly need to exclude additional paths (migrations, seeds, test suites, generated code) or focus a scan/export on a specific sub-tree. There is no mechanism to express this per-project or per-command.

---

## Goal

Allow users to supply glob patterns to narrow what the scanner reads and what the exporter outputs:

- **Scan-time**: exclude files from being parsed and stored
- **Export-time**: filter which files appear in the output without re-scanning
- **Project-level**: persist defaults in `.mapx/config.json` so they apply to every command automatically
- **CLI-level**: override or extend per command invocation

---

## CLI Specification

### `mapx scan`

```bash
mapx scan [path] [--exclude <glob,...>] [--include <glob,...>]
```

### `mapx update`

```bash
mapx update [path] [--exclude <glob,...>] [--include <glob,...>]
```

### `mapx export`

```bash
mapx export [--dir <path>] [--exclude <glob,...>] [--include <glob,...>] [--format ...]
```

### Pattern syntax

- Patterns follow [picomatch](https://github.com/micromatch/picomatch) glob syntax.
- Multiple patterns are comma-separated or supplied via multiple flag repetitions:
  ```bash
  mapx scan --exclude="**/migrations/**,**/tests/**"
  mapx scan --exclude "**/migrations/**" --exclude "**/tests/**"
  ```
- Patterns are matched against the **relative path** from the project root.
- `--include` is an allowlist: if any `--include` pattern is provided, only files matching at least one include pattern are processed.
- `--exclude` takes precedence over `--include` (a file matching both is excluded).

### Examples

```bash
# Exclude test directories and migrations
mapx scan --exclude "**/tests/**,**/migrations/**,**/seeds/**"

# Focus export on a specific service layer
mapx export --include "**/app/Services/**" --format=llm

# Exclude generated proto files
mapx scan --exclude "**/*.pb.ts,**/generated/**"
```

---

## Config File Integration

Patterns can be persisted in `.mapx/config.json` under `settings`:

```json
{
  "settings": {
    "excludePatterns": [
      "node_modules/**",
      "vendor/**",
      ".git/**",
      "dist/**",
      ".mapx/**",
      "**/migrations/**",
      "**/tests/**"
    ],
    "includePatterns": []
  }
}
```

CLI flags **extend** (not replace) the config-level patterns unless `--no-config-patterns` is passed.

### `mapx init` interaction

`mapx init` should prompt (or accept a flag) to set initial exclude patterns during project setup. Common suggestions based on detected languages:

| Detected language | Suggested excludes |
|-------------------|--------------------|
| PHP | `**/migrations/**`, `**/seeds/**`, `**/storage/**` |
| TypeScript/JS | `**/dist/**`, `**/__tests__/**`, `**/*.test.ts`, `**/*.spec.ts` |

---

## Technical Implementation

### Pattern compilation

Compile all active patterns into a single `(path: string) => boolean` predicate before the directory walk begins. Use [picomatch](https://github.com/micromatch/picomatch).

```typescript
// src/core/scanner.ts
import picomatch from 'picomatch';

function buildMatcher(excludes: string[], includes: string[]): (rel: string) => boolean {
  return (rel: string) => {
    if (excludes.some(p => {
      if (picomatch.isMatch(rel, p, { dot: true })) return true;
      const segments = rel.split('/');
      if (segments.some(seg => seg === p)) return true;
      return false;
    })) {
      return false;
    }
    if (includes.length > 0) {
      const matched = includes.some(p => {
        if (picomatch.isMatch(rel, p, { dot: true })) return true;
        const segments = rel.split('/');
        if (segments.some(seg => seg === p)) return true;
        return false;
      });
      if (!matched) return false;
    }
    return true;
  };
}
```

### Scanner integration

Pass the compiled matcher into `walkDirectory`. Skip any path where `matcher(relativePath)` returns `false` — **before** calling `fs.readFile`.

The existing hard-coded skip list (entries starting with `.`, `node_modules`, etc.) remains as a fast-path check executed before the glob matcher, since it is cheaper than glob evaluation for the common case.

### Export integration

The LLM, JSON, DOT, and SVG exporters accept an optional `files` filter in `ExportOptions` (the field already exists on the type). When `--include`/`--exclude` flags are passed to `mapx export`, they are resolved to a filtered file list from the store and passed through `ExportOptions.files`.

---

## `mapx config` command (stretch goal, not in I02)

A future `mapx config set excludePatterns "..."` command to manage config values interactively is out of scope for this iteration but should be noted as a natural follow-on.

---

## Acceptance Criteria

- [ ] `mapx scan --exclude <glob>` skips matching files; they do not appear in the DB
- [ ] `mapx scan --include <glob>` only processes matching files
- [ ] `mapx export --exclude / --include` filters output without re-scanning
- [ ] Comma-separated and repeated-flag forms both work
- [ ] Config-level `excludePatterns` / `includePatterns` are respected by default
- [ ] CLI flag patterns extend (not replace) config-level patterns
- [ ] Hard-coded fast-path skips remain in place and still apply
- [ ] `mapx status` shows active exclude/include patterns
- [ ] TypeScript type-check passes
- [ ] Tested: excluded path does not appear in `mapx export` output after scan

---

## Out of Scope for F03

- Interactive `mapx config` management command
- Negation patterns (e.g. `!**/foo/**`) — deferred until there is a clear use-case
- Per-language include/exclude overrides — deferred
