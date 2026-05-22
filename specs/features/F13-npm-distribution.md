# F13 — npm Distribution & Node.js Developer Experience

| Field | Value |
|-------|-------|
| ID | F13 |
| Status | `planned` |
| Iteration | I07 |
| Branch | `feat/i07-npm-distribution` |
| Depends on | — (independent of F01–F12) |
| Blocked by | — |

---

## Problem

mapx is currently distributed as pre-compiled native binaries (Linux/macOS/Windows) via shell/PowerShell self-extracting installers. This is appropriate for end users who want the fastest runtime, but it creates unnecessary friction for the largest segment of potential adopters: **Node.js developers**.

A developer working on a Node.js or TypeScript project already has Node.js installed. For them, the expected installation experience is:

```bash
npm install -g mapx        # permanent global install
# or
npx mapx scan              # zero-install, run immediately
```

Instead they must currently:
1. Visit the GitHub releases page
2. Download the correct architecture-specific binary
3. Make it executable
4. Move it to a directory on `$PATH`

This friction is a significant adoption barrier. npm/npx distribution eliminates it entirely.

---

## Current architecture (relevant to this feature)

Understanding the existing code is critical before designing the build pipeline.

### Runtime detection (already handled)

`src/core/store.ts` already selects the correct SQLite backend at runtime:

```typescript
const isBun = typeof (globalThis as any).Bun !== 'undefined';
if (isBun) {
  const { BunStore } = dynamicRequire('./store-bun.js');  // uses bun:sqlite
  return new BunStore(dbPath);
}
const { NodeStore } = dynamicRequire('./store-node.js'); // uses better-sqlite3
return new NodeStore(dbPath);
```

The `NodeStore` (using `better-sqlite3`) path already exists and works — it just needs `better-sqlite3` to be installed, which npm will handle automatically.

### WASM asset resolution (needs fixing for npm)

`src/parsers/wasm-parser.ts` uses `findAssetRoot()` to locate `wasm/` and `queries/` directories:

```typescript
function findAssetRoot(): string {
  if (existsSync(__thisFile)) {
    // Source/dev mode: navigate up from src/parsers/wasm-parser.ts → project root
    return resolve(dirname(__thisFile), '..', '..');
  }
  // Compiled binary mode: search relative to process.execPath
  ...
}
```

**Problem**: When installed via npm and transpiled to `dist/parsers/wasm-parser.js`, `existsSync(__thisFile)` returns `true` (the file exists), but `resolve(dirname(__thisFile), '..', '..')` navigates from `dist/parsers/` → `dist/` → `package_root/`. Going up 2 directories from `dist/parsers/` correctly reaches `package_root/` — which is where `wasm/` lives. ✓

This means the current source-mode path detection already works for a transpiled-but-structure-preserving build. The npm build **must preserve the directory structure** (transpile, not bundle into a single file) to keep this path resolution valid.

### `bin` entry (needs updating)

Current `package.json`:
```json
"bin": { "mapx": "./src/main.ts" }
```

This relies on Bun (or tsx) being installed to execute TypeScript directly. For npm, the `bin` entry must point to a compiled `.js` file with a `#!/usr/bin/env node` shebang.

---

## Goal

1. Add a Node.js-compatible **npm build pipeline** that transpiles TypeScript to JavaScript, preserving directory structure, producing a `dist/` output compatible with Node.js ≥ 18
2. Update `package.json` to point `bin` to the compiled entry, include the correct `files`, declare `engines`, and promote `better-sqlite3` to a real dependency
3. Fix WASM asset lookup to handle all three execution contexts: source (tsx/bun dev), compiled binary (bun build --compile), and npm-installed package
4. Provide a **step-by-step publishing action plan** to the npm registry
5. Ensure `npx mapx` works out of the box with zero prior installation

---

## Strategy: transpile, do not bundle

Two options exist for npm distribution:

