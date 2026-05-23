import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const WASM_DIR = join(PROJECT_ROOT, 'wasm');

const GRAMMARS = [
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

async function run() {
  console.log('Building/fetching WASM grammars...');
  mkdirSync(WASM_DIR, { recursive: true });

  for (const grammar of GRAMMARS) {
    const grammarDir = join(PROJECT_ROOT, 'node_modules', grammar.name);

    for (const file of grammar.files) {
      const dest = join(WASM_DIR, file);
      if (existsSync(dest)) {
        console.log(`  ${file} already exists`);
        continue;
      }

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

      if (foundPath) {
        execSync(`cp "${foundPath}" "${dest}"`, { cwd: PROJECT_ROOT });
        console.log(`  Copied ${file} from node_modules`);
      } else {
        // Try unpkg tree-sitter-wasms collection first
        const primaryWasmUrl = `https://unpkg.com/tree-sitter-wasms@latest/out/${file}`;
        console.log(`  Downloading ${file} from tree-sitter-wasms collection...`);
        let success = await downloadFile(primaryWasmUrl, dest);
        
        if (!success) {
          // Try unpkg from the grammar package itself
          const fallbackWasmUrl = `https://unpkg.com/${grammar.name}@latest/${file}`;
          console.log(`  tree-sitter-wasms download failed. Downloading ${file} from ${grammar.name}...`);
          success = await downloadFile(fallbackWasmUrl, dest);
        }

        if (success) {
          console.log(`  Successfully downloaded ${file} from CDN`);
        } else {
          // Fallback to compilation from source
          if (existsSync(grammarDir)) {
            console.log(`  CDN downloads failed. Attempting to build ${file} from source...`);
            try {
              execSync(`npx tree-sitter build --wasm "${grammarDir}"`, {
                cwd: PROJECT_ROOT,
                stdio: 'pipe',
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
              } else {
                console.log(`  Build finished but output file ${file} could not be found.`);
              }
            } catch (e: any) {
              console.log(`  Failed to build ${grammar.name} natively: ${e.message}`);
            }
          } else {
            console.log(`  Failed to obtain ${file} (CDN downloads failed, source not installed).`);
          }
        }
      }
    }
  }

  const existing = execSync(`ls -la ${WASM_DIR}`, { encoding: 'utf-8' });
  console.log(`\nWASM directory contents:\n${existing}`);
}

run();
