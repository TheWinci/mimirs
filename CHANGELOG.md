# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-06-01

### Added
- **`impact` tool**: symbol-level blast radius — the transitive callers of a function or method as a pruned call tree, plus the test files to run for the change (precise = tests that reference the symbol, broad = tests that import affected files). The printed tree is bounded by `depth` and a node budget and prunes ambient (high fan-in) callers, but a second count pass reports the true caller/file totals so the headline count stays honest. Backed by `src/graph/trace.ts` and new reverse-edge graph queries in `src/db/graph.ts` (`getCallersOfExport`, `getCallersOfLocalSymbol`, `getCallablesByName`)
- **`trace` tool**: how one symbol reaches another — the reachable call sub-graph from `from` to `to` (the set forward-reachable from the source intersected with the set backward-reachable to the target), with branches that never reach the target pruned and the shortest path highlighted as a spine. Resolution is static name-matching, so an unresolved dynamic-dispatch hop ends a chain and is reported as a no-path frontier
- **`mimirs affected` CLI**: the test files affected by a set of changed files, by walking the transitive importer graph and keeping the tests. Reads file arguments, `--stdin` (e.g. `git diff --name-only | mimirs affected --stdin`), or auto-detects from `git diff --name-only HEAD`; `--quiet` prints bare paths for piping into a test runner and `--json` prints the full result

### Changed
- **Breaking — MCP tools renamed, no aliases**: `find_usages` → `usages` and `depended_on_by` → `dependents`. Update permission allowlists to `mcp__mimirs__usages` and `mcp__mimirs__dependents` (clients pick up the new names on reconnect). The `project_map` reverse-dependency output label changed to match: `depended_on_by:` → `dependents:`
- Shared the test-path patterns (`src/utils/test-paths.ts`) and the transitive-importer closure (`transitiveImporters`) between search ranking, the `impact` tool, and the `affected` CLI

## [1.3.0] - 2026-05-28 to 2026-05-31

### Added
- **Flow-based wiki generation**: a page per externally-triggered flow (CLI subcommand, MCP tool, server start, route) instead of community/aggregate grouping, via a `wiki shape` → discovery → `wiki write:page:<slug>` workflow with prose served from editable instructions
- **`wiki update`**: cause-based change detection regenerates only the pages a source change affects, falling back to a full rebuild when too much changed
- **`wiki changelog` command**: curated, per-version entries for the generated wiki's own changelog
- Index every project conversation via a folder watch, not just the active session

### Changed
- Wiki generation prose moved out of code into editable markdown under `src/wiki/instructions/`
- Flow pages pick the diagram type that best fits each flow

### Fixed
- Correctness fixes from a codebase review; doc/code drift in `map` help and the agent tool list; community/pipeline vocabulary no longer leaks into generated pages

## [1.2.0] - [1.2.5] - 2026-04-26 to 2026-04-28

### Added
- **Community-organized wiki** (Louvain): groups related modules into wiki sections via Louvain community detection — later superseded by flow-based generation in 1.3.0
- Backend-service-aware wiki generation
- Aggregate-page sharding: large sections split into folders once they pass size thresholds
- Richer wiki update logging

### Changed
- Wiki regenerates on version bump only, not on every change

### Fixed
- Windows path-separator normalization
- Broken generated mermaid diagrams
- Incremental wiki update incorrectly falling back to a full regeneration
- Aggregate page sharding edge cases

## [1.1.3] - [1.1.8] - 2026-04-19 to 2026-04-21

### Added
- Louvain community-detection groundwork for wiki organization

### Fixed
- Large-project handling in graph/wiki generation: removed overly tight graph-size caps and batched SQL to stay under the parameter limit
- Wiki incremental generation when a manifest is present; first-generation logging and LLM-authored prose; per-phase console logging during generation
- Restored the Claude Code plugin after the package rename; corrected the `demo` command

## [1.1.0] - [1.1.2] - 2026-04-17 to 2026-04-18

### Added
- **Scoped search filters**: `extensions`, `dirs`, `excludeDirs` on `search` and `read_relevant` tools, plus CLI flags `--ext`, `--in`, `--exclude`. Filters apply in SQL before ranking so scoped top-K isn't starved; extension matching accepts values with or without the leading dot
- **Incremental wiki update**: `src/wiki/staleness.ts` detects stale pages from git diff and regenerates only affected sections
- **Deterministic wiki generation**: `wiki-tools.ts` split into focused modules under `src/wiki/` (categorization, content-prefetch, discovery, page-tree, page-payload, section-selector) with exemplar and section templates

## [1.0.3] - [1.0.9] - 2026-04-10 to 2026-04-13