| Option | Description | Verdict |
|--------|-------------|---------|
| **Single-file bundle** | esbuild/tsup bundles all source into `dist/main.js` | ❌ Breaks WASM path resolution; can't bundle `better-sqlite3` native addon |
| **Transpile preserving structure** | TypeScript → JavaScript, same directory layout | ✓ WASM path math works; native modules stay external |

The transpile approach is selected. `dist/` mirrors `src/`:

```
dist/
├── main.js            ← compiled entry point (with shebang)
├── cli.js
├── mcp.js
├── types.js
├── core/
│   ├── store.js
│   ├── store-bun.js   ← never runs in Node.js; harmless to ship
│   ├── store-node.js
│   └── ...
├── parsers/
│   ├── wasm-parser.js ← resolves wasm/ correctly (2 dirs up = package root)
│   └── ...
└── ...
```

---

## Step 1 — Build tooling

### Add `tsup` as devDependency

`tsup` is the standard TypeScript CLI build tool. It wraps esbuild and handles:
- Shebang injection on the entry point
- CommonJS/ESM output
- Preserving module structure with `--no-bundle`
- Stripping TypeScript in one pass

```bash
npm install -D tsup
```

### Add `tsup.config.ts`

```typescript
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/**/*.ts'],   // transpile all source files (preserves structure)
  format: ['esm'],          // keep ESM ("type": "module" in package.json)
  outDir: 'dist',
  bundle: false,            // CRITICAL: preserve directory structure, not single bundle
  clean: true,              // clean dist/ before each build
  banner: {
    js: (info) =>
      info.path.endsWith('/main.js') ? '#!/usr/bin/env node' : '',
  },
  // Do NOT externalize — all imports are already .js paths that tsup resolves correctly
  // better-sqlite3 and bun:sqlite are dynamicRequire'd at runtime; tsup won't bundle them
});
```

**Shebang note**: The `banner` function adds `#!/usr/bin/env node` only to `dist/main.js`. npm uses this shebang to set executable permissions and the runtime when symlinking the binary.

### Add build script to `package.json`

```json
"scripts": {
  "build:npm": "tsup",
  "prepublishOnly": "npm run build:npm"
}
```

`prepublishOnly` automatically runs the npm build before every `npm publish`, ensuring the `dist/` is always up to date.

---

## Step 2 — `package.json` changes

### Full diff

```json
{
  "name": "mapx",
  "version": "0.1.6",
  "license": "Apache-2.0",
  "description": "Multi-language code graph memory system for LLMs",

  "bin": {
    "mapx": "./dist/main.js"
  },

  "files": [
    "dist/",
    "wasm/",
    "queries/",
    "VERSION",
    "README.md",
    "LICENSE"
  ],

  "engines": {
    "node": ">=20.0.0"
  },

  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "commander": "^13.1.0",
    "graphology": "^0.26.0",
    "graphology-metrics": "^2.4.0",
    "tree-sitter-javascript": "^0.25.0",
    "tree-sitter-php": "^0.24.2",
    "tree-sitter-typescript": "^0.23.2",
    "web-tree-sitter": "^0.26.9",
    "zod": "^3.25.0"
  },

  "optionalDependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0"
  },

  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.19.19",
    "tsup": "^8.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.8.0"
  }
}
```

**Key changes from current state:**

| Field | Before | After | Reason |
|-------|--------|-------|--------|
| `bin.mapx` | `./src/main.ts` | `./dist/main.js` | Compiled JS for Node.js |
| `files` | _(absent — publishes everything)_ | Listed subset | Exclude dev artifacts |
| `engines` | _(absent)_ | `{ "node": ">=20.0.0" }` | Node 20+ LTS required for `web-tree-sitter` & `node:fs/promises` |
| `better-sqlite3` | `optionalDependencies` | `dependencies` | Required for Node.js runtime |
| `@modelcontextprotocol/sdk` | `optionalDependencies` | `optionalDependencies` | Keep optional — MCP only needed for `mapx serve` |
| `tsup` | _(absent)_ | `devDependencies` | npm build tooling |

