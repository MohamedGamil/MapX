import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from './store.js';

export interface ImpactItem {
  symbol: string;
  file: string;
  depth: number;
  edgeType: string;
  risk: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface ImpactAnalysisResult {
  affected: ImpactItem[];
  summary: {
    high: number;
    medium: number;
    low: number;
  };
  recommendation: string;
}

export function checkTryCatch(content: string, lineNum: number, startLine: number, isPython: boolean): boolean {
  const lines = content.split('\n');
  if (isPython) {
    let tryIndent = -1;
    for (let i = Math.max(0, startLine - 1); i < lineNum - 1; i++) {
      const line = lines[i];
      if (/\btry\s*:/.test(line)) {
        tryIndent = line.match(/^\s*/)?.[0].length ?? 0;
      } else if (tryIndent !== -1) {
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        const isEmpty = line.trim() === '';
        if (!isEmpty && indent <= tryIndent && !/^\s*(except|finally)\b/.test(line)) {
          tryIndent = -1;
        }
      }
    }
    if (tryIndent !== -1) {
      const callLine = lines[lineNum - 1];
      const callIndent = callLine.match(/^\s*/)?.[0].length ?? 0;
      return callIndent > tryIndent;
    }
    return false;
  } else {
    let tryBlockBraceLevel = -1;
    let braceLevel = 0;
    for (let i = Math.max(0, startLine - 1); i < lineNum - 1; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '{') {
          braceLevel++;
        } else if (char === '}') {
          braceLevel--;
          if (braceLevel < tryBlockBraceLevel) {
            tryBlockBraceLevel = -1;
          }
        }
      }
      if (/\btry\b/.test(line)) {
        tryBlockBraceLevel = braceLevel;
      }
    }
    return tryBlockBraceLevel !== -1;
  }
}

export class ImpactAnalyzer {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  analyze(symbolName: string, maxDepth: number, dir: string): ImpactAnalysisResult {
    const queue: Array<{ symName: string; depth: number }> = [{ symName: symbolName, depth: 0 }];
    const visited = new Set<string>([symbolName]);
    const items: ImpactItem[] = [];

    while (queue.length > 0) {
      const { symName, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const callers = this.store.getCallersOfSymbol(symName);
      for (const edge of callers) {
        const callerName = edge.source_symbol || '<top-level>';
        const key = `${edge.source_file}::${callerName}`;
        if (visited.has(key)) continue;
        visited.add(key);

        let risk: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
        const isStructural = ['import', 'require', 'extends', 'implements'].includes(edge.edge_type);
        const curDepth = depth + 1;

        if (curDepth === 1) {
          risk = isStructural ? 'MEDIUM' : 'HIGH';
        } else if (curDepth === 2) {
          risk = isStructural ? 'LOW' : 'MEDIUM';
        } else {
          risk = 'LOW';
        }

        // Check if test file
        const isTestFile = /\.(test|spec)\.[a-z]+$/.test(edge.source_file) ||
          /\/test\//i.test(edge.source_file) ||
          /\/tests\//i.test(edge.source_file) ||
          /__tests__/.test(edge.source_file);

        // Risk depends on depth and test files only (F19, D010). A try/catch around the call
        // used to downgrade HIGH to LOW, but a caught exception still lets behaviour changes
        // propagate, and the line-based check also matched `try` in comments.
        if (isTestFile) risk = 'LOW';

        items.push({
          symbol: callerName,
          file: edge.source_file,
          depth: curDepth,
          edgeType: edge.edge_type,
          risk
        });

        if (edge.source_symbol) {
          queue.push({ symName: edge.source_symbol, depth: curDepth });
        }
      }
    }

    // Files that only import the symbol's file (no call edge) are affected too, at LOW risk, but only
    // when they import the symbol itself (M0-11-R2). Import edges name the module, not the imported
    // names, so the importer's source must mention the symbol's short name as a whole word.
    const target = this.store.getSymbolByName(symbolName);
    if (target?.file_path) {
      const seenFiles = new Set(items.map(x => x.file));
      const importers = this.store.raw
        .prepare("SELECT DISTINCT source_file FROM edges WHERE target_file = ? AND edge_type IN ('import', 'require') AND source_file != ?")
        .all(target.file_path, target.file_path) as { source_file: string }[];
      const short = symbolName.split(/::|\.|\\/).pop() || symbolName;
      const mentions = new RegExp(`(^|[^\\w$])${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w$])`);
      for (const { source_file } of importers) {
        if (seenFiles.has(source_file)) continue;
        let source: string | null = null;
        try {
          source = readFileSync(resolve(dir, source_file), 'utf-8');
        } catch {
          // unreadable: keep the file-level answer
        }
        if (source !== null && !mentions.test(source)) continue;
        items.push({ symbol: '<import>', file: source_file, depth: 1, edgeType: 'import', risk: 'LOW' });
      }
    }

    let recommendation = 'No callers found — safe to change';
    if (items.some(x => x.risk === 'HIGH')) {
      recommendation = 'Treat as BREAKING CHANGE — update all HIGH-risk callers';
    } else if (items.length > 0) {
      recommendation = 'Low blast radius — proceed with caution';
    }

    return {
      affected: items,
      summary: {
        high: items.filter(x => x.risk === 'HIGH').length,
        medium: items.filter(x => x.risk === 'MEDIUM').length,
        low: items.filter(x => x.risk === 'LOW').length,
      },
      recommendation
    };
  }
}