### Added
- **Git history indexing**: `search_commits` and `file_history` MCP tools backed by a new git indexer (`src/git/indexer.ts`, `src/db/git-history.ts`) and `mimirs history index` CLI command
- Symbol-aware graph resolver (`src/graph/resolver.ts`) feeding richer `search` and `project_map` results in preparation for wiki generation
- Live current-file and embedding progress display during `mimirs index`

### Changed
- Relaxed or removed overly conservative caps on arguments to checkpoint, conversation, git-history, graph, and search tools
- CLI indexing progress trimmed: total chunk count removed

### Fixed
- Config pattern matching: exclude/include suffix patterns now match at any path depth, not just the project root
- Indexer skips obfuscated files detected via heuristics
- Assorted TypeScript type errors
- `init` command output cleaned up

## [1.0.1] - [1.0.2] - 2026-04-08

### Added
- `delete_annotation` MCP tool for removing stale annotations

### Changed
- Docs: mimirs logo, wiki screenshot, and Mimir origin story in README; benchmarks refreshed

## [1.0.0] - 2026-04-08

### Changed
- **Renamed from `@winci/local-rag` to `mimirs`**
- Data directory changed from `.rag/` to `.mimirs/`
- CLI command changed from `local-rag` to `mimirs`
- Log prefix changed from `[local-rag]` to `[mimirs]`
- Input validation on all MCP tools: `top`/`limit` capped at 100, `query` max 2000 chars, `threshold` validated 0-1, `directory` checked for existence
- Console output routed through structured `cli` logger (`src/utils/log.ts`)
- TypeScript `catch (err: any)` replaced with `catch (err: unknown)` across all source files
- SQLite detection expanded: Linux paths added, doctor command now tests actual extension loading
- Watcher race condition fixed: serial queue prevents concurrent `indexFile` + `buildPathToIdMap` interleaving
- Plugin license corrected from MIT to Apache-2.0
- `setup.ts` JSON.parse wrapped in try-catch for malformed MCP configs

### Added
- Wiki tools test coverage (7 tests for `generate_wiki`)
- `src/utils/log.ts` now exports both `log` (MCP stderr diagnostics) and `cli` (CLI stdout output)

## [0.6.0] - [0.6.13] - 2026-03 to 2026-04

### Added
- `generate_wiki` tool: structured markdown wiki generation from semantic index
- `cleanup` command: reverts everything `init` creates
- JetBrains (Junie) IDE support
- Dart language support
- Claude Code plugin with marketplace support, skills, and hooks (SessionStart, PostToolUse, SessionEnd)
- Server info tool showing connected databases and config

### Changed
- README restructured for marketing impact
- Dynamic import for `serve` command to prevent CLI crashes on missing native deps

### Fixed
- Process ID guarding on status file
- Early status writes during server startup
- Less permanent failures on transient DB errors

## [0.5.0] - 2026-03

### Changed
- Apache 2.0 license

## [0.4.0] - 2026-03

### Added
- Parent chunk promotion: if 2+ sub-chunks reference the same parent, promote the parent embedding
- AST sub-chunk embedding with merge into single chunk vector

## [0.3.0] - [0.3.26] - 2026-02 to 2026-03

### Added
- `doctor` command for diagnosing MCP server startup issues
- `find_usages` tool for discovering call sites before refactoring
- `git_context` tool showing uncommitted changes with index status
- `annotate` / `get_annotations` tools for persistent notes on files/symbols
- `search_symbols` and `write_relevant` tools
- Batch indexing and `bunx init` setup command
- Checkpoints (decision, milestone, blocker, direction_change, handoff)
- Conversation search across Claude Code sessions
- Server info and connected database monitoring

### Changed
- Reorganized project structure
- Improved dir walking and exclusion patterns

### Fixed
- Nested `node_modules` exclusion
- IDE rules folder creation
- Large project indexing support
- Status file process ID guarding

## [0.2.0] - [0.2.4] - 2026-02

### Added
- Incremental chunking with content hashing
- Dependency graph with `project_map`, `depends_on`, `depended_on_by`
- Configurable embedding models
- Benchmark and eval CLI commands
- CSS/SCSS/LESS language support

### Changed
- Hybrid search weights made configurable via `.rag/config.json`

## [0.1.0] - [0.1.23] - 2026-01 to 2026-02

### Added
- Initial release: local-first RAG MCP server
- Hybrid vector + BM25 search with sqlite-vec and FTS5
- AST-aware chunking via tree-sitter (20+ languages)
- `search`, `read_relevant` MCP tools
- Conversation indexing from Claude Code JSONL transcripts
- Search analytics with zero-result and low-relevance tracking
- File watcher with 2-second debounce for auto re-indexing
- In-process embeddings via Transformers.js + ONNX (all-MiniLM-L6-v2)

### Fixed
- Model cache moved to stable user-level location
- Guard for IDE spawning MCP outside project directory
- Home directory guard to prevent accidental indexing
