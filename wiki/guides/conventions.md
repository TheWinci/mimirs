# Conventions

Patterns and conventions observed across the mimirs codebase. All examples below come from real source — nothing hypothetical. Where the project has no consistent rule, the section is skipped rather than invented.

## Naming

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case with role suffix | `hybrid.ts`, `git-history.ts`, `search-cmd.ts`, `dir-guard.ts` |
| Module entry | `index.ts` that re-exports a narrow surface | `src/db/index.ts`, `src/cli/index.ts`, `src/wiki/index.ts` |
| Types / interfaces | PascalCase | `RagDB`, `RagConfig`, `EmbeddedChunk`, `DiscoveryResult`, `ConversationTurn` |
| Functions | camelCase, verb-first | `embedBatch`, `upsertFileStart`, `resolveImports`, `buildTurnText` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_HYBRID_WEIGHT`, `MIN_MODULE_VALUE`, `SKIP_CONTENT_TOOLS`, `TAIL_DEBOUNCE_MS`, `DANGEROUS_DIRS` |
| CLI commands | camelCase exported, kebab or single-word on the command line | `searchCommand` → `mimirs search`, `indexCommand` → `mimirs index`, `benchmarkModelsCommand` → `mimirs benchmark-models` |
| Test files | mirror source path under `tests/`, `.test.ts` suffix | `src/search/hybrid.ts` → `tests/search/hybrid-search.test.ts` |

## Tooling: bun, not npm

Every project command runs under Bun. The `package.json` scripts (`server`, `cli`, `test`, `bench`, `tsc`, `bump`) all start with `bun` or `bunx`. There is no `node` invocation anywhere in the repo and no transpile step — TypeScript is executed directly. When documenting a CLI invocation, always use `bun` / `bunx` / `bun run` — never `npm` or `npx`. This is spelled out in `CLAUDE.md` as a project-wide rule.

## File Organization

Source lives under `src/`, tests under `tests/`, benchmarks under `benchmarks/`. Each top-level directory under `src/` is a module: a small set of files behind an entry that re-exports a narrow surface. Most files start with ES-module imports, then module-local constants (`UPPER_SNAKE_CASE`), then exported functions and types. There are no barrel files beyond the module entry — deep imports are encouraged when a consumer only needs one helper (e.g. `src/db/files.ts` is imported directly by `src/indexing/indexer.ts`).

Modules with many small files use a sub-directory plus `index.ts`: `src/db/index.ts` is the public facade (the `RagDB` class plus row-shape types) and forwards to `src/db/files.ts`, `src/db/graph.ts`, `src/db/conversation.ts`, `src/db/git-history.ts`, `src/db/types.ts`. Modules with one file don't bother with a directory (see `src/embeddings/embed.ts`, `src/graph/resolver.ts`). The [wiki](../modules/wiki/index.md) module uses the same facade pattern as `db/`.

## Types and Validation

Types live next to the code that owns them (`src/db/types.ts`, `src/wiki/types.ts`, top-level `src/types.ts` for cross-module shapes). Zod schemas are used at trust boundaries: `RagConfig` in `src/config/index.ts` is validated with Zod on load, and the loader self-heals malformed JSON rather than crashing. Inside the codebase, plain TypeScript interfaces carry the shapes — Zod is reserved for parsing untrusted input (config files, MCP tool arguments).

## Error Handling

mimirs throws `Error` for programming errors and unreachable states, and logs + degrades gracefully for runtime failures that the user shouldn't see as a stack trace. The consistent pattern is **narrow `try` blocks around the fallible call, `log.debug` on catch, fall through to a cheaper path**. The hybrid search is the canonical example:

```ts
// src/search/hybrid.ts
let textResults: typeof vectorResults = [];
try {
  textResults = db.textSearch(query, topK * 4);
} catch (err) {
  log.debug(`FTS query failed, falling back to vector-only: ${err instanceof Error ? err.message : err}`, "search");
}
```

The chunker uses the same pattern when AST parsing fails — catch at the file boundary, fall back to heuristic splitting, keep indexing. The CLI entry (`src/cli/index.ts`) is the single place that catches top-level errors; everything else lets errors propagate to it.

## Logging

All output goes through two helpers in `src/utils/log.ts`:

- `log` — structured internal logging (`log.debug`, `log.info`, `log.warn`, `log.error`) with optional module tags. Suppressed when mimirs runs as an MCP server (stdio would corrupt the protocol).
- `cli` — human-facing output for CLI subcommands (`cli.log`, `cli.error`). Always safe to call from command files.

Command files never `console.log` directly; they use `cli`. Library code never uses `cli`; it uses `log`.

## Common Patterns

### Two-phase pipelines with a resume primitive

The file indexer, conversation tail, and git-history indexer all follow the same shape: **read where we left off → process new work → record a new resume point in one transaction**. `files.hash` for the code indexer, `conversation_sessions.readOffset` for the tail, `git_commits.hash` + `getLastIndexedCommit` for history. This is what makes every ingest path safe to re-run.

```ts
// src/conversation/indexer.ts — shape shared by all three
const { entries, newOffset } = readJSONL(path, fromOffset);
// …process each entry…
db.upsertSession(sessionId, path, firstTs, mtime, newOffset);
```

### Command wrapper around `RagDB`

Every CLI subcommand under `src/cli/commands/*` follows the same skeleton: resolve the project directory, open `RagDB`, `loadConfig`, `applyEmbeddingConfig`, call the domain function, print, close. Consistency across 19 commands means adding a new one is mechanical.

```ts
// src/cli/commands/search-cmd.ts
const db = new RagDB(dir);
const config = await loadConfig(dir);
applyEmbeddingConfig(config);
const results = await search(query, db, top, 0, config.hybridWeight, config.generated, filter);
db.close();
```

### `RagDB` as the only persistence boundary

No module outside `src/db/` opens a `Database` handle. `embeddings`, `search`, `wiki`, `conversation`, and the graph resolver all take a `RagDB` and call methods. Any new persistence concern lives as a new method on `RagDB` plus a small helper file under `src/db/` — the facade forwards, the caller stays clean.

### Trigger-driven FTS sync

`chunks`, `conversation_turn_chunks`, and `git_commits` each have matching `*_ai` / `*_ad` / `*_au` triggers that propagate writes into their FTS5 mirror. Callers never touch the FTS table directly; the schema enforces consistency so no code path can forget to update it.

## Import Conventions

Imports are grouped in three blocks, with a blank line between groups:

1. **Node / Bun built-ins** — `path`, `fs/promises`, `bun:sqlite`, `stream`, etc.
2. **External packages** — `@modelcontextprotocol/sdk`, `sqlite-vec`, `@winci/bun-chunk`, `zod`, `@huggingface/transformers`.
3. **Relative internal imports** — `../db`, `./chunker`, `../utils/log`.

Relative imports are the rule — there are no path aliases. Deep imports within a module are fine (`src/db/files`) and preferred over re-exporting through the entry when only one symbol is needed. The entry files (`src/db/index.ts`, `src/wiki/index.ts`, etc.) exist for **external** consumers of the module — internal files inside a module reach for each other directly.

## See also

- [Architecture](../architecture.md)
- [Data Flows](../data-flows.md)
- [Getting Started](getting-started.md)
- [Testing](testing.md)
- [Index](../index.md)
