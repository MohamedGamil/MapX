import { Store } from './store.js';

export interface FileMetrics {
  path: string;
  language: string;
  afferent: number;
  efferent: number;
  instability: number;
}

export function calculateMetrics(
  store: Store,
  options: { repo?: string; language?: string; verifiedOnly?: boolean } = {}
): FileMetrics[] {
  const files = store.getAllFiles(options.repo);
  const edges = store.getAllEdges(options.repo);

  const afferentMap = new Map<string, Set<string>>();
  const efferentMap = new Map<string, Set<string>>();

  for (const f of files) {
    afferentMap.set(f.path as string, new Set());
    efferentMap.set(f.path as string, new Set());
  }

  for (const e of edges) {
    if (options.verifiedOnly && e.verifiability === 'inferred') {
      continue;
    }
    const src = e.source_file as string;
    const tgt = e.target_file as string;

    if (src === tgt) continue;

    if (afferentMap.has(tgt)) {
      afferentMap.get(tgt)!.add(src);
    }
    if (efferentMap.has(src)) {
      efferentMap.get(src)!.add(tgt);
    }
  }

  const results: FileMetrics[] = [];
  for (const f of files) {
    const path = f.path as string;
    const lang = f.language as string;

    if (options.language && lang.toLowerCase() !== options.language.toLowerCase()) {
      continue;
    }

    const ca = afferentMap.get(path)?.size || 0;
    const ce = efferentMap.get(path)?.size || 0;
    const sum = ca + ce;
    const instability = sum > 0 ? ce / sum : 0.0;

    results.push({
      path,
      language: lang,
      afferent: ca,
      efferent: ce,
      instability,
    });
  }

  return results.sort((a, b) => b.instability - a.instability || b.afferent - a.afferent || a.path.localeCompare(b.path));
}
