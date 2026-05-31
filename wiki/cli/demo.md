# CLI: demo

`mimirs demo` is a guided, read-only tour of the core search features. It indexes a project, then runs three of the most-used capabilities — file search, chunk-level reading, and symbol listing — against one fixed query, printing colored, paced terminal output. It exists so a first-time user can see what mimirs does end to end in one command, without learning the flag surface of `index`, `search`, `read`, and `search_symbols` first. The closing screen points them at `mimirs init` to wire the tools into an editor.

The whole flow lives in one handler, `demoCommand`, in `src/cli/commands/demo.ts:36`. It is intentionally simple: it calls the same library functions the real CLI commands and MCP tools call, so the output is representative rather than mocked.

## How it is reached

The CLI entry parses `process.argv` once at module load: `args = process.argv.slice(2)` and `command = args[0]` (`src/cli/index.ts:25`). When the command is `demo`, `dispatch()` calls `demoCommand(args)` (`src/cli/index.ts:166`). The whole `args` array is forwarded, so inside the handler `args[0]` is still the literal string `"demo"` and `args[1]` is the optional directory.

The handler resolves the target directory defensively: it uses `args[1]` only when it exists and does not start with `--`, otherwise it falls back to the current directory, then makes it absolute with `resolve` (`src/cli/commands/demo.ts:37`). This means `mimirs demo` and `mimirs demo .` behave identically, and a stray flag in `args[1]` will not be mistaken for a path.

## What runs, step by step

```mermaid
sequenceDiagram
  autonumber
  participant User
  participant Router as src/cli/index.ts
  participant Handler as demoCommand
  participant Indexer as indexDirectory
  participant DB as RagDB
  participant Search as hybrid search
  User->>Router: mimirs demo [dir]
  Router->>Handler: demoCommand(args)
  Handler->>Handler: resolve dir, new RagDB(dir), loadConfig(dir)
  Handler->>Indexer: indexDirectory(dir, db, config, progress)
  Indexer->>DB: write/update file + chunk rows
  Indexer-->>Handler: { indexed, skipped, pruned }
  Handler->>Search: search(demoQuery, db, 3, ...)
  Search->>DB: vector + BM25 + symbol expansion
  Search-->>Handler: top 3 files with snippets
  Handler->>Search: searchChunks(demoQuery, db, 2, 0.3, ...)
  Search-->>Handler: ranked chunks with line ranges
  Handler->>DB: searchSymbols(listing, top 200)
  DB-->>Handler: exported symbols + reference counts
  Handler->>Handler: filter, sort by referenceCount, take top 5
  Handler->>User: colored output + init hint
  Handler->>DB: db.close()
```

1. **Setup.** The handler prints a banner and the resolved target directory, then opens the database with `new RagDB(dir)` and loads project settings with `loadConfig(dir)` (`src/cli/commands/demo.ts:45-46`). Both are the same primitives every other command uses, so the demo reads and writes the real `.mimirs` index for that directory — it is not a sandbox.

2. **Index the project.** Section 1 calls `indexDirectory(dir, db, config, progress)` and waits for it to finish (`src/cli/commands/demo.ts:56`). This is the only step that mutates state; everything after it is read-only. Indexing first so the search demos have data to return is the reason the order is fixed.

3. **Report the index result.** `indexDirectory` returns an `IndexResult` with `indexed`, `skipped`, and `pruned` counts (`src/indexing/indexer.ts:46`). The demo prints them on one green `Done:` line (`src/cli/commands/demo.ts:57-59`), then pauses 500 ms via `pause` (`src/cli/commands/demo.ts:21`). The pacing exists purely so a human reading along can keep up.

4. **Search demo (files).** Section 2 runs `search(demoQuery, db, 3, 0, config.hybridWeight, config.generated)` and keeps the first three results (`src/cli/commands/demo.ts:67`). `search` returns one entry per file (`DedupedResult`: `path`, `score`, `snippets`), deduplicated so each file appears once with its best score (`src/search/hybrid.ts:39-43`). For each result the demo prints the score in yellow, the path relative to the target dir, and the first snippet, truncated by `renderBlock` to three lines at 96 columns (`src/cli/commands/demo.ts:69-76`).

