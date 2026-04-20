# commands

The 19 subcommand handlers behind `mimirs <cmd>`. Each file under `src/cli/commands/` exports one (occasionally two) `*Command(args, getFlag)` function. The dispatcher in `src/cli/index.ts` receives `process.argv.slice(2)` and a helper that reads long flags (`--ide`, `--top`, `--dir`, `--patterns`, `--since`, …), then fans out to the right handler. The handlers are the thin translation layer between argv and the rest of the codebase — they construct `RagDB(projectDir)`, call `loadConfig` + `applyEmbeddingConfig`, hand off to a domain module (indexer, search, git indexer, conversation, wiki, etc.), and print.

No business logic lives here. This is the CLI-to-typed-call seam.

## Public API

All 13 exports are `async function *Command(args: string[], getFlag: (flag: string) => string | undefined)` — except `cleanupCommand(args)`, `removeCommand(args)`, `statusCommand(args)`, and `serveCommand()` which take no flag helper. The full list:

```ts
analyticsCommand, annotationsCommand, benchmarkCommand, cleanupCommand,
evalCommand, historyCommand, indexCommand, mapCommand, readCommand,
removeCommand, searchCommand, serveCommand, statusCommand
```

Nineteen source files produce these thirteen exports because a handful of files pack two entry points (`search-cmd.ts` exports both `searchCommand` and `readCommand`; `checkpoint.ts` / `annotations.ts` / `conversation.ts` / `history.ts` expose subcommand routers that aren't standalone exports). `init.ts`, `doctor.ts`, `demo.ts`, `session-context.ts`, `benchmark-models.ts` are wired in from sibling modules — the dispatcher imports them by name.

## How it works

```mermaid
sequenceDiagram
  participant user as "shell"
  participant dispatch as "cli/index.ts"
  participant cmd as "commands/<name>.ts"
  participant cfg as "config.loadConfig"
  participant emb as "config.applyEmbeddingConfig"
  participant domain as "indexer / search / git / wiki"
  participant db as "db (RagDB)"

  user->>dispatch: "mimirs search 'hybrid scoring' --top 8"
  dispatch->>cmd: "searchCommand(args, getFlag)"
  cmd->>db: "new RagDB(resolve(dir))"
  cmd->>cfg: "loadConfig(dir)"
  cfg-->>cmd: "RagConfig"
  cmd->>emb: "applyEmbeddingConfig(config)"
  cmd->>domain: "search(query, db, topK, 0, hybridWeight, generated)"
  domain-->>cmd: "DedupedResult[]"
  cmd->>cmd: "format + print (cli.log / cli.error)"
  cmd->>db: "db.close()"
```

Every command follows the same shape:

1. Resolve the project directory — `args[N]` when it doesn't look like a flag, else `process.cwd()`.
2. Instantiate `RagDB(dir)`. The constructor runs schema migrations and loads `sqlite-vec`.
3. Call `loadConfig(dir)` → `applyEmbeddingConfig(config)` so per-project model overrides take effect before the first `embed()`.
4. Do the work — usually one call into a domain module.
5. Print to `cli.log` / `cli.error` (stdout/stderr split, see `utils/log`).
6. Close the DB.

## Per-file breakdown

### `index-cmd.ts` — `mimirs index [dir]`

The most-run command. Resolves the directory, applies `--patterns` to `config.include` if supplied, then runs `indexDirectory`. Chooses between `cliProgress` (verbose) and `createQuietProgress(totalFiles)` (default one-line updater) based on `-v` / `--verbose`. `createQuietProgress` is instantiated lazily on the `Found N files to index` message so it has the total up front.

### `init.ts` — `mimirs init [dir] [--ide IDEs]`

Runs `runSetup(dir, ides)` (config, gitignore, MCP snippets, agent instructions) and offers the first index pass. Writes `.mimirs/status` progress in parallel with terminal output so an IDE installer can watch without parsing stderr.

### `search-cmd.ts` — `mimirs search` / `mimirs read`

Two exports (`searchCommand`, `readCommand`). `search` calls `search(query, db, topK, 0, config.hybridWeight, config.generated)` and prints path + score + snippet. `read` calls `searchChunks` for chunk-level results with exact line ranges — same shape the `read_relevant` MCP tool returns.

### `status.ts` — `mimirs status [dir]`

Prints `db.getStatus()` (file count, chunk count, DB size). Also reports whether the embedding model matches `config.embeddingModel` — mismatches signal "you need a DB reset".

### `remove.ts` — `mimirs remove <file>`

One file, one call to `db.removeFile(path)`. Cascaded deletes handle the chunks + FTS + vec rows.

### `analytics.ts` — `mimirs analytics [--days N]`

Prints the query log rollup — top queries, zero-result rate, 90th percentile latency. Powered by `db.getAnalytics(days)` and `getAnalyticsTrend(days)`.

### `map.ts` — `mimirs map [dir] [--focus F] [--zoom L]`

Wraps `generateProjectMap` from the graph module. `--focus` restricts the subgraph to a file's neighborhood; `--zoom` toggles file-level vs directory-level collapsing. No node-count cap — the prior `--max N` auto-switch to directory view was removed; callers needing a trimmed graph use `--focus` + `--zoom`.

### `benchmark.ts` / `benchmark-models.ts` — recall@K harnesses

`benchmark` runs the search recall benchmark against a fixture JSON and exits non-zero if `recallAtK < config.benchmarkMinRecall` or `mrr < config.benchmarkMinMrr`. `benchmark-models` indexes the project once per candidate embedding model and reports per-model scores — used when tuning `embeddingModel`.

### `eval.ts` — `mimirs eval <file>`

Runs each task in the eval fixture twice (with RAG and without), writing traces to `--out`. Consumed by the `eval` test target and by `benchmarks/quality-bench-worker.ts`.

### `conversation.ts` — `search`, `sessions`, `index`

Three subcommands: `search` calls `db.searchConversation`; `sessions` lists indexed sessions with turn/token counts; `index` walks `~/.claude/projects/<slug>/` and indexes every JSONL file through `indexConversation`.

### `checkpoint.ts` — `create`, `list`, `search`

The CLI face of the checkpoint-tools module. `create` takes `<type> <title> <summary>` plus `--files` / `--tags`; `list` and `search` take the usual filter flags.

### `annotations.ts` — `mimirs annotations`

Lists annotations, optionally filtered by `--path`. Deletion happens through the MCP `delete_annotation` tool — there's no `mimirs annotation remove` subcommand.

### `session-context.ts` — session start summary

The headless equivalent of the `session_context` MCP call. Prints recent commits, active files, and open annotations. Useful as a shell hook.

### `history.ts` — `history index`, `history search`, `history status`

Wrapper over the git indexer. `index` takes `--since REF` for incremental reindex, reusing `db.getLastIndexedCommit()` as the default anchor. `search` runs `db.searchGitCommits` with `--author` / `--since` / `--until` / `--path` filters.

### `demo.ts` — `mimirs demo`

Four-step walk-through so new users see what each tool prints. (1) Indexes the directory, routing progress through a lazily-built `createQuietProgress` the moment the indexer emits `Found N files to index`. (2) Runs `search` for `"AST-aware chunking with tree-sitter"` and prints the top 3 hits with a 3-line snippet preview via the file-local `renderBlock(text, indent, maxLines, wrap)` helper. (3) Runs `searchChunks` with `threshold: 0.3` and prints up to 2 chunks with `path:startLine-endLine` plus entity name. (4) Calls `db.searchSymbols(undefined, false, undefined, 200)` in listing mode, filters out re-exports and zero-reference symbols, and prints the top 5 by `referenceCount`. The demo is a self-contained showcase — it does not call the MCP tools layer.

### `doctor.ts` — `mimirs doctor`

A battery of checks: Bun present, SQLite capable of extensions (with per-platform `brew install sqlite` / `libsqlite3-dev` / `sqlite-devel` fixups), `.mimirs/` writable, embedding model downloadable. Each check returns `null` for pass or a string error. Invoked when `serve` fails — crucial because `serve` defers loading until after doctor's checks would have fired.

### `cleanup.ts` — `mimirs cleanup [-y]`

The opposite of `init`. Removes `.mimirs/`, strips `mimirs` from every known MCP config, removes the `<!-- mimirs -->`-bracketed block from agent-instruction files, and prunes the `.mimirs/` line from `.gitignore`. `-y` skips the confirmation prompt. A file that becomes whitespace-only after removal is deleted rather than left empty.

### `serve.ts` — `mimirs serve`

The MCP entry. Dynamic-imports `src/server` so module-load failures write a diagnostic `server-error.log` + `status` file to `.mimirs/` before rethrowing — otherwise the IDE would see a stdio pipe close with no indication why. Forwards to `startServer()` and keeps the process alive on stdin/stdout.

## Dependencies and Dependents

```mermaid
flowchart LR
  subgraph Upstream["Depends on"]
    dbmod["db (RagDB)"]
    cfgmod["config"]
    embmod["embeddings"]
    idxmod["indexing/indexer"]
    srchmod["search (hybrid, eval, benchmark)"]
    gitmod["git/indexer"]
    convmod["conversation (parser, indexer)"]
    graphmod["graph/resolver"]
    setupmod["cli/setup + cli/progress"]
    utilmod["utils/log"]
  end
  self["commands (19 files)"]
  cli["cli/index.ts dispatcher"]

  dbmod --> self
  cfgmod --> self
  embmod --> self
  idxmod --> self
  srchmod --> self
  gitmod --> self
  convmod --> self
  graphmod --> self
  setupmod --> self
  utilmod --> self
  self --> cli
```

Fan-out: 10 upstream modules (`db`, `config`, `embeddings`, `indexing`, `search` with three files, `git/indexer`, `conversation` with two files, `graph/resolver`, `cli/setup`, `cli/progress`, `utils/log`). Fan-in: 1 — only `cli/index.ts` imports from `src/cli/commands/*`. That single-consumer shape is the reason each handler is free to use a different argv convention; there's no internal API contract to violate.

## Internals

- **`getFlag(flag)`** is the shared long-flag helper the dispatcher hands every command. It scans argv for `--foo value` (or `--foo=value`), returns `undefined` when absent. Commands use it uniformly — no per-command parser.
- **Directory resolution idiom.** `resolve(args[N] && !args[N].startsWith("--") ? args[N] : ".")`. Appears verbatim in ~14 commands and lets a user write `mimirs index --patterns foo` without the directory arg clashing with the flag.
- **`RAG_PROJECT_DIR` precedence in `doctor` / `serve` only.** These two honour `process.env.RAG_PROJECT_DIR` as a fallback because MCP invocations pass it instead of argv. Other commands use `process.cwd()` directly.
- **Silent status-file writes.** `init` and `serve` write to `.mimirs/status` behind `try/catch`; failures are swallowed because the status file is a convenience, never a correctness requirement.

## Configuration

- `--dir D` / positional dir — every command accepts a trailing directory.
- `--verbose` / `-v` — per-file output in `index` and `history index`.
- `--yes` / `-y` — skip confirmation in `init` and `cleanup`.
- `--patterns glob1,glob2` — override `config.include` for one `index` run.
- `--top N`, `--threshold T`, `--author A`, `--since S`, `--until U`, `--days N`, `--out F`, `--focus F`, `--zoom file|directory`, `--tags t1,t2`, `--files f1,f2`, `--ide I1,I2` — per-command.
- `process.env.RAG_PROJECT_DIR` — read by `doctor` and `serve`.

## Known issues

- **Commands don't share argv validation.** Each handler re-implements "directory is first non-flag arg" inline. A user who writes `mimirs index -- src/foo` gets surprising results because `--` isn't treated as an end-of-flags marker.
- **`serveCommand` rethrows after diagnostics.** The process exits non-zero, which is fine for launched-by-IDE flows but surprising if a user runs `mimirs serve` in a terminal expecting a retry loop.
- **Cleanup is best-effort about MCP configs.** If an IDE stores its MCP config in a non-standard path (a Windsurf fork, for example), `cleanup` won't find it. A warning would help but there's no enumeration API.
- **Doctor runs checks sequentially.** SQLite-extension loading is the slow step; on a cold cache it can take several seconds while doctor appears hung. No progress indicator.

## See also

- [Architecture](../architecture.md)
- [Data Flows](../data-flows.md)
- [Getting Started](../guides/getting-started.md)
- [Conventions](../guides/conventions.md)
- [Testing](../guides/testing.md)
