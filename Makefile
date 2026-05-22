.PHONY: help init scan update status export export-json export-dot export-svg \
       query deps summary serve lang-list \
       test test-full test-clean clean clean-all \
       wasm build build-all build-linux build-linux-arm \
       build-mac-arm build-mac-x64 build-win \
       package package-linux package-mac-arm package-mac-x64 package-win \
       install install-local install-uninstall \
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
	npm install
	@mkdir -p wasm
	@$(CLI) lang list 2>/dev/null || true
	@echo ""
	@echo "WASM grammars:"
	@ls -lh wasm/*.wasm 2>/dev/null || echo "  Run 'make wasm' to prepare grammars"

version-sync: ## Sync package.json version from root VERSION file
	npx tsx scripts/sync-version.ts

# ── Daily Usage ───────────────────────────────────────────────

init: ## Initialize codegraph in a project (make init DIR=/path)
	$(CLI) init $(DIR)

scan: ## Full scan of all source files (make scan DIR=/path)
	$(CLI) scan $(DIR)

update: ## Incremental scan (only changed files) (make update DIR=/path)
	$(CLI) update $(DIR)

status: ## Show changed files since last scan (make status DIR=/path)
	$(CLI) status $(DIR)

export: ## Export LLM-friendly summary, 8K tokens (make export DIR=/path)
	$(CLI) export --dir=$(DIR)

export-wide: ## Export with larger token budget (16K)
	$(CLI) export --tokens=16384 --dir=$(DIR)

query: ## Search symbols: make query q=ClassName DIR=/path
	@test -n "$(q)" || (echo "Usage: make query q=SearchTerm [DIR=/path]" && exit 1)
	$(CLI) query "$(q)" --dir=$(DIR)

deps: ## Show file dependencies: make deps f=path/to/file DIR=/path
	@test -n "$(f)" || (echo "Usage: make deps f=path/to/file [DIR=/path]" && exit 1)
	$(CLI) deps "$(f)" --dir=$(DIR)

summary: ## Show project summary (make summary DIR=/path)
	$(CLI) summary $(DIR)

serve: ## Start MCP server for a project (make serve DIR=/path)
	$(CLI) serve --dir=$(DIR)

lang-list: ## List supported languages
	$(CLI) lang list

# ── Testing ───────────────────────────────────────────────────

test: ## Quick test: init + scan + export
	rm -rf $(DIR)/.codegraph
	$(CLI) init $(DIR)
	$(CLI) scan $(DIR)
	$(CLI) export --dir=$(DIR)

test-full: ## Full test: init + scan + all exports + query + deps
	rm -rf $(DIR)/.codegraph
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
	@echo "=== QUERY: Stub ==="
	$(CLI) query "Stub" --dir=$(DIR)
	@echo ""
	@echo "=== DEPS: index.php ==="
	$(CLI) deps "index.php" --dir=$(DIR)
	@echo ""
	@echo "=== STATUS ==="
	$(CLI) status $(DIR)
	@echo ""
	@echo "=== LANG LIST ==="
	$(CLI) lang list

test-clean: ## Clean test: remove .codegraph and re-test
	rm -rf $(DIR)/.codegraph
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

VERSION := $(shell cat VERSION | tr -d '[:space:]')
DIST_DIR := dist/release

package-linux: build-linux ## Package linux-x64 binary as .tar.gz + installer
	bash scripts/package.sh --skip-build linux-x64

package-linux-arm: build-linux-arm ## Package linux-arm64 binary as .tar.gz + installer
	bash scripts/package.sh --skip-build linux-arm64

package-mac-arm: build-mac-arm ## Package macOS ARM binary as .tar.gz + installer
	bash scripts/package.sh --skip-build darwin-arm64

package-mac-x64: build-mac-x64 ## Package macOS x64 binary as .tar.gz + installer
	bash scripts/package.sh --skip-build darwin-x64

package-win: build-win ## Package Windows binary as .zip + installer
	bash scripts/package.sh --skip-build windows-x64

package: package-linux ## Package for current platform

package-all: build-all ## Package all platforms
	bash scripts/package.sh --skip-build all
	@echo ""
	@echo "All packages created in $(DIST_DIR)/:"
	@ls -lh $(DIST_DIR)/*.tar.gz $(DIST_DIR)/*.zip 2>/dev/null

# ── Installation ──────────────────────────────────────────────

PREFIX ?= /usr/local/bin

install-local: build-linux ## Install to ~/.local/bin (user scope, no sudo needed)
	@LOCAL_SHARE="$(HOME)/.local/share/codegraph"; \
	  mkdir -p ~/.local/bin "$$LOCAL_SHARE/wasm" "$$LOCAL_SHARE/queries" && \
	  cp dist/codegraph-linux-x64 ~/.local/bin/codegraph && \
	  chmod +x ~/.local/bin/codegraph && \
	  cp -r wasm/. "$$LOCAL_SHARE/wasm/" && \
	  cp -r queries/. "$$LOCAL_SHARE/queries/" && \
	  echo "Installed to ~/.local/bin/codegraph" && \
	  echo "Data:    $$LOCAL_SHARE/" && \
	  echo "" && \
	  echo "Ensure ~/.local/bin is in your PATH"

install: build-linux ## Install system-wide to $(PREFIX) (may need sudo)
	@SHARE_DIR="$(shell dirname $(PREFIX))/share/codegraph"; \
	  mkdir -p $(PREFIX) "$$SHARE_DIR/wasm" "$$SHARE_DIR/queries" && \
	  cp dist/codegraph-linux-x64 $(PREFIX)/codegraph && \
	  chmod +x $(PREFIX)/codegraph && \
	  cp -r wasm/. "$$SHARE_DIR/wasm/" && \
	  cp -r queries/. "$$SHARE_DIR/queries/" && \
	  echo "Installed to $(PREFIX)/codegraph" && \
	  echo "Data:    $$SHARE_DIR/"

install-uninstall: ## Remove installed binary and data files
	rm -f $(PREFIX)/codegraph ~/.local/bin/codegraph
	rm -rf $(shell dirname $(PREFIX))/share/codegraph ~/.local/share/codegraph
	@echo "Uninstalled codegraph"

# ── Self-Extracting Installers ────────────────────────────────

installer-linux: package-linux ## Self-extracting installer for linux-x64
	bash scripts/make-installer.sh sh \
		$(DIST_DIR)/codegraph-$(VERSION)-linux-x64.tar.gz \
		$(DIST_DIR)/codegraph-$(VERSION)-linux-x64-installer.sh \
		$(VERSION) linux-x64

installer-linux-arm: package-linux-arm ## Self-extracting installer for linux-arm64
	bash scripts/make-installer.sh sh \
		$(DIST_DIR)/codegraph-$(VERSION)-linux-arm64.tar.gz \
		$(DIST_DIR)/codegraph-$(VERSION)-linux-arm64-installer.sh \
		$(VERSION) linux-arm64

installer-mac-arm: package-mac-arm ## Self-extracting installer for macOS ARM
	bash scripts/make-installer.sh sh \
		$(DIST_DIR)/codegraph-$(VERSION)-darwin-arm64.tar.gz \
		$(DIST_DIR)/codegraph-$(VERSION)-darwin-arm64-installer.sh \
		$(VERSION) darwin-arm64

installer-mac-x64: package-mac-x64 ## Self-extracting installer for macOS x64
	bash scripts/make-installer.sh sh \
		$(DIST_DIR)/codegraph-$(VERSION)-darwin-x64.tar.gz \
		$(DIST_DIR)/codegraph-$(VERSION)-darwin-x64-installer.sh \
		$(VERSION) darwin-x64

installer-win: package-win ## Self-extracting installer for Windows x64
	bash scripts/make-installer.sh ps1 \
		$(DIST_DIR)/codegraph-$(VERSION)-windows-x64.zip \
		$(DIST_DIR)/codegraph-$(VERSION)-windows-x64-installer.ps1 \
		$(VERSION)

installer-all: installer-linux installer-linux-arm installer-mac-arm installer-mac-x64 installer-win ## Build all self-extracting installers
	@echo ""
	@echo "All installers created in $(DIST_DIR)/:"
	@ls -lh $(DIST_DIR)/*-installer.sh $(DIST_DIR)/*-installer.ps1 2>/dev/null || true

# ── Cleanup ───────────────────────────────────────────────────

clean: ## Remove build artifacts and codegraph data
	rm -rf .codegraph dist/release

clean-all: clean ## Remove everything: dist, wasm, node_modules
	rm -rf dist wasm node_modules

clean-dist: ## Remove only built binaries
	rm -rf dist/codegraph-*
