# MapX Known Issues & Improvements

## Scanner
- Mapping actually unrelated files like for example in mapx source itself, the graph shows dependents of `src/framework/detectors/express.ts` to `src/parsers/languages/php.ts` and etc. Likely cause similarity of internal logic of php parser and express detector.
- 

## MapX UI:
- Create MapX 3d graph mode
- Improve visualization of clusters in ui graph

## Open Questions
- N/A

## Performance
- Improve scanning and analysis for large codebases (need to investigate issues with very large code bases consisting of 2k+ to 10k+ files)

## Building and Packaging
- Fix build stages that always include ui builds at prepare step, instead it should be invoked when needed such that any package or installer steps should invoke it once for any of target OS platforms, before release, or before serving UI in development environment
