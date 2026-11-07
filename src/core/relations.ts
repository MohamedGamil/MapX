// Eloquent model relationships from stored `relation` edges, for `mapx query`, `mapx_query` and the
// LLM export's Models section (F07, M0-05-R2), and service container bindings for `mapx deps` and
// `mapx_dependencies` (F08, M0-05-R4).
import type { Store } from './store.js';

export interface ModelRelation {
  /** Model class (short name, as the edge's source symbol). */
  model: string;
  file: string;
  /** The model method declaring the relation (`team`), when the declaration line is known. */
  method: string | null;
  /** Eloquent call: belongsTo, hasMany, … */
  relation: string;
  /** one-to-many, many-to-one, … */
  type: string | null;
  target: string;
  targetFile: string;
}

export function modelRelations(store: Store, opts: { file?: string; repo?: string } = {}): ModelRelation[] {
  let sql = "SELECT source_file, source_symbol, target_file, target_symbol, metadata FROM edges WHERE edge_type = 'relation'";
  const params: string[] = [];
  if (opts.file) {
    sql += ' AND source_file = ?';
    params.push(opts.file);
  }
  if (opts.repo) {
    sql += ' AND repo = ?';
    params.push(opts.repo);
  }
  const rows = store.raw.prepare(sql + ' ORDER BY source_file, rowid').all(...params) as Record<string, string | null>[];
  const methodsByFile = new Map<string, { name: string; start: number; end: number }[]>();
  const methodsOf = (file: string) => {
    if (!methodsByFile.has(file)) {
      methodsByFile.set(file, (store.getSymbolsForFile(file) as Record<string, unknown>[])
        .filter(s => s.kind === 'method')
        .map(s => ({ name: s.name as string, start: Number(s.start_line), end: Number(s.end_line ?? s.start_line) })));
    }
    return methodsByFile.get(file)!;
  };
  return rows.map(r => {
    let meta: Record<string, unknown> = {};
    try {
      meta = r.metadata ? JSON.parse(r.metadata) : {};
    } catch {
      // keep {}
    }
    const line = Number(meta.startLine);
    // The innermost method around the relation call declares it.
    const method = Number.isFinite(line)
      ? methodsOf(r.source_file!).filter(m => m.start <= line && line <= m.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]?.name ?? null
      : null;
    return {
      model: r.source_symbol ?? r.source_file!.split('/').pop()!.replace(/\.php$/, ''),
      file: r.source_file!,
      method,
      relation: String(meta.relationshipMethod ?? 'relation'),
      type: (meta.relationshipType as string | undefined) ?? null,
      target: r.target_symbol ?? r.target_file!,
      targetFile: r.target_file!,
    };
  });
}

/** `team → belongsTo App\Models\Team (many-to-one)` */
export function describeRelation(r: ModelRelation): string {
  return `${r.method ?? '?'} → ${r.relation} ${r.target}${r.type ? ` (${r.type})` : ''}`;
}

export interface FileBinding {
  abstract: string;
  /** Concrete class, `(closure)` for a closure binding, or the listener of a `$listen` entry. */
  concrete: string;
  /** bind, singleton, listen, … */
  bindingType: string | null;
}

/** Service container bindings declared in a file, for `mapx deps` and `mapx_dependencies` (F08, M0-05-R2/R4). */
export function fileBindings(store: Store, file: string): FileBinding[] {
  return store.getEdgesForFile(file).filter(e => e.edge_type === 'binding').map(b => {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse((b.metadata as string) || '{}');
    } catch {
      // keep {}
    }
    const target = (b.target_symbol as string) || (b.target_file as string);
    // `$listen` bindings point at the listener; the event is the "abstract" side.
    const [abstract, concrete] = meta.bindingType === 'listen'
      ? [String(meta.event ?? '?'), target]
      : [target, (meta.concreteClass as string | null) ?? '(closure)'];
    return { abstract, concrete, bindingType: (meta.bindingType as string | undefined) ?? null };
  });
}

/** `App\Contracts\PaymentGateway → App\Services\StripeGateway (bind)` */
export function describeBinding(b: FileBinding): string {
  return `${b.abstract} → ${b.concrete}${b.bindingType ? ` (${b.bindingType})` : ''}`;
}
