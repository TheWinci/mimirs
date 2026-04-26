# CLI Commands

> [Architecture](../architecture.md)
>
> Generated from `79e963f` · 2026-04-26

All 19 CLI subcommand handlers live under `src/cli/commands/`. Each file exports a single async function named `<noun>Command` that receives a raw `args` array and a `getFlag` helper. They are the concrete implementations that the top-level dispatcher in `src/cli/index.ts` routes to after parsing the subcommand name.

## Per-file breakdown

### `src/cli/commands/analytics.ts` — `analyticsCommand`

Reports search quality metrics for a project directory. It calls `db.getAnalytics(days)` to get zero-result rate, average top score, and top search terms, then `db.getAnalyticsTrend(days)` to compare the current period against the prior period of the same length. The `--days` flag defaults to `30`. The trend comparison only prints when either period has queries — if the index is fresh, the block is silent. Low-relevance queries (top score below `0.3`) are surfaced separately from zero-result queries, so operators can distinguish "no hits" from "hits that aren't useful."

### `src/cli/commands/annotations.ts` — `annotationsCommand`

Lists persisted annotations stored in the DB. Accepts an optional project directory (`args[1]` or `--dir`) and an optional `--path` filter to restrict output to a single file. Each annotation is printed with its numeric ID, file path, optional symbol name, author, note text, and `updatedAt` timestamp. If no annotations exist, prints a short informational message and exits cleanly.

### `src/cli/commands/benchmark.ts` — `benchmarkCommand`

Runs a query-recall benchmark from a JSON file. Loads the queries via `loadBenchmarkQueries`, runs them with `runBenchmark`, prints a formatted report, and exits with code `1` when recall or MRR fall below `config.benchmarkMinRecall` / `config.benchmarkMinMrr`. This makes it suitable for CI gates.

### `src/cli/commands/benchmark-models.ts` — `benchmarkModelsCommand`

Extends the single-model benchmark to compare multiple embedding models side by side. The `KNOWN_MODELS` map pre-registers four models with their dimensions:

- `Xenova/all-MiniLM-L6-v2` (384d)
- `Xenova/bge-small-en-v1.5` (384d)
- `Xenova/jina-embeddings-v2-small-en` (512d)
- `jinaai/jina-embeddings-v2-base-code` (768d)

Unknown models can be specified as `model-id:dim`. For each model the command creates a temporary DB, indexes the project, runs the benchmark queries, then tears down the DB. `resetEmbedder()` is called between runs so cached model state doesn't bleed across comparisons. Results are printed as a comparison table.

### `src/cli/commands/checkpoint.ts` — `checkpointCommand`

Manages named decision checkpoints. Subcommands are `create`, `list`, and `search`. On creation the command discovers existing conversation sessions via `discoverSessions`, reads the turn count for the most recent session, embeds the `title + summary` string, and stores the result in the DB along with optional `--files` and `--tags` lists. The embedding enables semantic `search` over checkpoints later. The `list` subcommand respects `--type` and `--top` filters.

### `src/cli/commands/cleanup.ts` — `cleanupCommand`

Undoes `mimirs init`. It removes the `<!-- mimirs -->` instructions block from CLAUDE.md files (both project-level and `~/.claude/CLAUDE.md`), strips the `"mimirs"` entry from any MCP JSON config file that references it, and deletes the `.mimirs/` data directory. Each step is guarded by an interactive `confirm()` prompt unless the caller passes `--yes`. If a markdown file becomes empty after the block is removed, the file itself is deleted. If an MCP config has no remaining servers, it is also deleted.

### `src/cli/commands/conversation.ts` — `conversationCommand`

Searches and re-indexes Claude Code conversation history. The `search` subcommand performs hybrid search (vector + BM25, blended at `config.hybridWeight`) over indexed turns. Before searching it ensures all discovered sessions are indexed — any session whose stored `mtime` is older than the file's actual `mtime` is re-indexed. The `index` subcommand forces a full re-index of all sessions.

### `src/cli/commands/demo.ts` — `demoCommand`

Interactive demonstration that indexes a directory, runs several semantic searches, and shows the raw results with ANSI colors. It switches between `cliProgress` for verbose output and a quiet `createQuietProgress` spinner during indexing. The demo pauses briefly between sections to let readers follow along.

### `src/cli/commands/doctor.ts` — `doctorCommand`

