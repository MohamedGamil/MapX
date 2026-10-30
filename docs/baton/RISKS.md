# Risks

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- | --- |
| R01 | **Materialised 2026-10-31 (M0-41):** 0 of 16 audited legacy iterations fully confirmed; 6 falsely complete. Mitigation: 18 remediation tasks scheduled before M3 (D010). | — | high | Execute the remediation queue with /baton; re-audit with baton-review after. | maintainer |
| R02 | Report item 13 (~10k cross-language edges) did not reproduce on a minimal fixture; the pilot pattern is unknown. | medium | high | M2-01 starts with a spike, then makes the filter fail-closed regardless. | maintainer |
| R03 | Regex-based Laravel extraction may not scale to mount graphs (require, providers, conditionals). | medium | high | M1-01 fixture first; if M1-03 or M1-07 exceed their estimate, split them and consider an AST-based PHP pass. | maintainer |
| R04 | ~~`tsc` covers only `src/`~~ **Closed 2026-10-30 by M0-40**: `npm run typecheck` covers src, tests and scripts. | — | — | — | — |
| R05 | The dashboard bundle (689 KB gzipped, plus a 7.8 MB source map) inflates the npm package. | high | low | M0-15-R1, after an owner decision. | owner |
| R06 | Dashboard UI behaviour (graph explorer, layouts, health tab) has no automated test; only its server endpoints can be covered without a browser harness. | medium | medium | M0-39 covers the endpoints; a browser harness is unplanned. | maintainer |
