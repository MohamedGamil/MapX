// M0-07-R5: the shell-installer commands README.md and docs/getting-started.md show, read from the
// docs themselves so the tests that run them (tests/installer-replace.test.ts) and the ones that
// check them against the code (tests/docs-surface.test.ts) cannot drift from what the docs say.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
export const INSTALLER_DOCS = ['README.md', 'docs/getting-started.md'];

export interface DocInstallerCommand {
  file: string;
  /** The command line exactly as the doc shows it. */
  line: string;
  /** The release asset it downloads, `mapx-<platform>-installer.sh`. */
  asset: string;
  platform: string;
  /** Arguments after `sh -s --`; empty when the command pipes into a bare `sh`. */
  args: string[];
}

/** Every `curl ... mapx-<platform>-installer.sh | sh ...` line in a fenced code block. */
export function docInstallerCommands(): DocInstallerCommand[] {
  const out: DocInstallerCommand[] = [];
  for (const file of INSTALLER_DOCS) {
    let fenced = false;
    for (const raw of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
      if (/^```/.test(raw)) { fenced = !fenced; continue; }
      if (!fenced || !/^curl .*-installer\.sh\b/.test(raw)) continue;
      const m = /^curl (?:-\S+ )*https:\/\/github\.com\/MohamedGamil\/mapx\/releases\/latest\/download\/(mapx-([a-z0-9]+-[a-z0-9]+)-installer\.sh) \| sh(?: -s -- (.*))?$/.exec(raw);
      if (!m) throw new Error(`${file}: a shell-installer command this test cannot read: ${raw}`);
      const args = (m[3] ?? '').match(/"[^"]*"|\S+/g) ?? [];
      out.push({ file, line: raw, asset: m[1]!, platform: m[2]!, args: args.map((a) => a.replace(/^"|"$/g, '')) });
    }
  }
  return out;
}
