.PHONY: help init uninit scan update sync status export export-wide export-json export-dot export-svg export-svg-grid export-toon \
       query search deps summary trace callers callees impact node files clusters metrics edges \
       routes hooks \
       agents-list agents-generate agents-update agents-mcp agents-mcp-detect \
       serve serve-sse ui workspaces-list workspaces-discover workspaces-sync workspaces-add workspaces-remove lang-list lang-install lang-uninstall \
       bench bench-json \
       test test-full test-clean clean clean-all \
       wasm build build-all build-linux build-linux-arm \
       build-mac-arm build-mac-x64 build-win build-ui \
       package package-linux package-mac-arm package-mac-x64 package-win \
       install install-local install-uninstall \
	   installer installer-linux installer-linux-arm installer-mac-arm installer-mac-x64 installer-win \
       setup version-sync lint typecheck

.DEFAULT_GOAL := help

CLI := npx tsx src/main.ts
DIR ?= $(CURDIR)

# ── Help ──────────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Setup ─────────────────────────────────────────────────────

setup: ## Install dependencies and prepare WASM grammars
	npm install --legacy-peer-deps
	@mkdir -p wasm
	@$(CLI) lang list 2>/dev/null || true
	@echo ""
	@echo "WASM grammars:"
	@ls -lh wasm/*.wasm 2>/dev/null || echo "  Run 'make wasm' to prepare grammars"

version-sync: ## Sync package.json version from root VERSION file
	npx tsx scripts/sync-version.ts
	npm i --legacy-peer-deps

# ── Daily Usage ───────────────────────────────────────────────

init: ## Initialize mapx in a project (make init DIR=/path)
	$(CLI) init $(DIR)

uninit: ## Remove .mapx/ directory and reverse integrations (make uninit DIR=/path)
	$(CLI) uninit $(DIR) --force

scan: ## Full scan of all source files (make scan DIR=/path)
	$(CLI) scan $(DIR)

update: ## Incremental scan (only changed files) (make update DIR=/path)
	$(CLI) update $(DIR)

sync: update ## Alias for update (make sync DIR=/path)

status: ## Show changed files since last scan (make status DIR=/path)
	$(CLI) status $(DIR)

export: ## Export LLM-friendly summary, 8K tokens (make export DIR=/path)
	$(CLI) export --dir=$(DIR)

export-wide: ## Export with larger token budget (16K)
	$(CLI) export --tokens=16384 --dir=$(DIR)

export-json: ## Export in JSON format (make export-json DIR=/path)
	$(CLI) export --format=json --dir=$(DIR)

export-dot: ## Export in DOT format (make export-dot DIR=/path)
	$(CLI) export --format=dot --dir=$(DIR)

export-svg: ## Export in SVG format (make export-svg DIR=/path)
	$(CLI) export --format=svg --dir=$(DIR) -o graph.svg --cluster=auto

export-svg-grid: ## Export in SVG format with grid layout (make export-svg DIR=/path)
	$(CLI) export --format=svg --dir=$(DIR) -o graph-grid.svg --cluster=auto --fallback-grid

export-toon: ## Export in TOON format (make export-toon DIR=/path)
	$(CLI) export --format=toon --dir=$(DIR)

query: ## Search symbols: make query q=ClassName DIR=/path
	@test -n "$(q)" || (echo "Usage: make query q=SearchTerm [DIR=/path]" && exit 1)
	$(CLI) query "$(q)" --dir=$(DIR)

search: ## Advanced search: make search q=Term [k=class] DIR=/path
	@test -n "$(q)" || (echo "Usage: make search q=SearchTerm [k=kind] [DIR=/path]" && exit 1)
	$(CLI) search "$(q)" $(if $(k),--kind $(k),) --dir=$(DIR)

deps: ## Show file dependencies: make deps f=path/to/file DIR=/path
	@test -n "$(f)" || (echo "Usage: make deps f=path/to/file [DIR=/path]" && exit 1)
	$(CLI) deps "$(f)" --dir=$(DIR)

trace: ## Trace data flow: make trace s=SymbolName DIR=/path
	@test -n "$(s)" || (echo "Usage: make trace s=SymbolName [DIR=/path]" && exit 1)
	$(CLI) trace "$(s)" --dir=$(DIR)

callers: ## Trace callers: make callers s=SymbolName [d=depth] DIR=/path
	@test -n "$(s)" || (echo "Usage: make callers s=SymbolName [d=depth] [DIR=/path]" && exit 1)
	$(CLI) callers "$(s)" $(if $(d),--depth $(d),) --dir=$(DIR)

callees: ## Trace callees: make callees s=SymbolName [d=depth] DIR=/path
	@test -n "$(s)" || (echo "Usage: make callees s=SymbolName [d=depth] [DIR=/path]" && exit 1)
	$(CLI) callees "$(s)" $(if $(d),--depth $(d),) --dir=$(DIR)

impact: ## Change impact: make impact s=SymbolName [d=depth] DIR=/path
	@test -n "$(s)" || (echo "Usage: make impact s=SymbolName [d=depth] [DIR=/path]" && exit 1)
	$(CLI) impact "$(s)" $(if $(d),--depth $(d),) --dir=$(DIR)

node: ## Inspect symbol: make node s=SymbolName [src=1] DIR=/path
	@test -n "$(s)" || (echo "Usage: make node s=SymbolName [src=1] [DIR=/path]" && exit 1)
	$(CLI) node "$(s)" $(if $(src),--source,) --dir=$(DIR)

files: ## List files: make files [p=prefix] [l=lang] DIR=/path
	$(CLI) files $(if $(p),--path $(p),) $(if $(l),--lang $(l),) --dir=$(DIR)

clusters: ## List code clusters (make clusters DIR=/path)
	$(CLI) clusters --dir=$(DIR)

metrics: ## Show coupling/instability metrics (make metrics [l=lang] DIR=/path)
	$(CLI) metrics $(if $(l),--lang $(l),) --dir=$(DIR)

edges: ## Query dependency edges (make edges [from=file] [to=file] DIR=/path)
	$(CLI) edges $(if $(from),--from $(from),) $(if $(to),--to $(to),) --dir=$(DIR)

summary: ## Show project summary (make summary DIR=/path)
	$(CLI) summary $(DIR)

serve: ## Start MCP server — stdio (make serve DIR=/path)
	$(CLI) serve --dir=$(DIR) --debug

serve-sse: ## Start MCP server — SSE/HTTP (make serve-sse [PORT=3456] DIR=/path)
	$(CLI) serve --sse --port $(or $(PORT),45123) --dir=$(DIR)

ui: ## Open web dashboard (make ui [PORT=8080] DIR=/path)
	npm run build:npm
	$(CLI) ui $(if $(PORT),--port $(PORT),) --dir=$(DIR)

workspaces-list: ## List registered repos
	$(CLI) workspaces list --dir=$(DIR)

workspaces-discover: ## Discover unregistered repos
	$(CLI) workspaces discover --dir=$(DIR)

workspaces-sync: ## Auto-register discovered repos
	$(CLI) workspaces sync --dir=$(DIR)

workspaces-add: ## Register a new repo (make workspaces-add p=/path/to/repo)
	@test -n "$(p)" || (echo "Usage: make workspaces-add p=/path/to/repo" && exit 1)
	$(CLI) workspaces add $(p) --dir=$(DIR)

workspaces-remove: ## Remove a registered repo (make workspaces-remove n=repo-name)
	@test -n "$(n)" || (echo "Usage: make workspaces-remove n=repo-name" && exit 1)
	$(CLI) workspaces remove $(n) --dir=$(DIR)

lang-list: ## List supported languages
	$(CLI) lang list

lang-install: ## Install language support (make lang-install l=ruby)
	@test -n "$(l)" || (echo "Usage: make lang-install l=language" && exit 1)
	$(CLI) lang install $(l)

lang-uninstall: ## Uninstall language support (make lang-uninstall l=ruby)
	@test -n "$(l)" || (echo "Usage: make lang-uninstall l=language" && exit 1)
	$(CLI) lang uninstall $(l)

routes: ## Show detected framework routes (make routes DIR=/path)
	$(CLI) routes $(DIR)

hooks: ## Show detected framework hooks (make hooks DIR=/path)
	$(CLI) hooks $(DIR)

# ── Agent Integration ─────────────────────────────────────────

agents-list: ## List all supported LLM integration providers
	$(CLI) agents list

agents-generate: ## Generate LLM integration files (make agents-generate [p=antigravity] DIR=/path)
	$(CLI) agents generate $(if $(p),--providers $(p),--all) --dir=$(DIR)

agents-update: ## Update existing agent integration files (make agents-update DIR=/path)
	$(CLI) agents update --dir=$(DIR)

agents-mcp: ## Auto-detect agent tools and generate MCP config files (make agents-mcp DIR=/path)
	$(CLI) agents mcp --dir=$(DIR)

agents-mcp-detect: ## Detect agent tools without writing files (make agents-mcp-detect DIR=/path)
	$(CLI) agents mcp --detect --dir=$(DIR)

# ── Benchmarking ──────────────────────────────────────────────

bench: ## Run token consumption benchmark (make bench DIR=/path)
	npx tsx benchmarks/run.ts $(DIR)

bench-json: ## Run benchmark with JSON output (make bench-json DIR=/path)
	npx tsx benchmarks/run.ts $(DIR) --json

# ── Testing ───────────────────────────────────────────────────

test: ## Quick test: init + scan + export
	rm -rf $(DIR)/.mapx
	$(CLI) init $(DIR)
	$(CLI) scan $(DIR)
	$(CLI) export --dir=$(DIR)

test-full: ## Full test: init + scan + all exports + query + deps + trace + impact
	rm -rf $(DIR)/.mapx
	$(CLI) init $(DIR)
	@echo ""
	@echo "=== SCAN ==="
	$(CLI) scan $(DIR)
	@echo ""
	@echo "=== SUMMARY ==="
	$(CLI) summary $(DIR)
	@echo ""
	@echo "=== EXPORT (LLM) ==="
	$(CLI) export --dir=$(DIR)
	@echo ""
	@echo "=== EXPORT (JSON, first 40 lines) ==="
	$(CLI) export --format=json --dir=$(DIR) | head -40
	@echo ""
	@echo "=== EXPORT (DOT, first 20 lines) ==="
	$(CLI) export --format=dot --dir=$(DIR) | head -20
	@echo ""
	@echo "=== EXPORT (SVG, first 10 lines) ==="
	$(CLI) export --format=svg --dir=$(DIR) | head -10
	@echo ""
	@echo "=== EXPORT (TOON, first 20 lines) ==="
	$(CLI) export --format=toon --dir=$(DIR) | head -20
	@echo ""
	@echo "=== QUERY: Stub ==="
	$(CLI) query "Stub" --dir=$(DIR)
	@echo ""
	@echo "=== SEARCH: class kind ==="
	$(CLI) search "Stub" --kind class --limit 5 --dir=$(DIR) || true
	@echo ""
	@echo "=== DEPS: index.php ==="
	$(CLI) deps "index.php" --dir=$(DIR)
	@echo ""
	@echo "=== FILES (first 10) ==="
	$(CLI) files --limit 10 --dir=$(DIR)
	@echo ""
	@echo "=== CLUSTERS ==="
	$(CLI) clusters --dir=$(DIR) || true
	@echo ""
	@echo "=== STATUS ==="
	$(CLI) status $(DIR)
	@echo ""
	@echo "=== LANG LIST ==="
	$(CLI) lang list

test-clean: ## Clean test: remove .mapx and re-test
	rm -rf $(DIR)/.mapx
	$(MAKE) test DIR=$(DIR)

# ── Lint & Typecheck ──────────────────────────────────────────

typecheck: ## Run TypeScript type checking
	npx tsc --noEmit

lint: typecheck ## Run all checks (typecheck)

# ── WASM Grammars ─────────────────────────────────────────────

wasm: ## Prepare WASM grammar files from npm packages
	npx tsx scripts/build-wasm.ts

# ── Build Binaries ────────────────────────────────────────────

BUN := $(shell which bun 2>/dev/null)

build-all: wasm ## Build binaries for all platforms (requires bun)
ifndef BUN
	$(error "bun is required for building. Install: https://bun.sh")
endif
	npx tsx scripts/build-all.ts

build-linux: wasm ## Build for linux-x64 (requires bun)
ifndef BUN
	$(error "bun is required for building")
endif
	bun build --compile --minify --target=bun-linux-x64 ./src/main.ts --outfile dist/mapx-linux-x64

build-linux-arm: wasm ## Build for linux-arm64 (requires bun)
ifndef BUN
	$(error "bun is required for building")
endif
	bun build --compile --minify --target=bun-linux-arm64 ./src/main.ts --outfile dist/mapx-linux-arm64

build-mac-arm: wasm ## Build for macOS ARM (requires bun)
ifndef BUN
	$(error "bun is required for building")
endif
	bun build --compile --minify --target=bun-darwin-arm64 ./src/main.ts --outfile dist/mapx-darwin-arm64

build-mac-x64: wasm ## Build for macOS x64 (requires bun)
ifndef BUN
	$(error "bun is required for building")
endif
	bun build --compile --minify --target=bun-darwin-x64 ./src/main.ts --outfile dist/mapx-darwin-x64

build-win: wasm ## Build for Windows x64 (requires bun)
ifndef BUN
	$(error "bun is required for building")
endif
	bun build --compile --minify --target=bun-windows-x64 ./src/main.ts --outfile dist/mapx-windows-x64.exe

build: build-linux ## Build for current platform (linux-x64 default)

build-ui: dist/ui/main.js ## Build the Dashboard UI & NPM package

dist/ui/main.js: $(shell find src/ui -type f 2>/dev/null)
	bun run build:npm

# ── Packaging ─────────────────────────────────────────────────

VERSION := $(shell cat VERSION | tr -d '[:space:]')
DIST_DIR := dist/release

pre-package: build-ui version-sync ## Pre-package for release (build UI + sync version)

package-linux: build-ui build-linux ## Package linux-x64 binary as .tar.gz + installer
	bash scripts/package.sh --skip-build linux-x64

package-linux-arm: build-ui build-linux-arm ## Package linux-arm64 binary as .tar.gz + installer
	bash scripts/package.sh --skip-build linux-arm64

package-mac-arm: build-ui build-mac-arm ## Package macOS ARM binary as .tar.gz + installer
	bash scripts/package.sh --skip-build darwin-arm64

package-mac-x64: build-ui build-mac-x64 ## Package macOS x64 binary as .tar.gz + installer
	bash scripts/package.sh --skip-build darwin-x64

package-win: build-ui build-win ## Package Windows binary as .zip + installer
	bash scripts/package.sh --skip-build windows-x64

package: pre-package package-linux ## Package for current platform

package-all: build-ui build-all ## Package all platforms
	bash scripts/package.sh --skip-build all
	@echo ""
	@echo "All packages created in $(DIST_DIR)/:"
	@ls -lh $(DIST_DIR)/*.tar.gz $(DIST_DIR)/*.zip 2>/dev/null

# ── Installation ──────────────────────────────────────────────

PREFIX ?= /usr/local/bin

install-local: build-ui build-linux ## Install to ~/.local/bin (user scope, no sudo needed)
	@LOCAL_SHARE="$(HOME)/.local/share/mapx"; \
	  mkdir -p ~/.local/bin "$$LOCAL_SHARE/wasm" "$$LOCAL_SHARE/queries" "$$LOCAL_SHARE/ui" && \
	  cp dist/mapx-linux-x64 ~/.local/bin/mapx && \
	  chmod +x ~/.local/bin/mapx && \
	  cp -r wasm/. "$$LOCAL_SHARE/wasm/" && \
	  cp -r queries/. "$$LOCAL_SHARE/queries/" && \
	  cp -r dist/ui/. "$$LOCAL_SHARE/ui/" && \
	  echo "Installed to ~/.local/bin/mapx" && \
	  echo "Data:    $$LOCAL_SHARE/" && \
	  echo "" && \
	  echo "Ensure ~/.local/bin is in your PATH"

install: build-ui build-linux ## Install system-wide to $(PREFIX) (may need sudo)
	@SHARE_DIR="$(shell dirname $(PREFIX))/share/mapx"; \
	  mkdir -p $(PREFIX) "$$SHARE_DIR/wasm" "$$SHARE_DIR/queries" "$$SHARE_DIR/ui" && \
	  cp dist/mapx-linux-x64 $(PREFIX)/mapx && \
	  chmod +x $(PREFIX)/mapx && \
	  cp -r wasm/. "$$SHARE_DIR/wasm/" && \
	  cp -r queries/. "$$SHARE_DIR/queries/" && \
	  cp -r dist/ui/. "$$SHARE_DIR/ui/" && \
	  echo "Installed to $(PREFIX)/mapx" && \
	  echo "Data:    $$SHARE_DIR/"

install-uninstall: ## Remove installed binary and data files
	rm -f $(PREFIX)/mapx ~/.local/bin/mapx
	rm -rf $(shell dirname $(PREFIX))/share/mapx ~/.local/share/mapx
	@echo "Uninstalled mapx"

# ── Self-Extracting Installers ────────────────────────────────

installer-linux: package-linux ## Self-extracting installer for linux-x64
	bash scripts/make-installer.sh sh \
		$(DIST_DIR)/mapx-$(VERSION)-linux-x64.tar.gz \
		$(DIST_DIR)/mapx-$(VERSION)-linux-x64-installer.sh \
		$(VERSION) linux-x64

installer-linux-arm: package-linux-arm ## Self-extracting installer for linux-arm64
	bash scripts/make-installer.sh sh \
		$(DIST_DIR)/mapx-$(VERSION)-linux-arm64.tar.gz \
		$(DIST_DIR)/mapx-$(VERSION)-linux-arm64-installer.sh \
		$(VERSION) linux-arm64

installer-mac-arm: package-mac-arm ## Self-extracting installer for macOS ARM
	bash scripts/make-installer.sh sh \
		$(DIST_DIR)/mapx-$(VERSION)-darwin-arm64.tar.gz \
		$(DIST_DIR)/mapx-$(VERSION)-darwin-arm64-installer.sh \
		$(VERSION) darwin-arm64

installer-mac-x64: package-mac-x64 ## Self-extracting installer for macOS x64
	bash scripts/make-installer.sh sh \
		$(DIST_DIR)/mapx-$(VERSION)-darwin-x64.tar.gz \
		$(DIST_DIR)/mapx-$(VERSION)-darwin-x64-installer.sh \
		$(VERSION) darwin-x64

installer-win: package-win ## Self-extracting installer for Windows x64
	bash scripts/make-installer.sh ps1 \
		$(DIST_DIR)/mapx-$(VERSION)-windows-x64.zip \
		$(DIST_DIR)/mapx-$(VERSION)-windows-x64-installer.ps1 \
		$(VERSION)

installer: pre-package installer-linux ## Install for current platform
	bash scripts/make-installer.sh sh \
		$(DIST_DIR)/mapx-$(VERSION)-linux-x64.tar.gz \
		$(DIST_DIR)/mapx-$(VERSION)-linux-x64-installer.sh \
		$(VERSION) linux-x64

installer-all: installer-linux installer-linux-arm installer-mac-arm installer-mac-x64 installer-win ## Build all self-extracting installers
	@echo ""
	@echo "All installers created in $(DIST_DIR)/:"
	@ls -lh $(DIST_DIR)/*-installer.sh $(DIST_DIR)/*-installer.ps1 2>/dev/null || true

# ── Cleanup ───────────────────────────────────────────────────

clean: ## Remove build artifacts and mapx data
	rm -rf .mapx dist/release

clean-all: clean ## Remove everything: dist, wasm, node_modules
	rm -rf dist wasm node_modules

clean-dist: ## Remove only built binaries
	rm -rf dist/mapx-*
