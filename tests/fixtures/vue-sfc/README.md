# vue-sfc fixture

Synthetic Vue 2.7 (`vue2/`, a helpdesk: Vuex 3, Vue Router 3, Pinia) and Vue 3.x (`vue3/`, a shop: Vuex 4, Vue Router 4, Pinia) apps for scoring the graph edges MapX derives from single-file components (docs/baton M3-01 … M3-06). All code is invented.

- `expected.json`: one label per line. A label has an `edge` (`source_file`, `source_symbol`, `target_file`, `target_symbol`, `edge_type`, paths relative to this folder) or a component `symbol` (`file`, `name`, `kind`, optional `metadata` subset). `"expect": "absent"` marks a negative: that exact edge must not exist.
- The edge contract (symbol naming, which symbol owns template and `<script setup>` code, render and route edges) is in `docs/baton/iterations/M3-01.md`, section "Edge contract".
- Score: `npx tsx scripts/eval/score-edges.ts tests/fixtures/vue-sfc [--json] [--min-recall R|pattern=R] [--max-fp N|pattern=N] [--min-precision P]`.
- Floors: `tests/vue-sfc.test.ts` (`FLOORS`); raise them as M3-02 … M3-06 land.

Deliberate traps (negatives): same-named methods in unrelated components (`save`, `checkout`), a component tag inside an HTML comment, a mixin with the same member that the component does not mix in, Vuex actions with the same name in two namespaces (`FETCH_ALL`), Pinia actions with the same name in two stores (`clear`, `touch`), a route named like a different component (`Dashboard`), and `<router-link>` targets that are navigation, not rendering.
