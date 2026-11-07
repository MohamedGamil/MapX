import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const WASM_DIR = join(PROJECT_ROOT, 'wasm');

// `tarball`: a grammar not published to npm, built from a pinned upstream source archive.
// `patches`: exact replacements in the grammar's source, applied to a copy before it is built (a
// grammar with one must be built from source, never copied or downloaded prebuilt).
type Patch = { file: string; from: string; to: string };
const GRAMMARS: { name: string; files: string[]; tarball?: string; patches?: Patch[] }[] = [
  { name: 'tree-sitter-php', files: ['tree-sitter-php.wasm'] },
  { name: 'tree-sitter-javascript', files: ['tree-sitter-javascript.wasm'] },
  { name: 'tree-sitter-typescript', files: ['tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm'] },
  { name: 'tree-sitter-python', files: ['tree-sitter-python.wasm'] },
  { name: 'tree-sitter-go', files: ['tree-sitter-go.wasm'] },
  { name: 'tree-sitter-rust', files: ['tree-sitter-rust.wasm'] },
  { name: 'tree-sitter-java', files: ['tree-sitter-java.wasm'] },
  { name: 'tree-sitter-c-sharp', files: ['tree-sitter-c_sharp.wasm'] },
  { name: 'tree-sitter-ruby', files: ['tree-sitter-ruby.wasm'] },
  { name: 'tree-sitter-c', files: ['tree-sitter-c.wasm'] },
  { name: 'tree-sitter-cpp', files: ['tree-sitter-cpp.wasm'] },
  { name: 'tree-sitter-swift', files: ['tree-sitter-swift.wasm'] },
  { name: 'tree-sitter-kotlin', files: ['tree-sitter-kotlin.wasm'] },
  { name: 'tree-sitter-vue', files: ['tree-sitter-vue.wasm'] },
  { name: 'tree-sitter-dart', files: ['tree-sitter-dart.wasm'] },
  { name: 'tree-sitter-scala', files: ['tree-sitter-scala.wasm'] },
  { name: 'tree-sitter-svelte', files: ['tree-sitter-svelte.wasm'] },
  // M4-27: the external scanner allocated its state uninitialised and kept it across parses, so only
  // the first Lua file of a process parsed correctly.
  { name: 'tree-sitter-lua', files: ['tree-sitter-lua.wasm'], patches: [
    { file: 'src/scanner.c', from: 'return malloc(sizeof(struct ScannerState));', to: 'return calloc(1, sizeof(struct ScannerState));' },
    { file: 'src/scanner.c',
      from: '  if (length == 2)\n  {\n    struct ScannerState *state = payload;\n    state->started = buffer[0];\n    state->depth = buffer[1];\n  }\n}',
      to: '  struct ScannerState *state = payload;\n  if (length == 2)\n  {\n    state->started = buffer[0];\n    state->depth = buffer[1];\n  }\n  else\n  {\n    state->started = 0;\n    state->depth = 0;\n  }\n}' },
  ] },
  { name: 'tree-sitter-elixir', files: ['tree-sitter-elixir.wasm'] },
  { name: 'tree-sitter-zig', files: ['tree-sitter-zig.wasm'] },
  { name: 'tree-sitter-bash', files: ['tree-sitter-bash.wasm'] },
  { name: 'tree-sitter-pascal', files: ['tree-sitter-pascal.wasm'] },
  // ram02z/tree-sitter-fish 3.7.0 (commit fa2143f), Unlicense (D014, M0-12-R5).
  { name: 'tree-sitter-fish', files: ['tree-sitter-fish.wasm'], tarball: 'https://github.com/ram02z/tree-sitter-fish/archive/refs/tags/3.7.0.tar.gz' },
];

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  try {
    execSync(`curl -L -s -f -o "${destPath}" "${url}"`, { stdio: 'ignore' });
    if (existsSync(destPath)) return true;
  } catch {
    // Ignore and fallback to fetch
  }

  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    writeFileSync(destPath, Buffer.from(buf));
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads and unpacks a grammar source archive; returns its directory, or '' on failure.
 * Unpacked under the ignored build/, on the project's filesystem: `tree-sitter build` renames
 * its output into the working directory, which fails across devices (e.g. from /tmp).
 */
async function fetchSource(url: string): Promise<string> {
  mkdirSync(join(PROJECT_ROOT, 'build'), { recursive: true });
  const dir = mkdtempSync(join(PROJECT_ROOT, 'build', 'grammar-'));
  const archive = join(dir, 'source.tar.gz');
  if (!(await downloadFile(url, archive))) return '';
  try {
    execSync(`tar xzf "${archive}" -C "${dir}" --strip-components=1`, { stdio: 'ignore' });
    return dir;
  } catch {
    return '';
  }
}

