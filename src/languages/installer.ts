import { join, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function downloadFile(url: string, destPath: string): Promise<void> {
  try {
    execSync(`curl -L -s -f -o "${destPath}" "${url}"`, { stdio: 'ignore' });
    if (existsSync(destPath)) return;
  } catch {
    // Ignore and fallback to fetch
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download from ${url}: HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buf));
}

export const GRAMMARS_DIR = join(homedir(), '.mapx', 'grammars');
export const QUERIES_DIR = join(GRAMMARS_DIR, 'queries');

export interface InstallableLanguageInfo {
  name: string;
  package: string;
  file: string;
}

export const INSTALLABLE_LANGUAGES: Record<string, InstallableLanguageInfo> = {
  ruby: { name: 'ruby', package: 'tree-sitter-ruby', file: 'tree-sitter-ruby.wasm' },
  c: { name: 'c', package: 'tree-sitter-c', file: 'tree-sitter-c.wasm' },
  cpp: { name: 'cpp', package: 'tree-sitter-cpp', file: 'tree-sitter-cpp.wasm' },
  swift: { name: 'swift', package: 'tree-sitter-swift', file: 'tree-sitter-swift.wasm' },
  kotlin: { name: 'kotlin', package: 'tree-sitter-kotlin', file: 'tree-sitter-kotlin.wasm' },
  svelte: { name: 'svelte', package: 'tree-sitter-svelte', file: 'tree-sitter-svelte.wasm' },
  vue: { name: 'vue', package: 'tree-sitter-vue', file: 'tree-sitter-vue.wasm' },
  lua: { name: 'lua', package: 'tree-sitter-lua', file: 'tree-sitter-lua.wasm' },
  elixir: { name: 'elixir', package: 'tree-sitter-elixir', file: 'tree-sitter-elixir.wasm' },
  zig: { name: 'zig', package: 'tree-sitter-zig', file: 'tree-sitter-zig.wasm' },
  bash: { name: 'bash', package: 'tree-sitter-bash', file: 'tree-sitter-bash.wasm' },
  pascal: { name: 'pascal', package: 'tree-sitter-pascal', file: 'tree-sitter-pascal.wasm' },
  dart: { name: 'dart', package: 'tree-sitter-dart', file: 'tree-sitter-dart.wasm' },
  scala: { name: 'scala', package: 'tree-sitter-scala', file: 'tree-sitter-scala.wasm' },
};

export function isLanguageInstalled(name: string): boolean {
  // Built-in/bundled languages are considered always installed (they are loaded from the package)
  const builtins = ['php', 'javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c-sharp'];
  if (builtins.includes(name)) return true;

  const info = INSTALLABLE_LANGUAGES[name];
  if (!info) return false;

  const wasmPath = join(GRAMMARS_DIR, info.file);
  const symPath = join(QUERIES_DIR, name, 'symbols.scm');
  const refPath = join(QUERIES_DIR, name, 'references.scm');

  return existsSync(wasmPath) && existsSync(symPath) && existsSync(refPath);
}

export async function installLanguage(name: string): Promise<void> {
  const info = INSTALLABLE_LANGUAGES[name];
  if (!info) {
    throw new Error(`Language '${name}' is not supported for installation. Supported: ${Object.keys(INSTALLABLE_LANGUAGES).join(', ')}`);
  }

  // Create dirs
  mkdirSync(join(QUERIES_DIR, name), { recursive: true });

  const targetWasm = join(GRAMMARS_DIR, info.file);
  const targetSym = join(QUERIES_DIR, name, 'symbols.scm');
  const targetRef = join(QUERIES_DIR, name, 'references.scm');

  // Find local workspace files first (offline/dev support)
  const packageRoot = resolve(__dirname, '..', '..');
  const localWasm = join(packageRoot, 'wasm', info.file);
  const localSym = join(packageRoot, 'queries', name, 'symbols.scm');
  const localRef = join(packageRoot, 'queries', name, 'references.scm');

  // Copy WASM
  if (existsSync(localWasm)) {
    copyFileSync(localWasm, targetWasm);
  } else {
    const wasmUrl = `https://unpkg.com/${info.package}@latest/${info.file}`;
    console.log(`Downloading WASM from ${wasmUrl}...`);
    await downloadFile(wasmUrl, targetWasm);
  }

  // Copy Symbols query
  if (existsSync(localSym)) {
    copyFileSync(localSym, targetSym);
  } else {
    const symUrl = `https://raw.githubusercontent.com/MohamedGamil/mapx/main/queries/${name}/symbols.scm`;
    console.log(`Downloading symbols query from ${symUrl}...`);
    await downloadFile(symUrl, targetSym);
  }

  // Copy References query
  if (existsSync(localRef)) {
    copyFileSync(localRef, targetRef);
  } else {
    const refUrl = `https://raw.githubusercontent.com/MohamedGamil/mapx/main/queries/${name}/references.scm`;
    console.log(`Downloading references query from ${refUrl}...`);
    await downloadFile(refUrl, targetRef);
  }
}

export async function uninstallLanguage(name: string): Promise<void> {
  const info = INSTALLABLE_LANGUAGES[name];
  if (!info) {
    throw new Error(`Language '${name}' is not supported for dynamic installation.`);
  }

  const targetWasm = join(GRAMMARS_DIR, info.file);
  const targetSym = join(QUERIES_DIR, name, 'symbols.scm');
  const targetRef = join(QUERIES_DIR, name, 'references.scm');

  if (existsSync(targetWasm)) unlinkSync(targetWasm);
  if (existsSync(targetSym)) unlinkSync(targetSym);
  if (existsSync(targetRef)) unlinkSync(targetRef);
}
