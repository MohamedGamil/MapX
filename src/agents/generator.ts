import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES, ProviderTemplate } from './templates.js';

export interface AgentAction {
  provider: string;
  filename: string;
  filepath: string;
  status: 'create' | 'append' | 'update_clean' | 'update_conflict' | 'up_to_date' | 'no_sentinel';
  oldContent?: string;
  newContent: string;
  diff?: string;
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