/** A copy of a grammar's source under build/ with its patches applied; each must match exactly once. */
function patchedCopy(grammarDir: string, name: string, patches: Patch[]): string {
  mkdirSync(join(PROJECT_ROOT, 'build'), { recursive: true });
  const dir = mkdtempSync(join(PROJECT_ROOT, 'build', `${name}-patched-`));
  cpSync(grammarDir, dir, { recursive: true, filter: (src) => !relative(grammarDir, src).split(/[\\/]/).includes('node_modules') });
  for (const patch of patches) {
    const path = join(dir, patch.file);
    const text = readFileSync(path, 'utf8');
    const count = text.split(patch.from).length - 1;
    if (count !== 1) throw new Error(`${name}: patch for ${patch.file} matched ${count} times`);
    // split/join, not replace(): a `$` in the replacement stays literal.
    writeFileSync(path, text.split(patch.from).join(patch.to));
  }
  return dir;
}

async function run() {
  console.log('Building/fetching WASM grammars...');
  mkdirSync(WASM_DIR, { recursive: true });

  for (const grammar of GRAMMARS) {
    let grammarDir = join(PROJECT_ROOT, 'node_modules', grammar.name);
    // Patched once per grammar, before any of its files is built (review of M4-27).
    let patchedDir = '';

    for (const file of grammar.files) {
      const dest = join(WASM_DIR, file);
      if (existsSync(dest)) {
        console.log(`  ${file} already exists`);
        continue;
      }
      if (grammar.tarball && !existsSync(grammarDir)) grammarDir = await fetchSource(grammar.tarball);
      if (grammar.patches && !patchedDir && existsSync(grammarDir)) grammarDir = patchedDir = patchedCopy(grammarDir, grammar.name, grammar.patches);

      let foundPath = '';
      if (existsSync(grammarDir)) {
        const paths = [
          join(grammarDir, file),
          join(grammarDir, 'wasm', file),
          join(grammarDir, 'bindgen', file),
          join(grammarDir, 'build', file),
        ];

        for (const p of paths) {
          if (existsSync(p)) {
            foundPath = p;
            break;
          }
        }
      }

      let success = false;
      if (existsSync(grammarDir)) {
        console.log(`  Attempting to build ${file} from source...`);
        try {
          execSync(`npx tree-sitter build --wasm "${grammarDir}"`, {
            cwd: PROJECT_ROOT,
            stdio: 'ignore',
          });

          const possibleOutputs = [
            join(PROJECT_ROOT, file),
            join(PROJECT_ROOT, `${grammar.name}.wasm`),
          ];

          let builtFile = '';
          for (const out of possibleOutputs) {
            if (existsSync(out)) {
              builtFile = out;
              break;
            }
          }

          if (builtFile) {
            execSync(`mv "${builtFile}" "${dest}"`, { cwd: PROJECT_ROOT });
            console.log(`  Successfully built and moved ${file} to wasm/`);
            success = true;
          }
        } catch (e: any) {
          console.log(`  Failed to build ${grammar.name} natively: ${e.message}. Falling back...`);
        }
      }

      if (!success && grammar.patches) {
        throw new Error(`${file}: a patched grammar must be built from source (needs docker or emcc); not copying a prebuilt one`);
      }
      if (!success) {
        if (foundPath) {
          execSync(`cp "${foundPath}" "${dest}"`, { cwd: PROJECT_ROOT });
          console.log(`  Copied ${file} from node_modules`);
        } else {
          // Try unpkg tree-sitter-wasms collection first
          const primaryWasmUrl = `https://unpkg.com/tree-sitter-wasms@latest/out/${file}`;
          console.log(`  Downloading ${file} from tree-sitter-wasms collection...`);
          success = await downloadFile(primaryWasmUrl, dest);
          
          if (!success) {
            // Try unpkg from the grammar package itself
            const fallbackWasmUrl = `https://unpkg.com/${grammar.name}@latest/${file}`;
            console.log(`  tree-sitter-wasms download failed. Downloading ${file} from ${grammar.name}...`);
            success = await downloadFile(fallbackWasmUrl, dest);
          }

          if (success) {
            console.log(`  Successfully downloaded ${file} from CDN`);
          } else {
            console.log(`  Failed to obtain ${file} (CDN downloads failed, source not installed).`);
          }
        }
      }
    }
    // The patched copy served only this build.
    if (patchedDir) rmSync(patchedDir, { recursive: true, force: true });
  }
  // Copy web-tree-sitter.wasm
  const wtsWasmSrc = join(PROJECT_ROOT, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
  const wtsWasmDest = join(WASM_DIR, 'web-tree-sitter.wasm');
  if (existsSync(wtsWasmSrc)) {
    execSync(`cp "${wtsWasmSrc}" "${wtsWasmDest}"`, { cwd: PROJECT_ROOT });
    console.log('  Copied web-tree-sitter.wasm from node_modules');
  } else {
    console.log('  Warning: web-tree-sitter.wasm not found in node_modules/web-tree-sitter');
  }

  const existing = execSync(`ls -la ${WASM_DIR}`, { encoding: 'utf-8' });
  console.log(`\nWASM directory contents:\n${existing}`);
}

run();
