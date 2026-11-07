// The index gate of `mapx check`, the `mapx arch` subcommands and the mapx_arch_* MCP tools (AR-17,
// exit 4; M5-05, moved here by M5-14 so the CLI and MCP refuse the same indexes): an index exists,
// every registered repo has a completed scan, no file changed since it (unless a sync brings the
// index up to date first, or `allowStale`), and no older MapX built it.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '../core/config.js';
import type { Store } from '../core/store.js';
import { outdatedIndexRepos } from '../core/extractor-version.js';
import { findStaleFiles, staleCount, staleNames } from '../core/staleness.js';

export interface GateOptions<C> {
  /** Brings a stale or outdated index up to date (`--sync`, `sync: true`); without it such an index fails. */
  sync?: (context: C) => Promise<unknown>;
  /** Files changed since the last scan do not fail the gate (`mapx arch changed`, `mapx_arch_init`). */
  allowStale?: boolean;
  /** How to sync from where the caller is, quoted: `` `mapx check --sync` ``, `` `sync: true` ``. */
  syncAdvice: string;
  /** How to update the index, quoted: `` `mapx update` ``, `` `mapx_sync` ``. */
  updateAdvice: string;
}

/**
 * The loaded index of `dir`, or why it cannot be used (every message, in order). `load` opens the
 * index once the files exist; the caller owns the store it returns, also on failure.
 */
export async function indexGate<C extends { config: Config; store: Store }>(
  dir: string, load: () => Promise<C>, options: GateOptions<C>,
): Promise<{ context: C } | { problems: string[] }> {
  if (!existsSync(resolve(dir, '.mapx', 'config.json')) || !existsSync(resolve(dir, '.mapx', 'mapx.db'))) {
    return { problems: [`No MapX index in ${dir}: run \`mapx init\` and \`mapx scan\` first.`] };
  }
  const context = await load();
  const { config, store } = context;
  // An index file exists as soon as any command opens it: only a finished scan of every
  // registered repo counts (review of M5-05: an unscanned index passed as clean).
  const unscanned = config.repos.filter((r) => !store.getMeta(`last_scan_time:${r.name}`)).map((r) => r.name);
  if (unscanned.length) return { problems: [`The index has no completed scan of ${unscanned.join(', ')}: run \`mapx scan\` first.`] };
  // A walk of the workspace: new files count in a non-git workspace and in nested repos too.
  const stale = options.allowStale ? null : findStaleFiles(store, dir);
  // An index an older extractor built is stale too: its edges may predate a fix (M5-26). So is one
  // whose external-reference attribution older rules made (M5-19-R1).
  const outdated = outdatedIndexRepos(store, config.repos.map((r) => r.name));
  const staleFiles = stale ? staleCount(stale) : 0;
  if (staleFiles > 0 || outdated.length) {
    if (!options.sync) {
      const problems: string[] = [];
      if (staleFiles > 0) {
        const names = staleNames(stale!, 5);
        problems.push(`The index is stale: ${staleFiles} file(s) changed since the last scan (${names.join(', ')}${staleFiles > names.length ? ', …' : ''}). Run ${options.updateAdvice}, or ${options.syncAdvice}.`);
      }
      if (outdated.length) problems.push(`The index of ${outdated.join(', ')} was built by an older MapX: run \`mapx scan\`${options.allowStale ? '' : `, or ${options.syncAdvice},`} to rebuild it.`);
      return { problems };
    }
    // The sync re-parses every file of an outdated repo (or only attributes again, for older
    // attribution rules). One it could not rebuild (a missing
    // folder, an interrupted sync) is still outdated: the gate holds (review of M5-26).
    await options.sync(context);
    const still = outdatedIndexRepos(store, config.repos.map((r) => r.name));
    if (still.length) return { problems: [`The index of ${still.join(', ')} was built by an older MapX and the sync could not rebuild it: run \`mapx scan\`.`] };
  }
  return { context };
}
