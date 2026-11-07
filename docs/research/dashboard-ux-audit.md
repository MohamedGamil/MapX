# Dashboard UX/UI audit (M4-16, 2026-11-01)

The audit covers the dashboard served by `mapx ui` (`src/ui`: `main.ts`, 3,656 lines; `styles.css`; `index.html`; 7 tabs; Cytoscape with fCoSE, ELK, cola and dagre layouts).

**Method.** `npx tsx scripts/ui/audit.ts` (Chromium 156, Playwright 1.64, axe-core 4.14):
1. It scans three fixture workspaces:
   - a copy of MapX's own sources (`git archive HEAD src tests scripts`, 383 files);
   - generated multi-language projects of 500 and 2,000 files.
2. It serves each one with `mapx ui`.
3. It records:
   - each tab at 1440×900, 1024×768 and 390×844;
   - console errors and failed `/api` calls;
   - axe violations;
   - content clipped at the right edge;
   - graph timings and long tasks.

Every figure below comes from `dashboard-ux-audit/metrics.json`, and the screenshots are in `dashboard-ux-audit/`. No private code is involved.

## Baseline

| Measure | Value |
| --- | --- |
| Bundle, gzipped | `main.js` 675 KB, `styles.css` 7 KB, `index.html` 4 KB. The ceiling is 720 KB (D006). |
| …of which ELK (`elk.bundled.js`) | about 456 KB gzipped, loaded up front though the default layout is fCoSE |
| …of which Cytoscape | about 132–247 KB gzipped; fCoSE, cola and dagre with their bases add about 110 KB |
| Default graph (Clusters Map) ready | MapX copy 383 files: 665–832 ms. Generated 500: 563–720 ms. Generated 2,000: 652–1,786 ms. Long tasks 1–3, the longest 105–822 ms. Ranges over three runs on a shared machine (load average 4–21). |
| `/api/graph` payload | 352 KB (MapX copy), 247 KB (500 files), 998 KB (2,000 files); uncompressed JSON |
| Full Codebase graph settles | MapX copy: 941–1,034 ms. 500 files: 608–641 ms. **2,000 files: 9,768–10,636 ms**, in 2 long tasks, so the page freezes. |
| Console errors, failed `/api` calls | 0 on every tab and width |
| axe violations | serious: `color-contrast` on 5 tabs (50 nodes), `scrollable-region-focusable` on 2 tabs. Critical: `select-name` on graph (4 nodes). Moderate: `page-has-heading-one` on every tab. Minor: `empty-table-header` on architecture. |
| Content clipped at 390 px | graph 25 elements, symbols 65, routes 101, architecture 23, metrics 70 |
| Content clipped at 1024 px | routes 31 elements |

## Findings

P1 means it needs fixing for the dashboard to work well; P2 means polish or a lesser problem. Screenshots are named `mapx-<tab>-<width>.jpg`.

### P1

1. **Narrow screens are unusable** (`mapx-graph-390.jpg`, `mapx-routes-390.jpg`).
   - The 300 px sidebar is fixed and never collapses. At 390 px the main panel is clipped on five tabs, without page scrolling, because the layout hides the overflow.
   - The routes table is also clipped at 1024 px.
   - Owner: M4-17.
2. **Accessibility.**
   - **Contrast:** muted text and labels fail the 4.5:1 contrast ratio on five tabs (axe `color-contrast`, 50 elements).
   - **Unnamed controls:** the graph toolbar's four `<select>`s have no accessible name (critical).
   - **Keyboard:** the DSM and metrics scroll regions can't be reached by keyboard.
   - **Headings:** no tab has an `h1`.
   - Owner: M4-17.
3. **The Full Codebase graph freezes the page** (`generated-2000-graph-full-1440.jpg`). On 2,000 files the main thread is blocked for 9.8–10.6 s, in two long tasks of synchronous layout and rendering, and the result is an unreadable hairball. Owner: M4-20, for progressive or worker-side layout, level-of-detail, and a cap or default aggregation above a size.
4. **The initial bundle is near its ceiling** (675 of 720 KB gzipped), mostly ELK, which is loaded up front though rarely chosen. Lazy-loading the layout engines on first use would cut the initial download by about two thirds. Owner: M4-20.
5. **Workspaces are invisible.** The server reads only the primary repo (`config.repo`) for clusters, profile, smells, DSM and metrics. There is no repo switcher, config view or cross-repo HTTP view. Owners: M4-21, M4-22, M4-23.
6. **Architecture data is misleading** (`mapx-architecture-1440.jpg`). These are data defects, not UI ones:
   - "Cyclic dependency" smells read `js-aliases.ts -> js-aliases.ts`. `detectCycles` keeps a file's edges to itself, so the reported "shortest cycle" is a self-loop and not the multi-file cycle that was found.
   - The profile lists Laravel and vue-router, found only under graph-excluded `tests/fixtures`, while its archetype says "Has Backend: NO".
   - Owner: M0-32-R3.

### P2

| # | Finding | Owner |
| --- | --- | --- |
| 7 | The graph toolbar overlays the canvas: on 2,000 files the "Other (1800)" cluster sits under it (`generated-2000-graph-1440.jpg`) | M4-17 |
| 8 | On projects without architecture signals, the default Clusters Map puts 90% of files in "Other". A default that adapts (directory aggregation when one cluster dominates) would say more | M4-17 |
| 9 | Native `<select>`s and buttons are unstyled in the dark theme, and fonts are mixed (display font in headings, system font in controls) | M4-17 |
| 10 | Cluster labels are unreadable at the default zoom (`mapx-graph-1440.jpg`) | M4-17 |
| 11 | The Metrics tab shows bullet lists with large empty cards, and language names are capitalised wrongly ("Php", "Json", "Css") (`mapx-metrics-1440.jpg`) | M4-17 |
| 12 | The Symbol table's file paths wrap into the detail panel's gutter, and pagination is only at the top (`mapx-symbols-1440.jpg`) | M4-17 |
| 13 | The Selection Details panel takes a third of the graph tab while empty | M4-17 |
| 14 | There is no light theme or theme toggle | M4-17 |
| 15 | The header logo is styled text | M4-18, waiting on the owner's logo |
| 16 | `/api/graph` is served uncompressed (998 KB for 2,000 files) | M4-20 |
| 17 | The Architecture tab's health score ("F, 30%") is driven by the misreported cycles of finding 6; review it after M0-32-R3 | M0-32-R3 |

## Design direction for M4-17

- **Tokens:** colours (surface, raised, border, text, muted, accent, plus success, warning, danger and info), a type scale (one UI font plus one monospace), a 4 px spacing scale, radii and elevation, as CSS custom properties.
- **Themes:** dark and light, following `prefers-color-scheme`, with a persisted toggle. Muted text must keep at least 4.5:1 contrast in both.
- **Layout:**
  - **Collapsible sidebar:** an icon rail below 1024 px, and an off-canvas drawer below 640 px.
  - **Graph controls:** the toolbar sits in a bar above the canvas, not over it.
  - **Details panel:** opens on selection.
- **Controls:** custom-styled selects and buttons from the tokens, with visible focus rings, and every control labelled.
- **Data views:** the metrics breakdowns become compact bar charts, and tables get sticky headers and a responsive column priority.
