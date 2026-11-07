import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname, basename, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { TEMPLATES, MCP_CONFIGS, ProviderTemplate, McpConfigEntry } from './templates.js';
import { VERSION } from '../version.js';
import { stripJsoncSyntax, hasJsoncComments } from '../parsers/static-file-parser.js';

export interface AgentAction {
  provider: string;
  filename: string;
  filepath: string;
  /**
   * `key_conflict`: the file already defines, outside the mapx block, a top-level YAML key the
   * block would add (Aider's `read:`). Never written; `note` says what to merge by hand.
   * `remove`: a legacy file with a mapx block (`legacyFiles`). Its blocks are dropped and the file
   * is deleted when nothing else is left (`newContent` is empty); `note` says why (M0-09-R4).
   */
  status: 'create' | 'append' | 'update_clean' | 'update_conflict' | 'up_to_date' | 'no_sentinel' | 'key_conflict' | 'remove';
  oldContent?: string;
  newContent: string;
  diff?: string;
  note?: string;
  /** `remove` only: a block was edited after mapx wrote it. */
  edited?: boolean;
}

/**
 * Writing this action would replace user-written content: a file without a mapx block, an edited
 * block, or an edited legacy block about to be removed.
 */
export function needsConsent(action: AgentAction): boolean {
  return action.status === 'no_sentinel' || action.status === 'update_conflict' || (action.status === 'remove' && !!action.edited);
}

export interface McpConfigAction {
  tool: string;
  filename: string;
  filepath: string;
  status: 'create' | 'update' | 'merge' | 'up_to_date' | 'unparseable';
  content: string;
  /** The merge rewrites a JSONC file whose comments plain JSON cannot keep. */
  droppedComments?: boolean;
}

/** Warning to print when writing `action` loses the file's comments. */
export function droppedCommentsWarning(action: McpConfigAction): string | undefined {
  return action.droppedComments ? `${action.filename}: its comments were not preserved (the merged file is plain JSON).` : undefined;
}

/**
 * Returns the appropriate sentinel markers for a file based on its extension.
 * - `.yaml`, `.yml`, `.sh`, `.bash`, `.py` → `# mapx` / `# /mapx` (hash comments)
 * - `.mdc` → uses HTML-style but placed after frontmatter
 * - Everything else (`.md`, `.txt`, etc.) → `<!-- mapx -->` / `<!-- /mapx -->` (HTML comments)
 */
