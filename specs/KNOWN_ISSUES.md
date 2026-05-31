# MapX Known Issues & Improvements

## General Enhancements

- [x] Improved codebase profiling and architectural analysis
- [x] Poor support for Dart and Mobile apps
- [x] Poor support for Dart dependency resolution
- [ ] Poor support for CSharp and ASP.NET
- [ ] Nested apps (NestJS for example) under monorepos like `apps/backend|apps/api` routes and hooks are not parsed correctly.

## Scanner
- [x] Mapping and associating dependencies between files that are not directly releated in actuality like for example in mapx source itself, the graph shows dependents of `src/framework/detectors/express.ts` to `src/parsers/languages/php.ts` and etc. Likely cause similarity of internal logic of php parser and express detector.
- [x] Improve indexed files by adding support for Markdown, HTML, CSS, and JSON files without parsing their contents, only index them and extract their dependencies and dependants.
- [x] Improve all analysis tools and commands by allowing more relaxed file matching with enhanced wildcard patterns support.
- [x] Improve submodules and repos discovery under the same workspace by scanning all directories up to 3 levels in depth, finding any nested git repositories and prompting the user to track them
- [x] Discovery of nested apps under the same monorepo, for instance a monorepo typically contains `apps/*`, `lib/*` and `packages/*` varying based on its purpose, the idea is to support scanning nested different frameworks and codebased under the same monorepo correctly extracting each app correctly.
- [x] In some projects like MapX itself .ts files may import symbols from other .ts files while using .js file extension, we need a method to support this edgecase.
- [ ] Allow querying symbols using standard notations for example:
```bash
{
  "symbol": "BillingService::getEffectiveLimits"
}
```

## MapX UI:
- [ ] Create MapX 3d graph mode
- [x] Use fCoSE as default graph layout for performance
- [x] Fix layout changing modes issue
- [x] fCoSE layout nodes seem to stack on top of each other without proper spacing
- [x] Improve visualization of clusters in ui graph, this requires clustering improvements by logical breakdown and restructering of files, introducing the concept of layers to auto assign layers to files based on their role in the system.
- [x] Issue with graph not loading or taking too long to load propably due to large number of symbols 1.5k+ and edges 5k+
- [x] No pagination support for Symbol Explorer (loads limited number of items)
- [x] No infinite scroll (auto load more) for Tool Call Log
- [x] Issue with UI server
```bash
# $ mapx ui
Mapx Web Dashboard started at http://127.0.0.1:45124
Mapx UI Server running at http://127.0.0.1:45124
node:_http_server:365
    throw new ERR_HTTP_HEADERS_SENT('write');
          ^

Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client
    at ServerResponse.writeHead (node:_http_server:365:11)
    at Server.<anonymous> (./dist/ui-server.js:582:11) {
  code: 'ERR_HTTP_HEADERS_SENT'
}
```

## Open Questions
- [ ] N/A

## Performance
- [ ] Improve scanning and analysis for large codebases (need to investigate issues with very large code bases consisting of 2k+ to 10k+ files)

## Building and Packaging
- [ ] Fix build stages that always include ui builds at prepare step, instead it should be invoked when needed such that any package or installer steps should invoke it once for any of target OS platforms, before release, or before serving UI in development environment