Health checker. Runs a sequence of `Check` objects — each a `{ name, run }` pair where `run()` returns `null` (pass) or an error string. Checks include: Bun runtime detection, Homebrew SQLite on macOS (Apple's bundled SQLite does not support extensions), sqlite-vec extension loading, project directory existence, `.mimirs/config.json` validity, and embedding model availability. The final output is a pass/fail table. On macOS it probes `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` and `/usr/local/opt/sqlite/lib/libsqlite3.dylib`.

### `src/cli/commands/eval.ts` — `evalCommand`

A/B evaluation runner. Loads evaluation tasks from a JSON file, runs them with `runEval`, prints a formatted report, and optionally writes detailed per-query traces to a file via `saveEvalTraces`. The `--out` flag controls the trace output path. Useful for measuring regression between search strategy changes.

### `src/cli/commands/history.ts` — `historyCommand`

Git commit history indexing and search. Subcommands: `index` (run `indexGitHistory` with optional `--since REF`), `search` (hybrid search over commit messages with `--author` and `--since` filters), and `status` (print index stats). In quiet mode (no `-v`) only non-transient progress messages are printed. The `--since` flag accepts any git ref (tag, SHA, branch name).

### `src/cli/commands/index-cmd.ts` — `indexCommand`

Indexes a project directory. Accepts `--patterns` to override `config.include` (comma-separated glob list), `--verbose`/`-v` for full progress output, and falls back to a quiet spinner progress otherwise. Prints a summary line `Done: N indexed, N skipped, N pruned (Xs)` and reports errors to stderr. Exits with code `0` even when there are partial errors — errors are printed, not thrown.

### `src/cli/commands/init.ts` — `initCommand`

Sets up mimirs for a project. Calls `runSetup` to install MCP config entries and optionally prompts to index immediately. During indexing it writes a `status` file under `.mimirs/` so external health monitors can track progress. Accepts `--yes`/`-y` to skip prompts, `--ide` to target specific IDEs, and `--verbose`/`-v` for detailed progress.

### `src/cli/commands/map.ts` — `mapCommand`

Renders the dependency graph via `generateProjectMap`. Supports `--focus <file>` to show only the subgraph around a specific file and `--zoom` (`file` or `directory`) to switch between file-level and directory-level granularity.

### `src/cli/commands/remove.ts` — `removeCommand`

Removes a single file from the index. Calls `db.removeFile(resolve(file))` and prints whether the file was present.

### `src/cli/commands/search-cmd.ts` — `searchCommand`

Semantic search from the CLI. Parses `--ext`/`--extensions`, `--in`/`--dirs`, and `--exclude`/`--exclude-dirs` into a `PathFilter` and passes it through `search()`. The `--chunks` flag switches from file-level results to chunk-level results via `searchChunks`. Each result prints score, file path, and a 120-character snippet preview.

### `src/cli/commands/serve.ts` — `serve` (implicit)

Starts the MCP server. The dispatcher in `src/cli/index.ts` routes `mimirs serve` to `src/server/index.ts` directly.

### `src/cli/commands/session-context.ts` — `sessionContextCommand`

Retrieves a summary of recent conversation turns for the current session — useful for injecting context at the top of a new chat. Prints the last N turns with timestamps and tool usage.

### `src/cli/commands/status.ts` — `statusCommand`

Prints index statistics: total files, total chunks, DB size, last index time, and configuration summary.

## How it works

```sequenceDiagram
    participant User
    participant Dispatcher as "src/cli/index.ts"
    participant Handler as "commands/<cmd>.ts"
    participant DB as RagDB
    participant Services as "search/embed/git"

    User->>Dispatcher: mimirs <cmd> [args]
    Dispatcher->>Dispatcher: parse subcommand + flags
    Dispatcher->>Handler: call <cmd>Command(args, getFlag)
    Handler->>Handler: resolve project dir
    Handler->>DB: new RagDB(dir)
    Handler->>Services: load config, run operation
    Services-->>Handler: result
    Handler->>DB: close()
    Handler-->>User: output to stdout/stderr
```

Every command handler owns its own DB lifecycle: it opens a `RagDB` at the start and closes it before returning. There is no shared connection pool at the CLI layer — each invocation is a standalone process. Errors that should abort the command call `process.exit(1)` directly rather than throwing, which avoids unwanted stack traces on the terminal.

## Dependencies and consumers

```flowchart LR
    cmds["commands/*"]
    cliEntry["src/cli/index.ts"]
    db["src/db/index.ts"]
    config["src/config/index.ts"]
    search["src/search/hybrid.ts"]
    embed["src/embeddings/embed.ts"]
    git["src/git/indexer.ts"]
    conv["src/conversation/*"]
    graph["src/graph/resolver.ts"]
    progress["src/cli/progress.ts"]
    setup["src/cli/setup.ts"]

    cliEntry --> cmds
    cmds --> db
    cmds --> config
    cmds --> search
    cmds --> embed
    cmds --> git
    cmds --> conv
    cmds --> graph
    cmds --> progress
    cmds --> setup
```

The only consumer of the commands community is `src/cli/index.ts`. All commands depend on `src/db/index.ts` (`RagDB`) for data access and `src/config/index.ts` (`loadConfig`) for configuration. Heavier operations additionally import from the search, embedding, git, conversation, and graph subsystems.

## Internals

**Uniform function signature convention.** Every exported handler has the shape `async function <noun>Command(args: string[], getFlag: (flag: string) => string | undefined)`. The `getFlag` helper is provided by the dispatcher and handles named flag extraction. Commands that don't need flags (like `removeCommand` and `demoCommand`) omit the second parameter.

**Directory resolution.** Commands resolve the project directory by checking `args[1]` first (if it doesn't start with `--`), then `getFlag("--dir")`, then falling back to `"."`. This means `mimirs index /path` and `mimirs index --dir /path` are equivalent.

**Config-driven defaults.** `benchmarkCommand`, `conversationCommand`, `searchCommand`, and similar commands read `config.searchTopK`, `config.benchmarkTopK`, and `config.hybridWeight` before applying `--top` or `--weight` overrides. Overriding on the CLI always wins over config.

**applyEmbeddingConfig.** Commands that embed (index, history, benchmark-models) call `applyEmbeddingConfig(config)` after `loadConfig` to set the active model and dimension. Commands that only read (search, analytics) skip this — the embedding model is only needed when producing new vectors.

**Progress modes.** Commands with potentially long runs (index, history index, demo) switch between `cliProgress` (verbose, when `--verbose` is passed) and a quiet progress wrapper built by `createQuietProgress(totalFiles)`. The quiet wrapper shows a single animated spinner line that overwrites itself, keeping the terminal clean during CI runs.

## Why it's built this way

Each command is a separate file rather than a monolithic switch block because the 19 handlers vary significantly in complexity (17 to 182 lines) and import different subsystems. Keeping them isolated means adding a new command requires no modification to existing files — only a new import in `src/cli/index.ts`.

The raw `args: string[]` interface was chosen over a full argument-parsing library (like `yargs` or `commander`) to keep the runtime dependency footprint minimal. Mimirs is distributed as an MCP server that users install globally; startup time and bundle size matter. The hand-rolled `getFlag` helper is 10 lines and covers every flag pattern the CLI needs.

Commands open and close their own `RagDB` instance rather than sharing one because the CLI is a short-lived process. Session sharing would add complexity with no benefit — the server (`src/server/index.ts`) uses a different, persistent connection-pool strategy.

## Trade-offs

The bespoke argument parsing is deliberate but limiting. Multi-value flags (like `--files f1,f2`) are passed as comma-separated strings and split manually. If the CLI grows to dozens of subcommands with complex flag grammars, the current approach will become hard to maintain. At that point adopting a proper argument-parsing library would be the right move.

Each command doing its own `loadConfig` call means configuration is re-parsed on every invocation. For a single short-lived process this is negligible; for commands that invoke multiple DB operations this adds a few milliseconds of file I/O.

## Common gotchas

The `args` array is the raw `process.argv` slice starting at the subcommand. `args[0]` is the subcommand name itself, so the first actual argument is always `args[1]`. Forgetting this off-by-one is the most common mistake when adding a new command.

`getFlag` only extracts named flags (`--foo value`). Positional arguments must be read from `args[N]` directly and checked with `!args[N].startsWith("--")` to distinguish them from flags.

Commands that call `process.exit(1)` on validation failure must close the DB first, or the SQLite WAL will be left dirty. Most commands either open the DB after validation or handle the error before opening.

The `--dir` flag is not normalized — it is resolved to an absolute path via `resolve(getFlag("--dir") || ".")` inside each command, not by the dispatcher. If you add a command that accepts a directory, remember to call `resolve()` before passing it to `RagDB`.

## See also

- [Architecture](../architecture.md)
- [CLI Entry & Core Utilities](cli-entry-core.md)
- [Config & Embeddings](config-embeddings.md)
- [Data flows](../data-flows.md)
- [Database Layer](db-layer.md)
- [Getting started](../getting-started.md)
