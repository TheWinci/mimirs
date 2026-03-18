# local-rag-mcp

Semantic search for your codebase and conversation history, zero config, with built-in gap analysis.

Indexes any files — markdown, code, configs, docs — into a per-project vector store. Also indexes AI conversation transcripts in real time, so agents can recall past decisions and discussions. Usage analytics show you where your docs are falling short.

No API keys. No cloud. No Docker. Just `bun install`.

[![npm](https://img.shields.io/npm/v/local-rag-mcp)](https://www.npmjs.com/package/local-rag-mcp)
[![license](https://img.shields.io/npm/l/local-rag-mcp)](LICENSE)

## Why

- **AI agents guess filenames.** They read files one at a time and miss things. This gives them semantic search — "how do we deploy?" finds the right doc even if it's called `runbook-prod-release.md`.
- **No one reads the docs.** Docs exist but never get surfaced at the right moment. This makes them findable by meaning, automatically.
- **Analytics expose documentation gaps.** After a week of usage, you'll know which topics people search for but can't find — that's a free gap analysis.

## Quick start

```bash
npm install local-rag-mcp
```

Or with Bun:

```bash
bun add local-rag-mcp
```

> **macOS:** Apple's bundled SQLite doesn't support extensions. Run `brew install sqlite` first.

### Add to your editor

Works with any [MCP](https://modelcontextprotocol.io/)-compatible client. Add this server config to your editor's MCP config file:

| Editor | Config file | Sets cwd to project? |
|---|---|---|
| Claude Code | `~/.claude/settings.json` or `<project>/.claude/settings.json` | Yes |
| Cursor | `<project>/.cursor/mcp.json` | **No** — uses home dir |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | **No** — uses home dir |
| VS Code (Copilot) | `<project>/.vscode/mcp.json` | Yes |

Editors that set cwd to the project automatically (Claude Code, VS Code) work with no extra config:

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "bunx",
      "args": ["local-rag-mcp"]
    }
  }
}
```

**Cursor and Windsurf** spawn MCP servers from the user's home directory, so you must set `RAG_PROJECT_DIR` explicitly — otherwise the server indexes `~` instead of your project:

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "bunx",
      "args": ["local-rag-mcp"],
      "env": {
        "RAG_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

> **VS Code note:** Uses `"servers"` instead of `"mcpServers"` and requires `"type": "stdio"` on the server object.

**Read-only project directory?** Set `RAG_DB_DIR` to redirect the index to a writable path:

```json
"env": {
  "RAG_PROJECT_DIR": "/path/to/your/project",
  "RAG_DB_DIR": "/tmp/my-project-rag"
}
```

### Auto-indexing

The MCP server automatically indexes your project on startup and watches for file changes during the session. It also tails the active conversation transcript in real time and indexes past sessions on startup. You don't need to manually run `index` — just connect and search.

Progress is logged to stderr:
```
[local-rag] Startup index: 12 indexed, 0 skipped, 0 pruned
[local-rag] Watching /path/to/project for changes
[local-rag] Indexing conversation: a1b2c3d4...
[local-rag] Conversation: 3 new turns indexed (total: 15)
[local-rag] Re-indexed: docs/setup.md
```

### Make the agent use it automatically

The MCP server registers tools, but agents won't reach for them on their own unless you tell them to. Add instructions to your editor's rules file (`CLAUDE.md`, `.cursorrules`, `.windsurfrules`, or `.github/copilot-instructions.md`):

```markdown
## Using local-rag tools

This project has a local RAG index (local-rag-mcp). Use these MCP tools:

- **`search`**: Discover which files are relevant to a topic. Returns file paths
  with snippet previews — use this when you need to know *where* something is.
- **`read_relevant`**: Get the actual content of relevant semantic chunks —
  individual functions, classes, or markdown sections — ranked by relevance.
  Use this instead of `search` + `Read` when you need the content itself. Two
  chunks from the same file can both appear (no file deduplication).
- **`project_map`**: When you need to understand how files relate to each other,
  generate a dependency graph. Use `focus` to zoom into a specific file's
  neighborhood. This is faster than reading import statements across many files.
- **`search_conversation`**: Search past conversation history to recall previous
  decisions, discussions, and tool outputs. Use this before re-investigating
  something that may have been discussed in an earlier session.
- **`create_checkpoint`**: Mark important moments — decisions, milestones,
  blockers, direction changes. Do this after completing a phase, making a key
  technical decision, or before context gets compacted.
- **`list_checkpoints`** / **`search_checkpoints`**: Review or search past
  checkpoints to understand project history and prior decisions.
- **`index_files`**: If you've created or modified files and want them searchable,
  re-index the project directory.
- **`search_analytics`**: Check what queries return no results or low-relevance
  results — this reveals documentation gaps.
```

Without this, the agent only uses the tools when you explicitly ask. With it, the agent proactively searches the index and uses the project map for navigation.

### CLI usage

The CLI is available for manual use, debugging, and analytics:

```bash
# Search by meaning
bunx local-rag search "database connection setup" --dir /path/to/project

# Check what's indexed
bunx local-rag status /path/to/project

# Manual index (not needed if using the MCP server)
bunx local-rag index /path/to/project
```

## MCP tools

These tools are available to any MCP client (Claude Code, etc.) once the server is running:

| Tool | What it does |
|---|---|
| `search` | Semantic search over indexed files — returns ranked paths, scores, and 400-char snippets |
| `read_relevant` | Chunk-level retrieval — returns top-N individual semantic chunks ranked by relevance, with entity names and full content. No file deduplication — two chunks from the same file can both appear |
| `index_files` | Index files in a directory — skips unchanged files, prunes deleted ones |
| `index_status` | Show file count, chunk count, last indexed time |
| `remove_file` | Remove a specific file from the index |
| `search_analytics` | Usage analytics — query counts, zero-result queries, low-relevance queries, top terms |
| `project_map` | Generate a Mermaid dependency graph of the project — file-level or directory-level, with optional focus |
| `search_conversation` | Search conversation history — finds past decisions, discussions, and tool outputs across sessions |
| `create_checkpoint` | Mark an important moment — decisions, milestones, blockers, direction changes, or handoffs |
| `list_checkpoints` | List checkpoints, most recent first. Filter by session or type |
| `search_checkpoints` | Semantic search over checkpoint titles and summaries |

## CLI commands

```bash
bunx local-rag init [dir]                     # Create .rag/config.json with defaults
bunx local-rag index [dir]                    # Index files
bunx local-rag search <query> [--top N]       # Search by meaning (returns file paths + snippets)
bunx local-rag read <query> [--top N]         # Chunk-level retrieval (returns full content + entity names)
                   [--threshold T]
bunx local-rag status [dir]                   # Show index stats
bunx local-rag remove <file> [dir]            # Remove a file from the index
bunx local-rag analytics [dir] [--days N]     # Show search usage analytics
bunx local-rag benchmark <file> [--dir D]    # Run search quality benchmark
bunx local-rag eval <file> [--dir D]         # Run A/B eval (with/without RAG)
bunx local-rag map [dir] [--focus F]         # Generate project dependency graph
                   [--zoom file|directory]    # (Mermaid format)
                   [--max N]
bunx local-rag conversation search <query>   # Search conversation history
                   [--dir D] [--top N]
bunx local-rag conversation sessions [--dir D]  # List indexed sessions
bunx local-rag conversation index [--dir D]  # Index all sessions for a project
bunx local-rag checkpoint create <type>      # Create a checkpoint
                   <title> <summary>
                   [--dir D] [--files f1,f2] [--tags t1,t2]
bunx local-rag checkpoint list [--dir D]     # List checkpoints
                   [--type T] [--top N]
bunx local-rag checkpoint search <query>     # Search checkpoints
                   [--dir D] [--type T] [--top N]
```

## Measuring search quality

Two tools help you measure whether the RAG index is actually working: a **benchmark** for search precision and an **A/B eval** for comparing agent behavior with and without RAG.

### Benchmark

Tests whether specific queries find the right files. Create a JSON file with query/expected pairs:

```json
[
  { "query": "how to deploy", "expected": ["docs/deploy.md"] },
  { "query": "database schema", "expected": ["src/db.ts", "docs/database.md"] }
]
```

Run it against an indexed project:

```bash
bunx local-rag index /path/to/project
bunx local-rag benchmark queries.json --dir /path/to/project
```

Output:

```
Benchmark results (15 queries, top-5):
  Recall@5:      86.7%
  MRR:           0.743
  Zero-miss rate: 6.7% (1 queries)

Missed queries (no expected file in results):
  "kubernetes pod config"
    expected: docs/k8s.md
    got:      docs/deploy.md, docs/infra.md
```

- **Recall@5** — what % of expected files appeared in the top 5 results
- **MRR** — how high the first correct result ranks on average (1.0 = always #1)
- **Zero-miss rate** — what % of queries found none of the expected files

The command exits with code 1 if Recall@5 < 80% or MRR < 0.6, so you can use it in CI.

### A/B eval

Compares what files the RAG server would surface for a task versus having no RAG at all. Create a task file:

```json
[
  {
    "task": "Explain how authentication works",
    "grading": "Must reference auth middleware and session handling",
    "expectedFiles": ["src/auth.ts"]
  }
]
```

Run it:

```bash
bunx local-rag eval tasks.json --dir /path/to/project
```

Output:

```
A/B Eval results (5 tasks):

                     With RAG    Without RAG
  Avg results:            3.2            0.0
  Avg files found:        3.2            0.0
  File hit rate:         100%             0%
  Avg latency:           48ms            0ms

Per-task breakdown:
  "Explain how authentication works"
    files found: auth.ts, session.ts
    grading: Must reference auth middleware and session handling
```

Save full traces with `--out traces.json` for manual review or LLM-as-judge scoring.

### Writing your own benchmark set

A good benchmark set has 15-50 queries that cover:

1. **Core concepts** — queries about the main things your project does
2. **Specific files** — queries that should land on a known file
3. **Cross-cutting concerns** — queries that touch multiple files
4. **Edge cases** — queries using different phrasing for the same concept

See `benchmark/queries.json` and `benchmark/tasks.json` in this repo for examples.

Re-run the benchmark after changing chunking settings, include patterns, or `hybridWeight` to see if search quality improves.

## Analytics

Every search is logged automatically. Run `analytics` to see what's working and what's not:

```
Search analytics (last 30 days):
  Total queries:    142
  Avg results:      3.2
  Avg top score:    0.58
  Zero-result rate: 12% (17 queries)

Top searches:
  3× "authentication flow"
  2× "database migrations"

Zero-result queries (consider indexing these topics):
  3× "kubernetes pod config"
  2× "slack webhook setup"

Low-relevance queries (top score < 0.3):
  "how to fix the build" (score: 0.21)
```

**Zero-result queries** tell you what topics your docs are missing. **Low-relevance queries** tell you where docs exist but don't answer the actual question. Both are actionable.

The analytics output also includes a **trend comparison** showing how metrics changed versus the prior period:

```
Trend (current 30d vs prior 30d):
  Queries:          142 (+38)
  Avg top score:    0.58 (+0.05)
  Zero-result rate: 12% (-3.0%)
```

## Project map

The `map` command generates a Mermaid dependency graph from import/export relationships extracted during indexing. This gives AI agents (and humans) a bird's-eye view of how files relate to each other.

```bash
# Index with source files included
bunx local-rag index . --patterns "**/*.ts,**/*.js,**/*.md"

# Full project graph (file-level)
bunx local-rag map .

# Directory-level overview
bunx local-rag map . --zoom directory

# Focus on a specific file (shows 2 hops of dependencies)
bunx local-rag map . --focus src/search.ts
```

Here's the dependency graph for this project's source files (generated by running `local-rag map` on itself):

```mermaid
graph TD
  server_ts["server.ts\n+ getDB\n+ cleanup"]
  cli_ts["cli.ts\n+ usage\n+ getDir\n+ getFlag"]
  db_ts["db.ts\n+ loadCustomSQLite\n+ StoredChunk\n+ StoredFile"]
  search_ts["search.ts\n+ DedupedResult\n+ search"]
  indexer_ts["indexer.ts\n+ aggregateGraphData\n+ IndexResult\n+ fileHash"]
  chunker_ts["chunker.ts\n+ ChunkImport\n+ ChunkExport\n+ Chunk"]
  embed_ts["embed.ts\n+ getEmbedder\n+ embed"]
  config_ts["config.ts\n+ RagConfig\n+ loadConfig\n+ writeDefaultConfig"]
  graph_ts["graph.ts\n+ resolveImports\n+ resolveImportsForFile\n+ tryResolvePath"]
  parse_ts["parse.ts\n+ ParsedFile\n+ parseFile\n+ buildWeightedText"]
  watcher_ts["watcher.ts\n+ matchesAny\n+ startWatcher"]
  benchmark_ts["benchmark.ts\n+ BenchmarkQuery\n+ BenchmarkResult\n+ BenchmarkSummary"]
  eval_ts["eval.ts\n+ EvalTask\n+ EvalTrace\n+ EvalSummary"]
  conversation_ts["conversation.ts\n+ readJSONL\n+ parseTurns\n+ discoverSessions"]
  conversation_index_ts["conversation-index.ts\n+ indexConversation\n+ startConversationTail"]
  server_ts --> db_ts
  server_ts --> config_ts
  server_ts --> indexer_ts
  server_ts --> search_ts
  server_ts --> watcher_ts
  server_ts --> graph_ts
  server_ts --> embed_ts
  server_ts --> conversation_ts
  server_ts --> conversation_index_ts
  cli_ts --> db_ts
  cli_ts --> config_ts
  cli_ts --> indexer_ts
  cli_ts --> search_ts
  cli_ts --> benchmark_ts
  cli_ts --> eval_ts
  cli_ts --> graph_ts
  cli_ts --> embed_ts
  cli_ts --> conversation_ts
  cli_ts --> conversation_index_ts
  conversation_index_ts --> conversation_ts
  conversation_index_ts --> chunker_ts
  conversation_index_ts --> embed_ts
  conversation_index_ts --> db_ts
  indexer_ts --> parse_ts
  indexer_ts --> embed_ts
  indexer_ts --> chunker_ts
  indexer_ts --> db_ts
  indexer_ts --> config_ts
  indexer_ts --> graph_ts
  search_ts --> embed_ts
  search_ts --> db_ts
  watcher_ts --> indexer_ts
  watcher_ts --> config_ts
  watcher_ts --> db_ts
  watcher_ts --> graph_ts
  benchmark_ts --> db_ts
  benchmark_ts --> search_ts
  benchmark_ts --> config_ts
  eval_ts --> db_ts
  eval_ts --> search_ts
  eval_ts --> config_ts
  db_ts --> embed_ts
  style server_ts fill:#e1f5fe,stroke:#0288d1
  style cli_ts fill:#e1f5fe,stroke:#0288d1
```

Entry points (`server.ts`, `cli.ts`) are highlighted in blue — they have no incoming imports. The graph is extracted from tree-sitter AST parsing, not regex, so it handles re-exports, barrel files, and aliased imports correctly.

## Configuration

Create `.rag/config.json` in your project (or run `local-rag init`):

```json
{
  "include": [
    "**/*.md", "**/*.txt",
    "**/Makefile", "**/makefile", "**/GNUmakefile",
    "**/Dockerfile", "**/Dockerfile.*",
    "**/Jenkinsfile", "**/Jenkinsfile.*",
    "**/Vagrantfile", "**/Gemfile", "**/Rakefile", "**/Brewfile", "**/Procfile",
    "**/*.yaml", "**/*.yml", "**/*.json", "**/*.toml", "**/*.xml",
    "**/*.sh", "**/*.bash", "**/*.zsh",
    "**/*.tf", "**/*.proto", "**/*.graphql", "**/*.gql", "**/*.sql",
    "**/*.bru"
  ],
  "exclude": ["node_modules/**", ".git/**", "dist/**", ".rag/**"],
  "chunkSize": 512,
  "chunkOverlap": 50,
  "hybridWeight": 0.7,
  "searchTopK": 5,
  "benchmarkTopK": 5,
  "benchmarkMinRecall": 0.8,
  "benchmarkMinMrr": 0.6
}
```

or an example of exluding files that are definetly not supported and i thought of them - might have missed some

```json
{
  "include": ["**/*"],
  "exclude": [
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    "out/**",
    ".rag/**",
    "**/*.lock",
    "**/package-lock.json",
    "**/*.min.js",
    "**/*.map",
    "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.webp", "**/*.ico", "**/*.svg",
    "**/*.pdf", "**/*.zip", "**/*.tar", "**/*.gz",
    "**/*.wasm", "**/*.bin", "**/*.exe", "**/*.dylib", "**/*.so",
    "**/*.db", "**/*.sqlite",
    "**/*.ttf", "**/*.woff", "**/*.woff2", "**/*.eot"
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `include` | see [Supported file types](#supported-file-types) | Glob patterns for files to index |
| `exclude` | `["node_modules/**", ...]` | Glob patterns to skip |
| `chunkSize` | `512` | Max tokens per chunk |
| `chunkOverlap` | `50` | Overlap tokens between chunks |
| `hybridWeight` | `0.7` | Blend ratio: 1.0 = vector only, 0.0 = BM25 only |
| `searchTopK` | `5` | Default number of search results |
| `benchmarkTopK` | `5` | Default top-K for benchmark/eval runs |
| `benchmarkMinRecall` | `0.8` | Minimum Recall@K to pass benchmark (CI) |
| `benchmarkMinMrr` | `0.6` | Minimum MRR to pass benchmark (CI) |

All options can be overridden by CLI flags (e.g. `--top 10`).

## Supported file types

Files are detected by extension or by basename (for files with no extension or a suffix-variant like `Dockerfile.prod`). Each type gets a dedicated chunking strategy so chunks land on meaningful boundaries rather than arbitrary character counts.

### AST-aware (tree-sitter)

These use `code-chunk` to extract real function/class/interface/enum boundaries. Import and export symbols are also captured and stored for the project dependency graph.

| Extensions | Notes |
|---|---|
| `.ts` `.tsx` `.js` `.jsx` | TypeScript & JavaScript |
| `.py` | Python |
| `.go` | Go |
| `.rs` | Rust |
| `.java` | Java |

### Structured data & config

| Extensions / filenames | Chunking strategy |
|---|---|
| `.yaml` `.yml` | Split on top-level keys. OpenAPI files: `paths:` is further split per endpoint (`  /users:`, `  /orders:`) so each route is its own chunk. |
| `.json` | Parse and split per top-level key. OpenAPI files: each path under `paths` becomes its own chunk. Falls back to paragraph split for invalid JSON. |
| `.toml` | Split on `[section]` and `[[array-of-tables]]` headers (e.g. each `[[package]]` in a Cargo workspace). |
| `.xml` | Split on blank-line-separated blocks. |

### Build, CI & task runners

Detected by basename — exact match or prefix match (e.g. `Dockerfile.dev` and `Dockerfile.prod` are both treated as Dockerfiles).

| Basename pattern | Chunking strategy |
|---|---|
| `Makefile` `makefile` `GNUmakefile` | Split on target definitions — each `target: deps` line and its recipe is one chunk. |
| `Dockerfile` `Dockerfile.*` | Split on `FROM` instructions (stage boundaries in multi-stage builds). |
| `Jenkinsfile` `Jenkinsfile.*` | Split on blank-line blocks (Groovy DSL). |
| `Vagrantfile` `Gemfile` `Rakefile` `Brewfile` | Split on blank-line blocks (Ruby DSL). |
| `Procfile` | Split on blank-line blocks. |

### Shell & scripting

| Extensions | Notes |
|---|---|
| `.sh` `.bash` `.zsh` `.fish` | Split on blank-line blocks (function and section boundaries). |

### Infrastructure & schema languages

| Extensions | Chunking strategy |
|---|---|
| `.tf` | Split on blank-line blocks (HCL `resource`, `module`, `variable` blocks). |
| `.proto` | Split on blank-line blocks (message, service, enum definitions). |
| `.graphql` `.gql` | Split on blank-line blocks (type, query, mutation, fragment definitions). |
| `.sql` | Split on `;`-terminated statement boundaries. |

| Extensions | Chunking strategy |
|---|---|
| `.bru` | Split on top-level blocks (`meta {}`, `post {}`, `headers {}`, `body:json {}`, `tests {}`, etc.). Each block is a chunk — lets you search across requests by endpoint, auth type, headers, or test assertions. |

### Markdown & plain text

| Extensions | Chunking strategy |
|---|---|
| `.md` `.mdx` `.markdown` | Split on heading boundaries (`#` / `##` / `###`). Frontmatter fields (`name`, `description`, `type`, `tags`) are extracted and prepended to boost relevance. |
| `.txt` | Split on paragraphs. |

> Files not matching any of the above extensions still fall back to paragraph splitting, so they're searchable even without a dedicated strategy. You can add any glob pattern to `include` in `.rag/config.json`.

## How it works

```mermaid
flowchart TD
  A["📁 Project files"] --> B["Parse & filter"]
  B --> C["Chunk"]
  C --> D["Embed"]
  C --> E["Extract imports/exports"]
  D --> F[("SQLite DB\nvectors + FTS + graph")]
  E --> F
  F --> G{"Agent query"}
  G -->|"semantic question"| H["Hybrid search\nvector + BM25"]
  G -->|"navigation"| I["Project map\nMermaid graph"]
  G -->|"file changed"| J["Watcher\nre-index + re-resolve"]
  H --> K["Ranked results\nwith snippets"]
  I --> L["Dependency graph\nfile or directory level"]
  J --> F
  K --> M["Query log"]
  M --> N["Analytics\ngaps & trends"]

  O["💬 JSONL transcripts"] --> P["Tail & parse turns"]
  P --> Q["Chunk + embed turns"]
  Q --> F
  G -->|"past discussion"| R["Conversation search\nvector + BM25"]
  R --> S["Relevant turns\nwith tool context"]
  G -->|"mark moment"| T["Create checkpoint"]
  T --> F
  G -->|"recall history"| U["Search checkpoints"]
  U --> V["Decisions, milestones,\nblockers, handoffs"]

  style A fill:#f9f9f9,stroke:#333
  style O fill:#f9f9f9,stroke:#333
  style F fill:#e8f5e9,stroke:#388e3c
  style K fill:#e1f5fe,stroke:#0288d1
  style L fill:#e1f5fe,stroke:#0288d1
  style S fill:#e1f5fe,stroke:#0288d1
  style V fill:#e1f5fe,stroke:#0288d1
  style N fill:#fff3e0,stroke:#f57c00
```

### Step by step

1. **Parse & filter** — Walks your project, matches files against include/exclude globs. Markdown files get frontmatter extracted and weighted. Code files are detected by extension.

2. **Chunk** — Splits content into searchable pieces using a strategy matched to each file type. AST-supported code files (`.ts`, `.py`, `.go`, `.rs`, `.java`, etc.) use tree-sitter via `code-chunk` — chunks respect function/class boundaries and never cut mid-statement. Markdown splits on headings. YAML and JSON split on top-level keys (OpenAPI files go deeper, splitting per path endpoint). TOML splits on `[section]` headers. Dockerfiles split on `FROM` stage boundaries. Makefiles split on target definitions. SQL splits on `;` statement boundaries. Shell, HCL, proto, GraphQL, and Ruby DSL files split on blank-line-separated blocks. See [Supported file types](#supported-file-types) for the full list.

3. **Embed** — Each chunk is embedded into a 384-dimensional vector using all-MiniLM-L6-v2 (runs in-process via Transformers.js + ONNX, no API calls). Vectors are stored in sqlite-vec for fast similarity search.

4. **Extract imports/exports** — During AST chunking, import specifiers and exported symbols are captured. After all files are indexed, relative imports are resolved to actual files in the index (with extension probing for `.ts`/`.tsx`/`.js`/`.jsx`). This builds the dependency graph.

5. **Hybrid search** — Queries run both vector similarity (semantic) and BM25 (keyword) searches in parallel, then blend results using `hybridWeight` (default 0.7 = 70% semantic, 30% keyword). `search` deduplicates by file and returns the best-scoring file with a 400-char snippet. `read_relevant` skips deduplication and returns top-N individual chunks with full content and entity names (function/class names from AST parsing), so you get exactly the relevant code units without reading entire files.

6. **Project map** — Generates a Mermaid dependency graph from the stored import/export relationships. Supports file-level and directory-level zoom, and focused subgraphs (BFS from a specific file). Entry points are auto-detected and highlighted.

7. **Watcher** — The MCP server watches for file changes with a 2-second debounce. Changed files are re-indexed and their import relationships re-resolved. Deleted files are pruned automatically.

8. **Analytics** — Every search query is logged with result count, top score, and latency. Analytics surface zero-result queries (missing docs), low-relevance queries (weak docs), top search terms, and period-over-period trends.

9. **Conversation index** — The MCP server tails the active JSONL transcript in real time via `fs.watch`. Each user/assistant turn is chunked, embedded, and stored — searchable within seconds. Past sessions are discovered and indexed incrementally on startup. Tool results from Bash/Grep are indexed (Read/Write/Edit are skipped since file content is already in the code index).

10. **Checkpoints** — Agents create named snapshots at important moments: decisions, milestones, blockers, direction changes, and handoffs. Each checkpoint has a title, summary, and embedding for semantic search. This gives future sessions a high-signal trail of what happened and why.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun (built-in SQLite, fast TS) |
| Embeddings | Transformers.js + ONNX (in-process, no daemon) |
| Model | all-MiniLM-L6-v2 (~23MB, 384 dimensions) |
| Vector store | sqlite-vec (single `.db` file) |
| MCP | @modelcontextprotocol/sdk (stdio transport) |

## Per-project storage

```
your-project/
  .rag/
    index.db        ← vectors, chunks, query logs
    config.json     ← include/exclude patterns, settings
```

Add `.rag/` to your `.gitignore`.