5. **Read demo (chunks).** Section 3 runs `searchChunks(demoQuery, db, 2, 0.3, config.hybridWeight, config.generated)` (`src/cli/commands/demo.ts:85`). Unlike `search`, this returns individual semantic chunks with no file deduplication, and each carries `startLine`, `endLine`, and an optional `entityName` (`src/search/hybrid.ts:45-55`). The demo renders a `path:start-end` locator plus the entity name when present, then up to 18 lines of the chunk body (`src/cli/commands/demo.ts:87-94`). The `0.3` argument is a relevance floor — chunks scoring below it are dropped inside `searchChunks` (`src/search/hybrid.ts:493-494`).

6. **Symbol listing demo.** Section 4 calls `db.searchSymbols(undefined, false, undefined, 200)` (`src/cli/commands/demo.ts:102`). Passing no query puts `searchSymbols` into listing mode, which returns up to 200 exported symbols with per-symbol metadata instead of a name match (`src/db/search.ts:245`). The demo then filters out re-exports and zero-reference symbols, sorts by `referenceCount` descending, and keeps the top five (`src/cli/commands/demo.ts:103-106`). Each line shows the symbol name, its type, how many importer files reference it, and across how many modules — see the State and ranking section below.

7. **Closing screen and cleanup.** A final "Done" header prints the `mimirs init` hint and a docs link (`src/cli/commands/demo.ts:120-123`), and the handler closes the database with `db.close()` (`src/cli/commands/demo.ts:125`). There is no explicit `process.exit`; the command returns normally.

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `[dir]` | positional string | no | Project directory to demo against. Taken from `args[1]` only when present and not starting with `--`; otherwise defaults to `.` and is resolved to an absolute path (`src/cli/commands/demo.ts:37`). |

Two values are read from the loaded config rather than from flags: `config.hybridWeight` (vector-vs-keyword blend, default `0.7`) and `config.generated` (glob patterns whose matches get demoted in ranking, default empty). Both are passed straight into `search` and `searchChunks` (`src/cli/commands/demo.ts:67`, `src/cli/commands/demo.ts:85`; defaults at `src/config/index.ts:20`, `src/config/index.ts:23`). The query itself is not an input — it is hard-coded as `"AST-aware chunking with tree-sitter"` (`src/cli/commands/demo.ts:62`) so the demo is reproducible across runs.

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| Colored demo output | Written to stdout via `cli.log` with raw ANSI escape codes for color and dimming (`src/cli/commands/demo.ts:9-15`). Four numbered sections plus a closing screen, paced with 500 ms pauses between sections. |
| File and chunk index rows | Created or refreshed in the project's `.mimirs` database as a side effect of the indexing step (`src/cli/commands/demo.ts:56`). This is persistent state, not transient output. |

## State changes

| name | before | after | trigger | why it matters |
| --- | --- | --- | --- | --- |
| file and chunk index rows | not indexed (or stale) | indexed / up to date | `indexDirectory(dir, db, config, progress)` | The search demos need data to return; the same call would otherwise leave stale or missing rows. |

The demo's first real action is to index, and `indexDirectory` writes file and chunk rows into the SQLite-backed `RagDB` (`src/cli/commands/demo.ts:56`, returning `IndexResult` from `src/indexing/indexer.ts:46`). Because the demo opens the project's actual database, running it does real, persistent indexing work — it is not throwaway. Two consequences follow: the first run on a large project can be slow while embeddings are computed, and a second `mimirs demo` is fast because most files are skipped as unchanged (reflected in the `skipped` count on the `Done:` line).

Ranking metadata is computed but **not** stored: `referenceCount` and `referenceModuleCount` are derived on the fly inside `searchSymbols` from the imports graph each time it runs (`src/db/search.ts:401-402`). `referenceCount` counts distinct importer files, and `referenceModuleCount` counts the distinct directories those importers live in. The demo line reads, for example, `8 importers across 3 modules`, with the singular/plural of "module" chosen from `referenceModuleCount` (`src/cli/commands/demo.ts:111`).

## Branches and failure cases

- **Default directory.** When `args[1]` is missing or begins with `--`, the directory falls back to `.` before resolution (`src/cli/commands/demo.ts:37`). A flag passed where a path is expected is therefore ignored rather than treated as a path.

