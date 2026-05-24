## Summary

<!-- What does this PR do? One or two sentences. -->

## Motivation

<!-- Why is this change needed? Link to an issue if one exists. -->

Closes #<!-- issue number -->

## Changes

<!-- List the significant changes made. -->

- 
- 

## Type of change

<!-- Check all that apply. -->

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Performance improvement
- [ ] Refactor (no behaviour change)
- [ ] Documentation
- [ ] Tests
- [ ] Build / CI

## Testing

<!-- Describe how you tested this. Include commands if applicable. -->

```bash
# Running tests
make test DIR=/path/to/sample-project

# Verify using global/local CLI
mapx scan /path/to/sample-project
mapx export --dir /path/to/sample-project

# Verify using zero-installation (npx)
npx @mgamil/mapx scan /path/to/sample-project
```

## Checklist

- [ ] Code follows the existing style of the project
- [ ] Self-review completed
- [ ] TypeScript type-check passes (`npx tsc --noEmit`)
- [ ] Tested against at least one real project
- [ ] NPM dependency lock (`package-lock.json`) is synchronized and tracked (run `make version-sync` if version was bumped)
- [ ] Prebuilt binary packaging builds successfully (run `make package-linux` or `make package-all` if packaging/distribution changes were made)
- [ ] New or changed CLI flags are documented in `docs/cli-reference.md`
- [ ] New or changed MCP tools are documented in `docs/mcp-integration.md`
- [ ] Agentic integration templates and pre-planning rules (`AGENTS.md`, `.agents/rules/mapx.md`) are updated if MCP tool/command signatures or behavior changed

## Notes for reviewers

<!-- Anything that needs special attention, known limitations, or follow-up work. -->

