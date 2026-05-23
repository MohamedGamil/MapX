import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname, basename, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES, MCP_CONFIGS, ProviderTemplate, McpConfigEntry } from './templates.js';

export interface AgentAction {
  provider: string;
  filename: string;
  filepath: string;
  status: 'create' | 'append' | 'update_clean' | 'update_conflict' | 'up_to_date' | 'no_sentinel';
  oldContent?: string;
  newContent: string;
  diff?: string;
}

export interface McpConfigAction {
  tool: string;
  filename: string;
  filepath: string;
  status: 'create' | 'update' | 'merge' | 'up_to_date';
  content: string;
}

/**
 * Returns the appropriate sentinel markers for a file based on its extension.
 * - `.yaml`, `.yml`, `.sh`, `.bash`, `.py` → `# mapx` / `# /mapx` (hash comments)
 * - `.mdc` → uses HTML-style but placed after frontmatter
 * - Everything else (`.md`, `.txt`, etc.) → `<!-- mapx -->` / `<!-- /mapx -->` (HTML comments)
 */
function getSentinelMarkers(filename: string): { open: (v: string) => string; close: string; regex: RegExp } {
  const ext = extname(filename).toLowerCase();
  const base = basename(filename).toLowerCase();

  if (['.yaml', '.yml', '.sh', '.bash', '.py', '.toml', '.conf'].includes(ext) || base === '.clinerules') {
    return {
      open: (v: string) => `# mapx v${v}`,
      close: '# /mapx',
      regex: /#\s*mapx\s+v([\d.]+)\s*\n([\s\S]*?)#\s*\/mapx/i,
    };
  }

  // Default: HTML comment markers (markdown, mdc, etc.)
  return {
    open: (v: string) => `<!-- mapx v${v} -->`,
    close: '<!-- /mapx -->',
    regex: /<!--\s*mapx\s+v([\d.]+)\s*-->([\s\S]*?)<!--\s*\/mapx\s*-->/i,
  };
}

export class AgentGenerator {
  private version: string;

  constructor() {
    this.version = this.readVersion();
  }

  private readVersion(): string {
    const base = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      join(base, 'VERSION'),
      join(base, '..', 'VERSION'),
      join(base, '..', '..', 'VERSION')
    ]) {
      if (existsSync(candidate)) {
        return readFileSync(candidate, 'utf-8').trim();
      }
    }
    return '0.1.7';
  }

  public getVersion(): string {
    return this.version;
  }

  public listProviders(): string[] {
    return Object.keys(TEMPLATES);
  }

  public getTemplate(provider: string): ProviderTemplate | undefined {
    return TEMPLATES[provider];
  }

  private substitute(content: string, dir: string, mcpPort = 3456): string {
    const projectDir = resolve(dir);
    const projectName = basename(projectDir);
    return content
      .replaceAll('{{PROJECT_NAME}}', projectName)
      .replaceAll('{{PROJECT_DIR}}', projectDir)
      .replaceAll('{{MAPX_VERSION}}', this.version)
      .replaceAll('{{MCP_PORT}}', mcpPort.toString());
  }

  public plan(providers: string[], options: { dir: string; mcpPort?: number }): AgentAction[] {
    const actions: AgentAction[] = [];
    const dir = options.dir;
    const mcpPort = options.mcpPort || 3456;

    for (const provider of providers) {
      const template = TEMPLATES[provider];
      if (!template) continue;

      const filepath = join(dir, template.filename);
      const rawContent = this.substitute(template.content, dir, mcpPort);
      const markers = getSentinelMarkers(template.filename);
      const wrappedNewContent = `${markers.open(this.version)}\n${rawContent}\n${markers.close}`;

      if (!existsSync(filepath)) {
        actions.push({
          provider,
          filename: template.filename,
          filepath,
          status: template.isAppend ? 'append' : 'create',
          newContent: wrappedNewContent,
        });
        continue;
      }

      // File exists
      const existingFileContent = readFileSync(filepath, 'utf-8');
      const match = existingFileContent.match(markers.regex);

      if (!match) {
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
              ? `${existingFileContent}\n${wrappedNewContent}`
              : `${existingFileContent}\n\n${wrappedNewContent}`,
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

      // Sentinel block exists
      const fileVersion = match[1];
      const fileContentInside = match[2];

      const expectedContentOld = fileContentInside; // what's actually there
      const expectedContentNew = rawContent;        // new template content

      if (expectedContentOld.trim() === expectedContentNew.trim() && fileVersion === this.version) {
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

      // Content or version changed — replace sentinel block
      const newFileContent = existingFileContent.replace(markers.regex, wrappedNewContent);

      actions.push({
        provider,
        filename: template.filename,
        filepath,
        status: fileVersion === this.version ? 'update_conflict' : 'update_clean',
        oldContent: existingFileContent,
        newContent: newFileContent,
        diff: this.diff(fileContentInside, rawContent),
      });
    }

    return actions;
  }

  public execute(action: AgentAction): void {
    if (action.status === 'up_to_date') return;
    const parentDir = dirname(action.filepath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(action.filepath, action.newContent, 'utf-8');
  }

  public revert(options: { dir: string }): void {
    const dir = options.dir;
    for (const provider of Object.keys(TEMPLATES)) {
      const template = TEMPLATES[provider];
      if (!template) continue;

      const filepath = join(dir, template.filename);
      if (!existsSync(filepath)) continue;

      try {
        const content = readFileSync(filepath, 'utf-8');
        const markers = getSentinelMarkers(template.filename);
        const match = content.match(markers.regex);

        if (match) {
          // Found our sentinel block, let's remove it
          const cleaned = content.replace(markers.regex, '').trim();
          if (cleaned.length === 0) {
            // Delete the file
            unlinkSync(filepath);
            console.log(`  ✓ Removed ${template.filename}`);
            
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
            console.log(`  ✓ Cleaned mapx integration from ${template.filename}`);
          }
        }
      } catch (err: any) {
        console.error(`  ✗ Failed to revert agent file ${template.filename}: ${err.message}`);
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
        const existing = JSON.parse(existingRaw);
        const newObj = JSON.parse(newContent);

        // Determine the key path that holds the mapx server entry
        const merged = this.mergeMapxIntoConfig(existing, newObj, entry.name);
        const mergedStr = JSON.stringify(merged, null, 2);

        if (existingRaw.trim() === mergedStr.trim()) {
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
          });
        }
      } catch {
        // Can't parse existing file — overwrite with new content
        actions.push({
          tool: entry.name,
          filename: entry.filename,
          filepath,
          status: 'update',
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
    if (action.status === 'up_to_date') return;
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
        const obj = JSON.parse(raw);
        let modified = false;

        // Remove mapx from all known container keys
        for (const key of ['mcp', 'mcpServers', 'servers']) {
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