- **Quiet vs. plain progress.** The progress callback watches for the `Found N files to index` message that `indexDirectory` emits (`src/indexing/indexer.ts:736`). On match it switches to a single updating progress line built by `createQuietProgress`; before that match, and for any message that does not match, it falls back to `cliProgress` (`src/cli/commands/demo.ts:49-54`). So the user sees a compact `Indexing: X/Y files` line once the file count is known.

- **Index lock held by another process.** If another mimirs process (commonly the running MCP server) holds the directory's index lock, `indexDirectory` returns immediately with `indexed: 0, skipped: 0, pruned: 0` and `locked: true`, after emitting a "Another mimirs process owns the index lock" progress message (`src/indexing/indexer.ts:722-729`). The demo does not inspect `result.locked`, so it prints `Done: 0 indexed, 0 skipped, 0 pruned` and continues; the search sections then run against whatever was already indexed.

- **Empty file search.** When `search` returns nothing, section 2 prints `No results — try a query related to your project.` instead of result lines (`src/cli/commands/demo.ts:77-78`). This is the expected outcome on a project that has no code matching the fixed query.

- **No chunks above threshold.** When `searchChunks` returns an empty list — for example when every candidate scores below the `0.3` floor — section 3 prints `No chunks above threshold.` (`src/cli/commands/demo.ts:96-97`).

- **No referenceable symbols.** After filtering out re-exports and zero-reference symbols, if nothing remains the symbol section prints `No exported symbols indexed yet.` (`src/cli/commands/demo.ts:115-116`). This happens on a freshly indexed project with no resolved cross-file imports, or one whose language has no export extraction.

- **FTS unavailable.** Inside both `search` and `searchChunks`, a failure in the BM25 full-text query is caught and logged at debug level, and the function falls back to vector-only results (`src/search/hybrid.ts:330-334`, `src/search/hybrid.ts:486-490`). The demo never sees the error; it just gets slightly different ranking.

- **No `process.exit`.** The handler closes the DB and returns; it never forces an exit code, so a thrown error (for example from `loadConfig` on malformed config) propagates up to `main`'s try/catch in `src/cli/index.ts:92-102` rather than being swallowed here.

## Example

```
$ mimirs demo
mimirs demo
Running against: /path/to/project

--- 1. Index your project ---
Indexing files with AST-aware chunking...
Found 174 files to index
Indexing: 174/174 files (100%)
Done: 174 indexed, 0 skipped, 0 pruned

--- 2. search — ranked files for a query ---
> search "AST-aware chunking with tree-sitter"

  0.7421  src/indexing/chunker.ts
    export function chunkText(...) {
    …

--- 3. read_relevant — ranked chunks with exact line ranges ---
> read_relevant "AST-aware chunking with tree-sitter"

  [0.74] src/indexing/chunker.ts:42-118  chunkText
    ...

--- 4. search_symbols — most-referenced symbols in the codebase ---
> search_symbols   # listing mode, ranked by import count

  RagDB (class)  31 importers across 9 modules
    src/db/index.ts

--- Done ---
Add mimirs to your editor:
  bunx mimirs init --ide claude   # or: cursor, windsurf, copilot, jetbrains, all
```

Scores, counts, paths, and line ranges above are illustrative; the actual values depend on the project being indexed.

## Related commands

The demo is a thin orchestration of capabilities that have their own dedicated commands:

- [index](index.md) — the standalone command around `indexDirectory`, the same indexing step section 1 runs.
- [search](search.md) — the `search` and `read` commands, which call the same `search` and `searchChunks` functions sections 2 and 3 demonstrate.

## Key source files

- `src/cli/commands/demo.ts` — the entire `demoCommand` handler: directory resolution, the four demo sections, color helpers, and `renderBlock`/`pause`.
- `src/cli/index.ts` — argv parsing and the `demo` dispatch case that calls `demoCommand`.
- `src/search/hybrid.ts` — `search` (file-level, deduplicated) and `searchChunks` (chunk-level, with line ranges) used by sections 2 and 3.
- `src/db/search.ts` — `searchSymbols`, whose listing mode and `referenceCount`/`referenceModuleCount` drive the section 4 ranking.
- `src/indexing/indexer.ts` — `indexDirectory` and the `IndexResult` shape reported on the `Done:` line, plus the index-lock early return.
- `src/cli/progress.ts` — `cliProgress` and `createQuietProgress`, which format the indexing progress line.
