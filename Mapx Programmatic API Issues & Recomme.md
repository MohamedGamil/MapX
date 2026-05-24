# MapX Programmatic API Issues & Recommendations

During the initialization and testing of `@mgamil/mapx` in a sandbox TypeScript/Node project, a few issues were identified in its programmatic API exports, runtime module resolution, and error handling. 

---

## 1. SyntaxError: Type Exports Mixed with Values

> [!WARNING]
> **Impact:** High — Prevents the package from being imported/run in standard ES Module runtime environments.

### Problem Description
In `src/index.ts`, the TypeScript interfaces `ContextOptions` and `ContextResult` were exported alongside the `ContextBuilder` class using standard value exports:
```typescript
export { ContextBuilder, ContextOptions, ContextResult } from './core/context-builder.js';
```
Since interfaces and types are completely stripped out during compilation, they do not exist in the final generated JavaScript file (`dist/core/context-builder.js`). At runtime, Node.js throws the following exception:
```
SyntaxError: The requested module './core/context-builder.js' does not provide an export named 'ContextOptions'
```

### Resolution
The exports in `src/index.ts` must use TypeScript's `export type` syntax for type-only declarations. This ensures they are omitted from the compiled JavaScript imports/exports but still present in `.d.ts` declaration files:
```typescript
export { ContextBuilder } from './core/context-builder.js';
export type { ContextOptions, ContextResult } from './core/context-builder.js';
```

---

## 2. CommonJS Compatibility Constraints

> [!NOTE]
> **Impact:** Medium — Restricts the package's consumption in legacy or standard Node/CommonJS environments.

### Problem Description
MapX is compiled exclusively as an ES Module (ESM) with the following exports configuration in its `package.json`:
```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  },
  "./package.json": "./package.json"
}
```
If a consumer application uses CommonJS (which is the default Node behavior, or configured via `"type": "commonjs"`), trying to import/run the package throws:
```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in node_modules/@mgamil/mapx/package.json
```
Since there is no `"require"` key in the `"exports"` definition, and no CommonJS target bundle, it cannot be resolved by standard CJS `require()`.

### Recommendations
1. **Developer Instruction:** Document that MapX is ESM-only, requiring consumers to add `"type": "module"` in their `package.json` and use ES Modules.
2. **Dual-Package Support (Alternative):** Configure the build tool (`tsup`) to generate both ESM and CJS formats (adding `"format": ["esm", "cjs"]` to `tsup.config.ts`), and update `package.json` to expose both targets:
   ```json
   "exports": {
     ".": {
       "types": "./dist/index.d.ts",
       "import": "./dist/index.js",
       "require": "./dist/index.cjs"
     }
   }
   ```

---

## 3. SQLite Database Directory Requirement

> [!IMPORTANT]
> **Impact:** Medium — Causes initialization to fail if the path directory is not pre-created.

### Problem Description
Instantiating the `Store` class with a database file path located in a non-existent folder throws a `TypeError`:
```typescript
const store = new Store("data/mapx.db"); // Throws TypeError if 'data/' directory doesn't exist
```
This occurs because the underlying database engine (`better-sqlite3`) expects the target directory to exist beforehand and does not create it recursively.

### Recommendation
Update the `Store` class constructor in MapX (`src/core/store-node.ts` / `src/core/store.ts`) to automatically check for and recursively create the target database's parent directory if it does not exist:
```typescript
import * as fs from 'fs';
import * as path from 'path';

// Inside the Node/SQLite store backend initializer:
const parentDir = path.dirname(dbPath);
if (!fs.existsSync(parentDir)) {
  fs.mkdirSync(parentDir, { recursive: true });
}
```
This makes the library much more robust for programmatic consumers.