**Why `better-sqlite3` moves to `dependencies`**: For npm users (Node.js runtime), `better-sqlite3` is the only SQLite backend available — it is not optional. Moving it to `dependencies` ensures it installs automatically. Bun users running the native binary are unaffected (they don't use npm at all for mapx).

---

## Step 3 — WASM asset path resolution fix

Even though the transpile approach preserves path math, the `findAssetRoot()` function needs one small addition: a comment and a verification that the npm-installed path is considered.

The three execution contexts and their paths:

| Context | `__thisFile` | `dirname(__thisFile)` | `resolve(..., '..', '..')` |
|---------|-------------|----------------------|---------------------------|
| Source/dev (tsx, bun run) | `.../mapx/src/parsers/wasm-parser.ts` | `.../mapx/src/parsers/` | `.../mapx/` ✓ |
| npm-installed, transpiled | `.../node_modules/mapx/dist/parsers/wasm-parser.js` | `.../node_modules/mapx/dist/parsers/` | `.../node_modules/mapx/` ✓ |
| Compiled binary (bun --compile) | virtual path (does not exist on disk) | — | falls through to binary search |

The existing logic correctly handles all three cases **as long as the directory structure is preserved**. The spec comment in the source should be updated to document this:

```typescript
// findAssetRoot: locates the directory containing wasm/ and queries/ subdirs.
//
// Three execution contexts:
//   1. Source/dev (tsx or bun run src/main.ts):
//      __thisFile = /path/to/mapx/src/parsers/wasm-parser.ts  → exists
//      asset root  = resolve(dir, '..', '..')  →  /path/to/mapx/
//
//   2. npm-installed (node dist/main.js via npm bin symlink):
//      __thisFile = /path/to/node_modules/mapx/dist/parsers/wasm-parser.js  → exists
//      asset root  = resolve(dir, '..', '..')  →  /path/to/node_modules/mapx/
//
//   3. Compiled native binary (bun build --compile):
//      __thisFile = virtual bun:// path  → does NOT exist
//      falls through to process.execPath-relative search
```

No code changes are required; only the comment is updated.

---

## Step 4 — `tsconfig.json` adjustments

The current `tsconfig.json` has settings optimised for tsx/Bun development:

```json
{
  "allowImportingTsExtensions": true,   // allows import './foo.ts' in source
  "moduleResolution": "bundler",        // relaxed resolution for bundler use
  "noEmit": true                        // type-check only; no JS emitted
}
```

For the npm build, `tsup` ignores `noEmit` and `allowImportingTsExtensions` (it uses esbuild internally). The existing `tsconfig.json` is kept as-is for type checking (`npx tsc --noEmit`). `tsup` uses it only for type references.

**No changes to `tsconfig.json` are required.**

---

## Step 5 — `npx` support

`npx mapx scan` works automatically once the above changes are in place. When `npx` invokes a package:

1. It downloads and caches the package from the npm registry if not already cached
2. It finds the `bin.mapx` entry (`./dist/main.js`)
3. It executes `node dist/main.js` (the `#!/usr/bin/env node` shebang is respected)
4. WASM files and query files are resolved relative to the cached package location

No additional code changes are needed for `npx` support.

**`npx` version pinning** — users can pin to a specific version:

```bash
npx mapx@0.1.6 scan
npx mapx@latest export --format=svg
```

---

## Step 6 — Package manager support matrix

All Node.js package managers are supported automatically once the package is on the npm registry:

| Manager | Global install | Zero-install | Version pinning |
|---------|---------------|--------------|-----------------|
| npm | `npm install -g mapx` | `npx mapx` | `npx mapx@1.2.3` |
| yarn | `yarn global add mapx` | `yarn dlx mapx` | `yarn dlx mapx@1.2.3` |
| pnpm | `pnpm add -g mapx` | `pnpm dlx mapx` | `pnpm dlx mapx@1.2.3` |
| bun (JS mode) | `bun add -g mapx` | `bunx mapx` | `bunx mapx@1.2.3` |

> **Note**: `bun add -g mapx` installs and runs mapx via the Node.js-compatible transpiled bundle (using `better-sqlite3` via Node.js). This is distinct from running mapx natively via the bun binary (which uses `bun:sqlite` and is significantly faster). Bun users who want peak performance should use the native binary install instead.

---

## Step 7 — Publishing action plan

### Pre-requisites

- [ ] npm account at [npmjs.com](https://www.npmjs.com) (free)
- [ ] 2FA enabled on the npm account (required for public packages)
- [ ] Owner or org member with publish rights

### Step-by-step first publish

#### 1. Check package name availability

```bash
npm info mapx
```

If `mapx` is already taken, alternatives to consider (in order of preference):

| Name | Notes |
|------|-------|
| `mapx` | ✓ check availability first |
| `@mapx/cli` | scoped package — always available under your org |
| `mapxgraph` | fallback unscoped name |

If using a scoped name, update `package.json` `"name"` field accordingly and ensure `--access public` is passed on first publish (scoped packages default to private).

#### 2. Create an npm organisation (optional but recommended)

```bash
npm org create mapx
```

This reserves the `@mapx` scope for all future packages (`@mapx/cli`, `@mapx/sdk`, etc.).

#### 3. Authenticate locally

```bash
npm login
# Prompts for username, password, 2FA OTP
# Or use a token:
npm login --auth-type=web
```

#### 4. Verify package contents before publish

```bash
npm run build:npm           # compile TypeScript to dist/
npm pack --dry-run          # shows exactly what will be published
```

Review the dry-run output. Ensure:
- `dist/` contains all compiled JS files
- `wasm/*.wasm` files are included
- `queries/**/*.scm` files are included
- `VERSION`, `README.md`, `LICENSE` are included
- No `.mapx/`, `node_modules/`, `.git/`, or `src/` (source TypeScript) are included

#### 5. Test the packed tarball locally

```bash
npm pack                    # creates mapx-X.Y.Z.tgz
npm install -g ./mapx-X.Y.Z.tgz   # install from local tarball
mapx --version              # verify it works
mapx scan /path/to/test/project
mapx export
```

#### 6. Publish to npm

```bash
# First publish (public package):
npm publish --access public

# Subsequent publishes (access flag not required):
npm publish
```

#### 7. Verify the published package

```bash
npm info mapx               # shows registry metadata
npx mapx@latest --version   # test via npx from registry
```

---

## Step 8 — Automated publishing via GitHub Actions

Manual publishing is error-prone and requires local credentials. Automate it using a GitHub Actions workflow with npm provenance for supply chain transparency.

### `.github/workflows/publish-npm.yml`

```yaml
name: Publish to npm

on:
  push:
    tags:
      - 'v*.*.*'       # triggers on version tags: v0.1.7, v1.0.0, etc.

permissions:
  contents: read
  id-token: write    # required for npm provenance

jobs:
  publish:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: npm ci

      - name: Build WASM grammars
        run: npx tsx scripts/build-wasm.ts

      - name: Build npm package
        run: npm run build:npm

      - name: Verify package contents
        run: npm pack --dry-run

      - name: Publish to npm
        run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Setting up the NPM_TOKEN secret

1. Go to npmjs.com → Profile → Access Tokens → Generate New Token → **Automation** type
2. Copy the token
3. In GitHub: repository Settings → Secrets → Actions → New repository secret
4. Name: `NPM_TOKEN`, Value: the token

### Publish workflow

```
git tag v0.1.7
git push origin v0.1.7
```

This triggers the workflow. The tag must match the version in `package.json` and `VERSION` file (enforced by `scripts/sync-version.ts`).

### npm provenance

The `--provenance` flag (and `id-token: write` permission) links the published package to the specific GitHub Actions run that built it. Users can verify the package was built from the public repository and not tampered with. This is a best-practice for CLI tools distributed via npm.

---

## Step 9 — Version management integration

The existing `scripts/sync-version.ts` syncs `VERSION` → `package.json`. The publish workflow assumes they are in sync. Add a CI check that fails if they diverge:

```bash
# In .github/workflows/publish-npm.yml, after checkout:
- name: Verify version sync
  run: |
    PKG_VERSION=$(node -p "require('./package.json').version")
    FILE_VERSION=$(cat VERSION | tr -d '[:space:]')
    if [ "$PKG_VERSION" != "$FILE_VERSION" ]; then
      echo "Version mismatch: package.json=$PKG_VERSION, VERSION=$FILE_VERSION"
      exit 1
    fi
    echo "Version OK: $PKG_VERSION"
```

---

## Step 10 — `.npmignore` (alternative to `files` in package.json)

The `files` field in `package.json` is preferred and already listed in Step 2. As a safety net, also add `.npmignore` to block any unexpected inclusions:

```
# .npmignore
src/
scripts/
docs/
specs/
.mapx/
.github/
*.ts
!*.d.ts
tsconfig*.json
tsup.config.*
Makefile
*.sh
*.ps1
```

The `.npmignore` is a secondary guard. The `files` field whitelist takes precedence.

---

## File changes summary

```
package.json                      ← bin, files, engines, dep promotions, new scripts
tsup.config.ts                    ← NEW: tsup build config with shebang injection
.github/workflows/publish-npm.yml ← NEW: automated publish workflow
.npmignore                        ← NEW: secondary publish guard
src/parsers/wasm-parser.ts        ← comment-only update to findAssetRoot()
```

---

## Acceptance Criteria

### Build

- [ ] `npm run build:npm` completes without errors
- [ ] `dist/main.js` has `#!/usr/bin/env node` as first line
- [ ] `dist/` mirrors `src/` directory structure (not a single bundle)
- [ ] `npm pack --dry-run` includes `dist/`, `wasm/`, `queries/`, `VERSION`, `README.md`, `LICENSE`
- [ ] `npm pack --dry-run` does NOT include `src/`, `.mapx/`, `node_modules/`, `scripts/`, `specs/`

### Installation

- [ ] `npm install -g mapx` installs successfully on Node.js 18 and 20
- [ ] `mapx --version` prints the correct version after global install
- [ ] `mapx scan /path/to/project` works on a real project after global install
- [ ] `mapx export` produces output after scan
- [ ] `mapx serve` starts the MCP server (when `@modelcontextprotocol/sdk` is available)

### npx

- [ ] `npx mapx --version` works (downloads and runs without prior install)
- [ ] `npx mapx scan .` works on a real project
- [ ] `npx mapx@latest export --format=json` works

### Package managers

- [ ] `yarn dlx mapx --version` works
- [ ] `pnpm dlx mapx --version` works
- [ ] `bunx mapx --version` works (Node.js mode, not native Bun binary)

### Publishing

- [ ] `npm publish --dry-run` succeeds
- [ ] GitHub Actions workflow file is valid YAML (`yamllint`)
- [ ] NPM_TOKEN secret documented in repository CONTRIBUTING.md or README

### Regression

- [ ] Existing `bun run src/main.ts` development workflow unchanged
- [ ] Existing native binary builds (`npm run build:linux` etc.) still work
- [ ] TypeScript type-check: `npx tsc --noEmit` passes with 0 errors

---

## Out of Scope for F13

- Homebrew formula (`brew install mapx`) — separate formula file and tap, deferred
- Winget / Scoop manifests — Windows package managers, deferred
- Docker image (`docker run mapx/mapx scan`) — deferred
- Bun registry (`bun add mapx` from bun registry) — deferred; currently bun reads npm registry so this may work automatically
- Standalone VSCode extension marketplace distribution — separate feature
