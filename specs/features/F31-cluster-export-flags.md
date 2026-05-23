# F31 — Cluster-Aware Export Flags

> **Iteration**: [I16](../iterations/I16.md) · **Status**: `planned` · **Priority**: 🟡 MEDIUM
> **Origin**: Roadmap audit finding #5 — `--cluster`/`--depth` flags missing from `mapx export`

---

## Problem

The I08/F15 spec defines `--cluster` (`none`|`auto`) and `--depth` flags on `mapx export` for cluster-aware DOT/SVG visualization with `subgraph cluster_*` outlines. The `ClusterEngine`, cluster DB tables, and `mapx clusters` CLI all exist and work, but the **export pipeline** doesn't expose cluster options. This means the key deliverable of F15 — cluster-aware visualization — is inaccessible through the primary export workflow.

## Solution

1. Add `--cluster` option to `mapx export` CLI (`none` default, `auto` enables cluster grouping)
2. Add `--depth` option to control maximum cluster nesting level
3. Wire cluster data into `DotExporter.export()` and `SvgExporter.export()` when cluster mode is active
4. When `--cluster=auto`:
   - DOT output wraps files in `subgraph cluster_<name> { ... }` blocks
   - SVG output draws cluster bounding boxes with labels
5. `--cluster=none` (default) produces identical output to current — fully backward compatible

## Files Changed

| File | Change |
|------|--------|
| `src/cli.ts` | Add `--cluster` and `--depth` options to `export` command |
| `src/exporters/dot-exporter.ts` | Accept cluster data, render `subgraph` blocks |
| `src/exporters/svg-exporter.ts` | Accept cluster data, render cluster bounding boxes |

## Acceptance Criteria

- [ ] `mapx export --format=dot --cluster=auto` produces DOT with `subgraph cluster_*` blocks
- [ ] `mapx export --format=svg --cluster=auto` produces SVG with cluster bounding boxes
- [ ] `--cluster=none` (default) produces identical output to current behaviour
- [ ] `--depth=N` limits cluster nesting in output
- [ ] TypeScript compiles with 0 errors
