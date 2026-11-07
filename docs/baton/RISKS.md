# Risks

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- | --- |
| R01 | **Materialised 2026-10-31 (M0-41):** 0 of 16 audited legacy iterations fully confirmed; 6 falsely complete. Mitigation: 18 remediation tasks scheduled before M3 (D010). | — | high | Execute the remediation queue with /baton; re-audit with baton-review after. | maintainer |
| R02 | Report item 13 (~10k cross-language edges) did not reproduce on a minimal fixture; the pilot pattern is unknown. | medium | high | M2-01 starts with a spike, then makes the filter fail-closed regardless. | maintainer |
| R03 | Regex-based Laravel extraction may not scale to mount graphs (require, providers, conditionals). | medium | high | M1-01 fixture first; if M1-03 or M1-07 exceed their estimate, split them and consider an AST-based PHP pass. | maintainer |
| R04 | ~~`tsc` covers only `src/`~~ **Closed 2026-10-30 by M0-40**: `npm run typecheck` covers src, tests and scripts. | — | — | — | — |
| R05 | The dashboard bundle (689 KB gzipped, plus a 7.8 MB source map) inflates the npm package. | high | low | M0-15-R1, after an owner decision. | owner |
| R06 | Dashboard UI behaviour (graph explorer, layouts, health tab, and the M5-15 Architecture view) has no automated test; only its server endpoints can be covered without a browser harness. | medium | medium | M0-39 covers the endpoints; a browser harness is unplanned. M5-15 is P3 for this reason (D013) and registers only its `ui-server` endpoint test. | maintainer |
| R07 | `src/core/scanner.ts` is touched by M4-03, M4-04, the D019 gap tasks (M2-08, M0-02-R9, M0-17-R6) and M5-19 (external-reference table); parallel lanes on it would conflict. | medium | medium | M5-19 has an interface dependency on M4-03, and the gap tasks depend hard on M4; keep these in one owner's queue. M5-12 was decomposed per ecosystem (M5-19 … M5-24, D019). | maintainer |
| R08 | **Found 2026-11-07 (M7):** `https://gamil.io`, the `author.url` in `package.json` and the website on the owner's GitHub profile, served an expired TLS certificate. The owner chose to link it from the site footer anyway (D045), so visitors who follow it get a browser warning. | high | low | The owner renews the certificate. If the site goes live first, the link is one line in `site/.vitepress/config.ts`. | owner |
