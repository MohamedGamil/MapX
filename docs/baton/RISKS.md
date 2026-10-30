# Risks

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- | --- |
| R01 | Most legacy iterations (I01–I22) were only verified at baseline level; hidden false completions are likely, given that 2 of the 6 checked were disputed. | high | medium | Run `baton-review --full` with independent reviewers; add remediation tasks. | maintainer |
| R02 | Report item 13 (~10k cross-language edges) did not reproduce on a minimal fixture; the pilot pattern is unknown. | medium | high | M2-01 starts with a spike, then makes the filter fail-closed regardless. | maintainer |
| R03 | Regex-based Laravel extraction may not scale to mount graphs (require, providers, conditionals). | medium | high | M1-01 fixture first; if M1-03 or M1-07 exceed their estimate, split them and consider an AST-based PHP pass. | maintainer |
| R04 | `tsc` covers only `src/`; tests and scripts can carry type errors. | medium | low | Add a `tsconfig.check.json` including tests and scripts (unplanned). | maintainer |
| R05 | The dashboard bundle (689 KB gzipped, plus a 7.8 MB source map) inflates the npm package. | high | low | M0-15-R1, after an owner decision. | owner |