function getSentinelMarkers(filename: string): { open: (v: string, hash?: string) => string; close: string; regex: RegExp } {
  const ext = extname(filename).toLowerCase();
  const base = basename(filename).toLowerCase();

  if (['.yaml', '.yml', '.sh', '.bash', '.py', '.toml', '.conf'].includes(ext) || base === '.clinerules') {
    return {
      open: (v: string, hash?: string) => `# mapx v${v}${hash ? ` #${hash}` : ''}`,
      close: '# /mapx',
      // `\r?\n`: files checked out with CRLF must still match (M0-09-R3).
      regex: /#\s*mapx\s+v([\d.]+)(?:[ \t]+#([0-9a-f]+))?[ \t]*\r?\n([\s\S]*?)#\s*\/mapx/gi,
    };
  }

  // Default: HTML comment markers (markdown, mdc, etc.)
  return {
    open: (v: string, hash?: string) => `<!-- mapx v${v}${hash ? ` #${hash}` : ''} -->`,
    close: '<!-- /mapx -->',
    regex: /<!--\s*mapx\s+v([\d.]+)(?:\s+#([0-9a-f]+))?\s*-->([\s\S]*?)<!--\s*\/mapx\s*-->/gi,
  };
}

/** `text` with LF line endings. */
const lf = (text: string) => text.replace(/\r\n/g, '\n');

/** Short hash of a generated block body, ignoring surrounding whitespace and line endings. */
function bodyHash(body: string): string {
  return createHash('sha1').update(lf(body).trim()).digest('hex').slice(0, 12);
}

/** The Continue block released versions wrote to `.continue/mapx.yaml`; `tools` was 25, 26 or 32. */
const continueLegacyBody = (tools: number) => `# Continue configuration for MapxGraph (22 languages, ${tools} MCP tools)
contextProviders:
  - name: cmd
    args:
      name: mapx-export
      cmd: mapx export --tokens=4000
  - name: cmd
    args:
      name: mapx-status
      cmd: mapx status`;

/**
 * Bodies released versions (0.1.9–0.3.5) wrote, without a hash, into files mapx no longer writes.
 * A hashless legacy block with any other body was edited (M0-09-R5).
 */
const LEGACY_BODIES: Record<string, string[]> = {
  '.continue/mapx.yaml': [25, 26, 32].map(continueLegacyBody),
};

/** Top-level keys of a YAML text (`key:` at column 0). */
const yamlTopKeys = (text: string) => new Set([...lf(text).matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((m) => m[1]!));

export class AgentGenerator {
  private version: string;

  constructor() {
    this.version = VERSION;
  }

  public getVersion(): string {
    return this.version;
  }

  public listProviders(): string[] {
    return Object.keys(TEMPLATES).filter(p => p !== 'instructions' && !TEMPLATES[p]!.hidden);
  }

  public getTemplate(provider: string): ProviderTemplate | undefined {
    return TEMPLATES[provider];
  }

  private substitute(content: string, dir: string, mcpPort = 3456): string {
    const projectDir = resolve(dir);
    const projectName = basename(projectDir);
    return content
      .replaceAll('{{PROJECT_NAME}}', projectName)
      // A single-quoted YAML scalar: only `'` needs escaping, so Windows paths stay intact (M0-09-R4).
      .replaceAll('{{PROJECT_DIR_YAML}}', `'${projectDir.replaceAll("'", "''")}'`)
      .replaceAll('{{PROJECT_DIR}}', projectDir)
      .replaceAll('{{MAPX_VERSION}}', this.version)
      .replaceAll('{{MCP_PORT}}', mcpPort.toString());
  }

  /** `onlyExisting`: plan only files that already exist (`agents update` never creates files). */
  public plan(providers: string[], options: { dir: string; mcpPort?: number; onlyExisting?: boolean }): AgentAction[] {
    const actions: AgentAction[] = [];
    const dir = options.dir;
    const mcpPort = options.mcpPort || 3456;

    const targetProviders = [...providers];
    if (!targetProviders.includes('instructions')) {
      targetProviders.push('instructions');
    }
    for (const provider of [...targetProviders]) {
      for (const companion of TEMPLATES[provider]?.companions ?? []) {
        if (!targetProviders.includes(companion)) targetProviders.push(companion);
      }
    }

    // A provider still on a legacy file is migrated: its new files are created even by `update`.
    const legacy = this.planLegacy(targetProviders, dir);
    const migrating = new Set(legacy.flatMap((a) => [a.provider, ...(TEMPLATES[a.provider]?.companions ?? [])]));

    for (const provider of targetProviders) {
      const template = TEMPLATES[provider];
      if (!template) continue;

      const filepath = join(dir, template.filename);
      const rawContent = this.substitute(template.content, dir, mcpPort);
      const markers = getSentinelMarkers(template.filename);
      // Frontmatter (Cursor .mdc, Windsurf rules) must stay at byte 0, so the sentinel block goes
      // after it (M0-09-R1).
      const frontmatter = rawContent.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '';
      const body = rawContent.slice(frontmatter.length);
      // The hash of the generated body lets `update` tell a hand edit from an old version (M0-09-R1).
      const lfBlock = `${markers.open(this.version, bodyHash(body))}\n${body}\n${markers.close}`;

      if (!existsSync(filepath)) {
        if (options.onlyExisting && !migrating.has(provider)) continue;
        actions.push({
          provider,
          filename: template.filename,
          filepath,
          status: template.isAppend ? 'append' : 'create',
          // Files end with a newline, so text appended later starts on its own line (M0-09-R3).
          newContent: `${frontmatter}${lfBlock}\n`,
        });
        continue;
      }

      // File exists. A block written into it uses its line endings (M0-09-R3).
      const existingFileContent = readFileSync(filepath, 'utf-8');
      const eol = existingFileContent.includes('\r\n') ? '\r\n' : '\n';
      const withEol = (s: string) => (eol === '\n' ? s : s.replace(/\r?\n/g, eol));
      const block = withEol(lfBlock);
      const wrappedNewContent = withEol(`${frontmatter}${lfBlock}\n`);
      const matches = [...existingFileContent.matchAll(markers.regex)];

      // A YAML block must not add a top-level key the user already set outside it: a second
      // `read:` in .aider.conf.yml would be a duplicate key (M0-09-R3).
      if (/\.ya?ml$/i.test(template.filename)) {
        const userKeys = yamlTopKeys(existingFileContent.replace(markers.regex, ''));
        const clash = [...yamlTopKeys(body)].filter((k) => userKeys.has(k));
        if (clash.length) {
          actions.push({
            provider,
            filename: template.filename,
            filepath,
            status: 'key_conflict',
            oldContent: existingFileContent,
            newContent: existingFileContent,
            note: `it already sets top-level ${clash.map((k) => `\`${k}:\``).join(', ')}; merge these lines into it by hand:\n${body.trimEnd()}`,
          });
          continue;
        }
      }

      if (!matches.length) {
        // No sentinel block
        if (template.isAppend) {
          // For append files, lack of sentinel means we append
          actions.push({
            provider,
            filename: template.filename,
            filepath,
            status: 'append',
            oldContent: existingFileContent,
            newContent: existingFileContent.endsWith('\n')
              ? `${existingFileContent}${eol}${wrappedNewContent}`
              : `${existingFileContent}${eol}${eol}${wrappedNewContent}`,
          });
        } else {
          // For non-append files, lack of sentinel is a potential overwrite conflict
          actions.push({
            provider,
            filename: template.filename,
            filepath,
            status: 'no_sentinel',
            oldContent: existingFileContent,
            newContent: wrappedNewContent,
            diff: this.diff(existingFileContent, wrappedNewContent),
          });
        }
        continue;
      }

      // Sentinel block(s) exist. Only the first is kept; later ones are duplicates (M0-09-R3).
      const match = matches[0]!;
      const fileVersion = match[1];
      const fileContentInside = match[3]!;
      // Edited: a block no longer matches the hash it was written with (any version). A block
      // written before hashes existed counts as edited unless it is the current body, since an
      // old version cannot be told from a hand edit (M0-09-R3).
      const isEdited = (m: RegExpMatchArray) => (m[2] ? bodyHash(m[3]!) !== m[2] : lf(m[3]!).trim() !== lf(body).trim());
      const edited = matches.some(isEdited);

      const frontmatterInPlace = !!frontmatter && existingFileContent.slice(0, match.index).trimStart().startsWith('---');

      if (matches.length === 1 && lf(fileContentInside).trim() === lf(body).trim() && fileVersion === this.version && (!frontmatter || frontmatterInPlace)) {
        actions.push({
          provider,
          filename: template.filename,
          filepath,
          status: 'up_to_date',
          oldContent: existingFileContent,
          newContent: existingFileContent,
        });
        continue;
      }

      // Content or version changed — replace the first sentinel block and drop duplicates.
      // A file already carrying the frontmatter above the block only gets its block replaced.
      const replacement = frontmatterInPlace || !frontmatter ? block : withEol(`${frontmatter}${lfBlock}`);
      let newFileContent = '';
      let from = 0;
      for (const [k, m] of matches.entries()) {
        newFileContent += existingFileContent.slice(from, m.index) + (k === 0 ? replacement : '');
        from = m.index! + m[0].length;
        // A removed duplicate takes its line break with it.
        if (k > 0 && existingFileContent.startsWith(eol, from)) from += eol.length;
      }
      newFileContent += existingFileContent.slice(from);

      actions.push({
        provider,
        filename: template.filename,
        filepath,
        status: edited ? 'update_conflict' : 'update_clean',
        oldContent: existingFileContent,
        newContent: newFileContent,
        diff: this.diff(fileContentInside, body),
      });
    }

    // Legacy files go last, after their replacements are written.
    return [...actions, ...legacy];
  }

  /**
   * `remove` actions for legacy files that still carry a mapx block (M0-09-R4). A file without
   * one is the user's and is left alone. A hashed block that no longer matches its hash was
   * edited; a hashless block predates hashes and was edited unless its body is one a released
   * version wrote (M0-09-R5).
   */
  private planLegacy(providers: string[], dir: string): AgentAction[] {
    const actions: AgentAction[] = [];
    for (const provider of providers) {
      const template = TEMPLATES[provider];
      for (const filename of template?.legacyFiles ?? []) {
        const filepath = join(dir, filename);
        if (!existsSync(filepath)) continue;
        const content = readFileSync(filepath, 'utf-8');
        const matches = [...content.matchAll(getSentinelMarkers(filename).regex)];
        if (!matches.length) continue;
        // Drop each block with one line break; keep everything else byte for byte.
        let rest = '';
        let from = 0;
        for (const m of matches) {
          rest += content.slice(from, m.index);
          from = m.index! + m[0].length;
          from += content.startsWith('\r\n', from) ? 2 : content.startsWith('\n', from) ? 1 : 0;
        }
        rest += content.slice(from);
        const newContent = rest.trim() ? rest : '';
        const replacements = [template!.filename, ...(template!.companions ?? []).map((c) => TEMPLATES[c]?.filename)].filter(Boolean);
        actions.push({
          provider,
          filename,
          filepath,
          status: 'remove',
          edited: matches.some((m) => (m[2] ? bodyHash(m[3]!) !== m[2] : !(LEGACY_BODIES[filename] ?? []).includes(lf(m[3]!).trim()))),
          oldContent: content,
          newContent,
          diff: this.diff(content, newContent),
          note: `${newContent ? 'Removed its mapx block' : 'Removed'}: the ${provider} provider never loads this file; mapx now writes ${replacements.join(', ')}.`,
        });
      }
    }
    return actions;
  }

  public execute(action: AgentAction): void {
    if (action.status === 'up_to_date' || action.status === 'key_conflict') return;
    if (action.status === 'remove' && !action.newContent) {
      if (existsSync(action.filepath)) unlinkSync(action.filepath);
      return;
    }
    const parentDir = dirname(action.filepath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(action.filepath, action.newContent, 'utf-8');
  }

  public revert(options: { dir: string }): void {
    const dir = options.dir;
    // Every file mapx writes or once wrote, with the front matter it puts above the block.
    const files = Object.values(TEMPLATES).flatMap((t) => [
      { filename: t.filename, frontmatter: t.content.match(/^---\n[\s\S]*?\n---\n/)?.[0].trim() },
      ...(t.legacyFiles ?? []).map((filename) => ({ filename, frontmatter: undefined })),
    ]);
    for (const { filename, frontmatter } of files) {
      const filepath = join(dir, filename);
      if (!existsSync(filepath)) continue;

      try {
        const content = readFileSync(filepath, 'utf-8');
        const markers = getSentinelMarkers(filename);
        const match = content.match(markers.regex);

        if (match) {
          // Found our sentinel block, let's remove it
          const cleaned = content.replace(markers.regex, '').trim();
          // A file left with only mapx's own front matter (Continue prompts, rules) is removed too.
          if (cleaned.length === 0 || (frontmatter && lf(cleaned) === frontmatter)) {
            // Delete the file
            unlinkSync(filepath);
            console.log(`  ✓ Removed ${filename}`);
            
            // Optionally remove parent directory if empty (like .cursor/rules, .windsurf/rules, .continue, .zed)
            let parentDir = dirname(filepath);
            const resolvedDir = resolve(dir);
            while (parentDir !== resolvedDir && parentDir !== '/' && parentDir !== '.') {
              if (existsSync(parentDir) && readdirSync(parentDir).length === 0) {
                rmdirSync(parentDir);
                parentDir = dirname(parentDir);
              } else {
                break;
              }
            }
          } else {
            // Write cleaned content back
            writeFileSync(filepath, cleaned, 'utf-8');
            console.log(`  ✓ Cleaned mapx integration from ${filename}`);
          }
        }
      } catch (err: any) {
        console.error(`  ✗ Failed to revert agent file ${filename}: ${err.message}`);
      }
    }
  }

  /**
   * Detect which agent tools are present in the project directory.
   * Returns the list of MCP config entries that should be generated.
   */
  public detectAgentTools(dir: string): McpConfigEntry[] {
    return MCP_CONFIGS.filter(entry => entry.detect(dir));
  }

  /**
   * MCP configs that belong to instruction providers: generating Zed's instructions also
   * registers the server in .zed/settings.json (M0-09-R2). Declared per template, not inferred
   * from matching names (M0-09-R3).
   */
  public companionMcpConfigs(providers: string[]): McpConfigEntry[] {
    const names = new Set(providers.flatMap(p => TEMPLATES[p]?.mcpConfigs ?? []));
    return MCP_CONFIGS.filter(entry => names.has(entry.name));
  }

  /**
   * List all available MCP config targets.
   */
  public listMcpConfigs(): McpConfigEntry[] {
    return MCP_CONFIGS;
  }

  /**
   * Plan and generate MCP config files for detected (or specified) agent tools.
   * For JSON config files that already exist, we merge the mapx entry into them
   * rather than overwriting the entire file.
   */
  public generateMcpConfigs(tools: McpConfigEntry[], options: { dir: string }): McpConfigAction[] {
    const dir = resolve(options.dir);
    const actions: McpConfigAction[] = [];

    for (const entry of tools) {
      const filepath = join(dir, entry.filename);
      const newContent = entry.generate(dir);

      if (!existsSync(filepath)) {
        // Create new config file
        actions.push({
          tool: entry.name,
          filename: entry.filename,
          filepath,
          status: 'create',
          content: newContent,
        });
        continue;
      }

      // File exists — try to merge the mapx key into existing config
      try {
        const existingRaw = readFileSync(filepath, 'utf-8');
        // Editor settings are often JSONC (comments, trailing commas).
        const existing = JSON.parse(stripJsoncSyntax(existingRaw));
        const newObj = JSON.parse(newContent);

        // Determine the key path that holds the mapx server entry
        const merged = this.mergeMapxIntoConfig(existing, newObj, entry.name);
        const mergedStr = JSON.stringify(merged, null, 2);

        // Compare parsed values, not text: a JSONC file (comments, trailing commas) that already
        // holds the identical entry is up to date and keeps its comments (M0-09-R5).
        if (isDeepStrictEqual(existing, merged)) {
          actions.push({
            tool: entry.name,
            filename: entry.filename,
            filepath,
            status: 'up_to_date',
            content: mergedStr,
          });
        } else {
          actions.push({
            tool: entry.name,
            filename: entry.filename,
            filepath,
            status: 'merge',
            content: mergedStr,
            droppedComments: hasJsoncComments(existingRaw),
          });
        }
      } catch {
        // Never overwrite a config we cannot parse: it holds the user's other settings.
        actions.push({
          tool: entry.name,
          filename: entry.filename,
          filepath,
          status: 'unparseable',
          content: newContent,
        });
      }
    }

    return actions;
  }

  /**
   * Execute MCP config actions (write files to disk).
   */
  public executeMcpConfig(action: McpConfigAction): void {
    if (action.status === 'up_to_date' || action.status === 'unparseable') return;
    const parentDir = dirname(action.filepath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(action.filepath, action.content + '\n', 'utf-8');
  }

  /**
   * Merge the mapx MCP entry into an existing config object without
   * destroying other entries. Handles the different config shapes:
   * - opencode: { mcp: { mapx: ... } }
   * - gemini-cli: { mcpServers: { mapx: ... } }
   * - cursor/vscode: { mcpServers/servers: { mapx: ... } }
   */
  private mergeMapxIntoConfig(existing: any, newObj: any, toolName: string): any {
    const merged = { ...existing };

    // Find the container key in the new config that holds 'mapx'
    for (const key of Object.keys(newObj)) {
      if (key === '$schema') {
        if (!merged.$schema) merged.$schema = newObj.$schema;
        continue;
      }
      const val = newObj[key];
      if (typeof val === 'object' && val !== null && 'mapx' in val) {
        // This is the servers container (e.g., "mcp", "mcpServers", "servers")
        if (!merged[key]) merged[key] = {};
        merged[key] = { ...merged[key], mapx: val.mapx };
      }
    }

    return merged;
  }

  /**
   * Remove mapx entries from MCP config files during uninit.
   * If the config file has only mapx entries, delete the file entirely.
   */
  public revertMcpConfigs(options: { dir: string }): void {
    const dir = resolve(options.dir);

    for (const entry of MCP_CONFIGS) {
      const filepath = join(dir, entry.filename);
      if (!existsSync(filepath)) continue;

      try {
        const raw = readFileSync(filepath, 'utf-8');
        const obj = JSON.parse(stripJsoncSyntax(raw));
        let modified = false;

        // Remove mapx from all known container keys
        for (const key of ['mcp', 'mcpServers', 'servers', 'context_servers']) {
          if (obj[key] && typeof obj[key] === 'object' && 'mapx' in obj[key]) {
            delete obj[key].mapx;
            modified = true;
            // If container is now empty, remove it too
            if (Object.keys(obj[key]).length === 0) {
              delete obj[key];
            }
          }
        }

        if (!modified) continue;

        // If the entire config is now empty (or only has $schema), delete the file
        const remaining = Object.keys(obj).filter(k => k !== '$schema');
        if (remaining.length === 0) {
          unlinkSync(filepath);
          console.log(`  ✓ Removed ${entry.filename}`);

          // Clean up empty parent dirs
          let parentDir = dirname(filepath);
          const resolvedDir = resolve(dir);
          while (parentDir !== resolvedDir && parentDir !== '/' && parentDir !== '.') {
            if (existsSync(parentDir) && readdirSync(parentDir).length === 0) {
              rmdirSync(parentDir);
              parentDir = dirname(parentDir);
            } else {
              break;
            }
          }
        } else {
          writeFileSync(filepath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
          console.log(`  ✓ Removed mapx entry from ${entry.filename}`);
        }
      } catch (err: any) {
        console.error(`  ✗ Failed to revert MCP config ${entry.filename}: ${err.message}`);
      }
    }
  }

  public diff(oldStr: string, newStr: string): string {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const diff: string[] = [];
    let i = 0, j = 0;

    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length) {
        if (oldLines[i] === newLines[j]) {
          diff.push(`  ${oldLines[i]}`);
          i++;
          j++;
        } else {
          let found = false;
          for (let k = 1; k < 5; k++) {
            if (i + k < oldLines.length && oldLines[i + k] === newLines[j]) {
              for (let m = 0; m < k; m++) {
                diff.push(`- ${oldLines[i + m]}`);
              }
              i += k;
              found = true;
              break;
            }
            if (j + k < newLines.length && oldLines[i] === newLines[j + k]) {
              for (let m = 0; m < k; m++) {
                diff.push(`+ ${newLines[j + m]}`);
              }
              j += k;
              found = true;
              break;
            }
          }
          if (!found) {
            diff.push(`- ${oldLines[i]}`);
            diff.push(`+ ${newLines[j]}`);
            i++;
            j++;
          }
        }
      } else if (i < oldLines.length) {
        diff.push(`- ${oldLines[i]}`);
        i++;
      } else if (j < newLines.length) {
        diff.push(`+ ${newLines[j]}`);
        j++;
      }
    }
    return diff.join('\n');
  }
}
