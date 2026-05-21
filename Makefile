.PHONY: help init scan update status export export-json export-dot \
       query deps summary serve lang-list \
       test test-full test-clean clean clean-all \
       wasm build build-all build-linux build-linux-arm \
       build-mac-arm build-mac-x64 build-win \
       package package-linux package-mac-arm package-mac-x64 package-win \
       install install-local install-uninstall \
       setup lint typecheck

.DEFAULT_GOAL := help

CLI := npx tsx src/main.ts
CWD ?= $(CURDIR)

# ── Help ──────────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Setup ─────────────────────────────────────────────────────

setup: ## Install dependencies and prepare WASM grammars
	npm install
	@mkdir -p wasm
	@$(CLI) lang list 2>/dev/null || true
	@echo ""
	@echo "WASM grammars:"
	@ls -lh wasm/*.wasm 2>/dev/null || echo "  Run 'make wasm' to prepare grammars"

# ── Daily Usage ───────────────────────────────────────────────

init: ## Initialize codegraph in current directory
	$(CLI) init --cwd $(CWD)

scan: ## Full scan of all source files
	$(CLI) scan --cwd $(CWD)

update: ## Incremental scan (only changed files)
	$(CLI) update --cwd $(CWD)

status: ## Show changed files since last scan
	$(CLI) status --cwd $(CWD)

export: ## Export LLM-friendly summary (default: 4096 tokens)
	$(CLI) export --cwd $(CWD)

export-json: ## Export full graph as JSON
	$(CLI) export --format=json --cwd $(CWD)

export-dot: ## Export graph as GraphViz DOT
	$(CLI) export --format=dot --cwd $(CWD)

export-wide: ## Export with larger token budget (8K)
	$(CLI) export --tokens=8192 --cwd $(CWD)

query: ## Search symbols: make query q=ClassName
	@test -n "$(q)" || (echo "Usage: make query q=SearchTerm" && exit 1)
	$(CLI) query "$(q)" --cwd $(CWD)

deps: ## Show file dependencies: make deps f=path/to/file
	@test -n "$(f)" || (echo "Usage: make deps f=path/to/file" && exit 1)
	$(CLI) deps "$(f)" --cwd $(CWD)

summary: ## Show project summary
	$(CLI) summary --cwd $(CWD)

serve: ## Start MCP server (stdio transport)
	$(CLI) serve

lang-list: ## List supported languages
	$(CLI) lang list

# ── Testing ───────────────────────────────────────────────────

test: ## Quick test: init + scan + export
	rm -rf $(CWD)/.codegraph
	$(CLI) init --cwd $(CWD)
	$(CLI) scan --cwd $(CWD)
	$(CLI) export --cwd $(CWD)

test-full: ## Full test: init + scan + all exports + query + deps
	rm -rf $(CWD)/.codegraph
	$(CLI) init --cwd $(CWD)
	@echo ""
	@echo "=== SCAN ==="
	$(CLI) scan --cwd $(CWD)
	@echo ""
	@echo "=== SUMMARY ==="
	$(CLI) summary --cwd $(CWD)
	@echo ""
	@echo "=== EXPORT (LLM) ==="
	$(CLI) export --cwd $(CWD)
	@echo ""
	@echo "=== EXPORT (JSON, first 40 lines) ==="
	$(CLI) export --format=json --cwd $(CWD) | head -40
	@echo ""
	@echo "=== EXPORT (DOT, first 20 lines) ==="
	$(CLI) export --format=dot --cwd $(CWD) | head -20
	@echo ""
	@echo "=== QUERY: Stub ==="
	$(CLI) query "Stub" --cwd $(CWD)
	@echo ""
	@echo "=== DEPS: index.php ==="
	$(CLI) deps "index.php" --cwd $(CWD)
	@echo ""
	@echo "=== STATUS ==="
	$(CLI) status --cwd $(CWD)
	@echo ""
	@echo "=== LANG LIST ==="
	$(CLI) lang list

test-clean: ## Clean test: remove .codegraph and re-test
	rm -rf $(CWD)/.codegraph
	$(MAKE) test CWD=$(CWD)

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
	bun build --compile --minify --bytecode --target=bun-linux-x64 ./src/main.ts --outfile dist/codegraph-linux-x64

build-linux-arm: wasm ## Build for linux-arm64 (requires bun)
ifndef BUN
	$(error "bun is required for building")
endif
	bun build --compile --minify --bytecode --target=bun-linux-arm64 ./src/main.ts --outfile dist/codegraph-linux-arm64

build-mac-arm: wasm ## Build for macOS ARM (requires bun)
ifndef BUN
	$(error "bun is required for building")
endif
	bun build --compile --minify --bytecode --target=bun-darwin-arm64 ./src/main.ts --outfile dist/codegraph-darwin-arm64

build-mac-x64: wasm ## Build for macOS x64 (requires bun)
ifndef BUN
	$(error "bun is required for building")
endif
	bun build --compile --minify --bytecode --target=bun-darwin-x64 ./src/main.ts --outfile dist/codegraph-darwin-x64

build-win: wasm ## Build for Windows x64 (requires bun)
ifndef BUN
	$(error "bun is required for building")
endif
	bun build --compile --minify --bytecode --target=bun-windows-x64 ./src/main.ts --outfile dist/codegraph-windows-x64.exe

build: build-linux ## Build for current platform (linux-x64 default)

# ── Packaging ─────────────────────────────────────────────────

VERSION := $(shell node -p "require('./package.json').version")
DIST_DIR := dist/release

package-linux: build-linux ## Package linux-x64 binary as .tar.gz
	@mkdir -p $(DIST_DIR)
	@echo "Packaging codegraph-$(VERSION)-linux-x64..."
	cp dist/codegraph-linux-x64 dist/codegraph
	chmod +x dist/codegraph
	tar -czf $(DIST_DIR)/codegraph-$(VERSION)-linux-x64.tar.gz \
		-C dist codegraph \
		-C $(CURDIR) AGENTS.md \
		-C $(CURDIR) queries/ \
		-C $(CURDIR) docs/
	rm dist/codegraph
	@echo "Created: $(DIST_DIR)/codegraph-$(VERSION)-linux-x64.tar.gz"

package-linux-arm: build-linux-arm ## Package linux-arm64 binary as .tar.gz
	@mkdir -p $(DIST_DIR)
	cp dist/codegraph-linux-arm64 dist/codegraph
	chmod +x dist/codegraph
	tar -czf $(DIST_DIR)/codegraph-$(VERSION)-linux-arm64.tar.gz \
		-C dist codegraph \
		-C $(CURDIR) AGENTS.md \
		-C $(CURDIR) queries/ \
		-C $(CURDIR) docs/
	rm dist/codegraph
	@echo "Created: $(DIST_DIR)/codegraph-$(VERSION)-linux-arm64.tar.gz"

package-mac-arm: build-mac-arm ## Package macOS ARM binary as .tar.gz
	@mkdir -p $(DIST_DIR)
	cp dist/codegraph-darwin-arm64 dist/codegraph
	chmod +x dist/codegraph
	tar -czf $(DIST_DIR)/codegraph-$(VERSION)-darwin-arm64.tar.gz \
		-C dist codegraph \
		-C $(CURDIR) AGENTS.md \
		-C $(CURDIR) queries/ \
		-C $(CURDIR) docs/
	rm dist/codegraph
	@echo "Created: $(DIST_DIR)/codegraph-$(VERSION)-darwin-arm64.tar.gz"

package-mac-x64: build-mac-x64 ## Package macOS x64 binary as .tar.gz
	@mkdir -p $(DIST_DIR)
	cp dist/codegraph-darwin-x64 dist/codegraph
	chmod +x dist/codegraph
	tar -czf $(DIST_DIR)/codegraph-$(VERSION)-darwin-x64.tar.gz \
		-C dist codegraph \
		-C $(CURDIR) AGENTS.md \
		-C $(CURDIR) queries/ \
		-C $(CURDIR) docs/
	rm dist/codegraph
	@echo "Created: $(DIST_DIR)/codegraph-$(VERSION)-darwin-x64.tar.gz"

package-win: build-win ## Package Windows binary as .zip
	@mkdir -p $(DIST_DIR)
	@echo "Packaging codegraph-$(VERSION)-windows-x64..."
	cp dist/codegraph-windows-x64.exe dist/codegraph.exe
	cd dist && zip -j $(CURDIR)/$(DIST_DIR)/codegraph-$(VERSION)-windows-x64.zip \
		codegraph.exe
	cp AGENTS.md queries/ docs/ /tmp/codegraph-win-staging/ 2>/dev/null || true
	rm dist/codegraph.exe
	@echo "Created: $(DIST_DIR)/codegraph-$(VERSION)-windows-x64.zip"

package: package-linux ## Package for current platform

package-all: package-linux package-linux-arm package-mac-arm package-mac-x64 package-win ## Package all platforms
	@echo ""
	@echo "All packages created in $(DIST_DIR)/:"
	@ls -lh $(DIST_DIR)/*.tar.gz $(DIST_DIR)/*.zip 2>/dev/null

# ── Installation ──────────────────────────────────────────────

PREFIX ?= /usr/local/bin

install-local: ## Install to user's ~/.local/bin
	@mkdir -p ~/.local/bin
	@test -f dist/codegraph-linux-x64 || (echo "Run 'make build-linux' first" && exit 1)
	cp dist/codegraph-linux-x64 ~/.local/bin/codegraph
	chmod +x ~/.local/bin/codegraph
	@echo "Installed to ~/.local/bin/codegraph"
	@echo "Ensure ~/.local/bin is in your PATH"

install: ## Install system-wide (requires sudo)
	@test -f dist/codegraph-linux-x64 || (echo "Run 'make build-linux' first" && exit 1)
	cp dist/codegraph-linux-x64 $(PREFIX)/codegraph
	chmod +x $(PREFIX)/codegraph
	@echo "Installed to $(PREFIX)/codegraph"

install-uninstall: ## Remove installed binary
	rm -f $(PREFIX)/codegraph ~/.local/bin/codegraph
	@echo "Uninstalled codegraph"

# ── Cleanup ───────────────────────────────────────────────────

clean: ## Remove build artifacts and codegraph data
	rm -rf .codegraph dist/release

clean-all: clean ## Remove everything: dist, wasm, node_modules
	rm -rf dist wasm node_modules

clean-dist: ## Remove only built binaries
	rm -rf dist/codegraph-*
