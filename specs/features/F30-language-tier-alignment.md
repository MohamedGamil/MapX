# F30 — Language Tier Alignment

> **Iteration**: [I16](../iterations/I16.md) · **Status**: `planned` · **Priority**: 🔴 HIGH
> **Origin**: Roadmap audit finding #4 — tier values in registry don't match I12/F20 spec

---

## Problem

The I12/F20 spec defines three language tiers:

| Tier | Meaning | Expected Languages |
|------|---------|-------------------|
| `built-in` | WASM bundled in npm package, works out of the box | PHP, JS, TS, Python, Go, Rust, Java, C# |
| `bundled` | WASM shipped but may need download on first use | Ruby, C, C++, Swift, Kotlin, Scala, Dart |
| `installable` | Requires explicit `mapx lang install` | Svelte, Vue, Lua, Elixir, Zig, Bash, Pascal |

Current registry has:
- Python/Go/Rust/Java/C# as `bundled` (should be `built-in`)
- Ruby/C/C++/Swift/Kotlin/Scala/Dart as `installable` (should be `bundled`)

Additionally, the `bundled` tier languages currently point to `~/.mapx/grammars/` paths which requires explicit installation. They should use relative `wasm/` paths like built-in languages.

## Solution

1. Change `tier` values for 12 languages in `src/languages/registry.ts`
2. Update WASM/query paths for the 7 newly-`bundled` languages to use relative paths

## Files Changed

| File | Change |
|------|--------|
| `src/languages/registry.ts` | Fix tier values; update WASM paths for bundled languages |

## Acceptance Criteria

- [ ] Python, Go, Rust, Java, C# have `tier: 'built-in'`
- [ ] Ruby, C, C++, Swift, Kotlin, Scala, Dart have `tier: 'bundled'`
- [ ] Built-in and bundled languages use relative `wasm/` and `queries/` paths
- [ ] `mapx lang list` shows correct tiers
- [ ] TypeScript compiles with 0 errors
