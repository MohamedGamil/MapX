// Keeps only clusters that still contain an exported file (or are ancestors of one), so exports
// filtered with --include/--exclude do not list clusters made only of excluded files (M0-02-R1).
export function filterClustersToFiles(
  clusters: Record<string, unknown>[],
  memberships: Record<string, unknown>[],
  allowed: Set<string> | null,
): Record<string, unknown>[] {
  if (!allowed) return clusters;
  const keep = new Set<string>();
  for (const m of memberships) if (allowed.has(m.file_path as string)) keep.add(m.cluster_name as string);
  const parentOf = new Map(clusters.map(c => [c.name as string, (c.parent_name as string | null) ?? null]));
  for (const name of [...keep]) {
    for (let p = parentOf.get(name); p; p = parentOf.get(p) ?? null) keep.add(p);
  }
  return clusters.filter(c => keep.has(c.name as string));
}
