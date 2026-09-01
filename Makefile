# ─────────────────────────────────────────────────────────────────────────────
# kubehive Makefile
#
# Cross-platform by design: works on Windows (GnuWin32 / mingw32-make /
# Chocolatey make running under cmd.exe or Git Bash), macOS and Linux.
#
# Windows compatibility rules used here:
#   1. Every recipe only calls cross-platform tools: npm / npx / cargo / node.
#      No Unix-only utilities (rm, mkdir -p, cp, touch) are required.
#   2. `&&` is used instead of `;` (it works in both cmd.exe and POSIX sh).
#   3. The Rust crate lives in src-tauri/, referenced via
#      `--manifest-path` so no `cd` is needed (avoiding shell differences).
#   4. No hardcoded /usr/bin paths or Unix flags in npm/cargo invocations.
#   5. Sub-targets use hyphens (e.g. `install-all`) instead of colons —
#      some Windows GNU make 3.81 builds (GnuWin32) reject `:` in target
#      names as pattern rules.
#
# Prerequisites:
#   - Node.js 22+  (https://nodejs.org)
#   - Rust stable  (https://rustup.rs) — on Windows use the MSVC toolchain
#   - Tauri CLI is installed as a local dev dependency (npm install)
#   - `make`: Windows users can install it via Git Bash, Chocolatey
#     (choco install make), or MSYS2 (pacman -S make).
# ─────────────────────────────────────────────────────────────────────────────

.DEFAULT_GOAL := help

# Tool overrides — e.g. `make NPM=npm.cmd build` if resolution ever differs.
NPM   ?= npm
NPX   ?= npx
CARGO ?= cargo

# The Rust workspace/crate lives here.
CARGO_MANIFEST := src-tauri/Cargo.toml

# OS detection: Windows_NT is exported by both cmd.exe and Git Bash.
# Used only for display/metadata; recipes themselves stay portable.
ifeq ($(OS),Windows_NT)
  IS_WINDOWS := 1
else
  IS_WINDOWS := 0
endif

.PHONY: help install install-all lint lint-ts lint-rust check fmt fmt-check \
        test verify verify-ui run run-web dev build build-app dist clean

help: ## Show this help message
	@echo "kubehive — available targets"
	@echo "  platform: $(if $(IS_WINDOWS),Windows,Unix)"
	@echo ""
	@echo "  install       Install frontend dependencies (npm install)"
	@echo "  install-all   Install frontend deps + fetch Rust crates"
	@echo "  check         Fast validation: fmt + TypeScript + cargo check"
	@echo "  lint          Type-check frontend + clippy (Rust, -D warnings)"
	@echo "  lint-ts       TypeScript type-check only"
	@echo "  lint-rust     cargo clippy only"
	@echo "  fmt           Format Rust code (cargo fmt)"
	@echo "  fmt-check     Verify Rust formatting (CI style, fails on diffs)"
	@echo "  test          Browser verification suite (Playwright; needs chromium)"
	@echo "  verify        Alias for test"
	@echo "  run           Run the desktop app in dev mode (Tauri + Vite HMR)"
	@echo "  run-web       Run the frontend only in the browser (Vite)"
	@echo "  build         Build the frontend production bundle (tsc + vite)"
	@echo "  build-app     Build the full desktop app (Tauri release bundle)"
	@echo "  clean         Remove build artifacts (dist/ + src-tauri/target/)"

install: ## Install frontend dependencies
	$(NPM) install

install-all: install ## Install frontend deps and fetch Rust crates
	$(CARGO) fetch --manifest-path $(CARGO_MANIFEST)

# ── validation ──────────────────────────────────────────────────────────────

fmt: ## Format Rust code
	$(CARGO) fmt --manifest-path $(CARGO_MANIFEST)

fmt-check: ## Verify Rust formatting (fails on any diff)
	$(CARGO) fmt --manifest-path $(CARGO_MANIFEST) -- --check

lint-ts: ## TypeScript type-check of the frontend
	$(NPX) tsc --noEmit -p tsconfig.json

lint-rust: ## Rust lint via clippy (warnings are errors)
	$(CARGO) clippy --manifest-path $(CARGO_MANIFEST) --all-targets -- -D warnings

lint: lint-ts lint-rust ## Lint frontend (TS) and backend (Rust)

check: fmt-check lint-ts ## Fast validation: format + type-check + Rust compile check
	$(CARGO) check --manifest-path $(CARGO_MANIFEST)

# ── tests ───────────────────────────────────────────────────────────────────

verify-ui: ## Run the full browser verification suite (Playwright)
	$(NPM) run verify:ui

test: verify-ui ## Browser verification suite (alias: verify)

verify: test ## Alias for test

# ── run / build ─────────────────────────────────────────────────────────────

run: ## Run the desktop app in dev mode (Tauri + Vite HMR)
	$(NPM) run tauri dev

dev: run ## Alias for run

run-web: ## Run the frontend only in the browser (Vite dev server)
	$(NPM) run dev

build: ## Build the frontend production bundle (tsc + vite build)
	$(NPM) run build

build-app: ## Build the full desktop app (Tauri release bundle)
	$(NPM) run tauri build

dist: build-app ## Alias for build-app

# ── clean ───────────────────────────────────────────────────────────────────

clean: ## Remove build artifacts (dist/ and src-tauri/target/)
	@node -e "require('fs').rmSync('dist',{recursive:true,force:true});require('fs').rmSync('src-tauri/target',{recursive:true,force:true})"
	$(CARGO) clean --manifest-path $(CARGO_MANIFEST)
