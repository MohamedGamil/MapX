# Configuration

MapxGraph stores its configuration in `.mapx/config.json`.

## Default Config

```json
{
  "version": "1.0.0",
  "repos": [
    {
      "name": "my-project",
      "path": "."
    }
  ],
  "languages": {},
  "settings": {
    "maxTokenBudget": 16384,
    "excludePatterns": [
      "node_modules/**",
      "vendor/**",
      ".git/**",
      "dist/**",
      ".mapx/**",
      "*.min.js",
      "*.min.css",
      "package-lock.json",
      "composer.lock"
    ],
    "includePatterns": []
  }
}
```

## Multi-Repo Setup

To track multiple repos or monorepo components:

```json
{
  "repos": [
    { "name": "frontend", "path": "./apps/web" },
    { "name": "backend", "path": "./apps/api" },
    { "name": "shared", "path": "./packages/shared" }
  ]
}
```

Use the workspace CLI to manage repos:

```bash
mapx workspaces add ../sibling-api --name api
mapx workspaces list
mapx workspaces discover    # find unregistered submodules, peers, VS Code folders
mapx workspaces remove api
```

## User-Defined Languages

Add custom language support without modifying the tool. Since Python is already built-in, here's an example with a hypothetical language:

```json
{
  "languages": {
    "haskell": {
      "extensions": [".hs"],
      "grammarWasm": "./grammars/tree-sitter-haskell.wasm",
      "queries": {
        "symbols": "./queries/haskell/symbols.scm",
        "references": "./queries/haskell/references.scm"
      },
      "nodeMappings": {
        "function": "function",
        "class": "type_class_declaration",
        "module": "module"
      }
    }
  }
}
```

See [Adding Languages](adding-languages.md) for details on writing query files.

## Built-in Language Coverage

All 23 supported languages are pre-configured. No `languages` entry is needed unless you want to override defaults or add a completely new language:

| Tier | Languages | Count |
|------|-----------|-------|
| **Built-in** | PHP, JavaScript, TypeScript, Vue | 4 |
| **Bundled** | Python, Go, Rust, Java, C#, Ruby, C, C++, Swift, Kotlin, Dart, Scala, Svelte, Lua, Elixir, Zig, Bash, Fish, Pascal | 19 |

List all available languages and status with:
```bash
mapx lang list
```

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxTokenBudget` | number | 16384 | Maximum token budget for LLM export |
| `excludePatterns` | string[] | (see above) | Glob patterns for files to exclude from scanning |
| `includePatterns` | string[] | [] | If set, only include matching files |
| `graphExcludePatterns` | string[] | `["scratch/**", "benchmarks/**", "tests/**", "**/*.test.*", "**/*.spec.*"]` | Glob patterns for files to exclude from PageRank rankings and graph analysis (files are still indexed but deprioritized) |
| `laravelDefaultExcludes` | boolean \| string[] | `true` | Laravel's default excludes for repos with `"framework": "laravel"` (see below). `false` turns them off; a list applies only the patterns it names. |

Patterns match workspace-relative paths with `/` separators. A leading `./` is ignored, and `\` is read as `/`, so `./app/Models/**` and `app\Models\**` both mean `app/Models/**`. Because of this, a backslash cannot escape a glob character. Changing the patterns makes the next `scan` or `sync` re-parse every file once, so that edges into files that come back in are restored.

### Laravel default excludes

For a repo with `"framework": "laravel"`, every scan also excludes these patterns:

```
database/migrations/**  database/seeders/**  database/factories/**  storage/**
bootstrap/cache/**  public/**  resources/views/**  **/*.blade.php  vendor/**
```

When the repo is not at the workspace root, each pattern is scoped to its path (`api/public/**`). `mapx init` offers to add the same patterns to `excludePatterns`. If you decline, init records `"laravelDefaultExcludes": false`.

To drop a single default, list the ones to keep. Also remove the pattern from `excludePatterns` if init added it there. For example, to index `public/`:

```json
{
  "settings": {
    "laravelDefaultExcludes": [
      "database/migrations/**", "database/seeders/**", "database/factories/**", "storage/**",
      "bootstrap/cache/**", "resources/views/**", "**/*.blade.php", "vendor/**"
    ]
  }
}
```

## Architecture & Role Classification

MapxGraph dynamically profiles your codebase and classifies files into architectural roles. You can customize the classifier archetype, custom roles, and specific file classification overrides by adding an `architecture` section to the `settings` block in `.mapx/config.json`:

```json
{
  "settings": {
    "architecture": {
      "archetype": "web-api",
      "customRoles": [
        { "name": "billing", "paths": ["src/billing/**", "src/payments/**"] },
        { "name": "notifications", "paths": ["src/notifications/**"] }
      ],
      "overrides": {
        "src/legacy/**": "other",
        "src/graphql/resolvers/**": "api"
      }
    }
  }
}
```

### Architecture Settings Reference

| Setting | Type | Description |
|---------|------|-------------|
| `archetype` | string | Override the codebase archetype detection. Supported archetypes: `cli-tool`, `web-api`, `web-app`, `full-stack`, `library`, `monorepo`, `mobile-app`, `mixed`. |
| `customRoles` | object[] | Define new custom roles mapped to path patterns. Each entry has a `name` string and `paths` (string or array of strings). |
| `overrides` | record<string, string> | Map precise file/directory glob patterns directly to a specific dynamic role (e.g. `api`, `service`, `data`, `shared`, `other`). |

## .gitignore

The `.mapx/` directory is a local development artifact and should not be committed. During `mapx init`, the tool automatically adds `.mapx/` to `.gitignore` if:

- A `.gitignore` file already exists, or
- The project is a git repository

If the entry already exists in `.gitignore`, it is not duplicated.
