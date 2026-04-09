# API Surface

## MCP Tools

These tools are registered by `registerAllTools()` in `src/tools/index.ts` and
available to any MCP client:

| Tool | File | Description |
|------|------|-------------|
| `search` | search.ts | Semantic + keyword search over indexed files -- returns ranked paths, scores, and snippets |
| `read_relevant` | search.ts | Chunk-level retrieval -- returns individual chunks with entity names, full content, and line ranges |
| `search_symbols` | search.ts | Find exported symbols by name -- functions, classes, types, interfaces, enums |
| `write_relevant` | search.ts | Find the best insertion point for new content |
| `project_map` | graph-tools.ts | Generate a dependency graph -- file-level or directory-level, with optional focus |
| `find_usages` | graph-tools.ts | Find every call site of a symbol across the codebase |
| `depends_on` | graph-tools.ts | List all files that a given file imports |
| `depended_on_by` | graph-tools.ts | List all files that import a given file |
| `index_files` | index-tools.ts | Index files in a directory -- skips unchanged files, prunes deleted ones |
| `index_status` | index-tools.ts | Show file count, chunk count, last indexed time |
| `remove_file` | index-tools.ts | Remove a specific file from the index |
| `annotate` | annotation-tools.ts | Attach a persistent note to a file or symbol |
| `get_annotations` | annotation-tools.ts | Retrieve notes by file path, or search semantically across all annotations |
| `delete_annotation` | annotation-tools.ts | Remove an annotation by ID |
| `create_checkpoint` | checkpoint-tools.ts | Mark an important moment -- decisions, milestones, blockers |
| `list_checkpoints` | checkpoint-tools.ts | List checkpoints, most recent first |
| `search_checkpoints` | checkpoint-tools.ts | Semantic search over checkpoint titles and summaries |
| `search_conversation` | conversation-tools.ts | Search conversation history -- finds past decisions and discussions |
| `git_context` | git-tools.ts | Show uncommitted changes, recent commits, and changed files |
| `search_analytics` | analytics-tools.ts | Usage analytics -- query counts, zero-result queries, top terms |
| `server_info` | server-info-tools.ts | Show server configuration, index status, and connected databases |
| `generate_wiki` | wiki-tools.ts | Generate or update a structured markdown wiki for the codebase |

## CLI Commands

The CLI is invoked via `bunx mimirs <command>`. Commands are defined in
`src/cli/commands/`:

| Command | File | Description |
|---------|------|-------------|
| `serve` | serve.ts | Start MCP server (stdio transport) |
| `init [dir]` | init.ts | Set up editor config, rules, `.mimirs/`, `.gitignore` (`--ide claude\|cursor\|windsurf\|copilot\|jetbrains\|all`) |
| `index [dir]` | index-cmd.ts | Index files in a directory |
| `search <query>` | search-cmd.ts | Semantic search (file-level, deduplicated) |
| `read <query>` | search-cmd.ts | Chunk-level retrieval (like `read_relevant`) |
| `status [dir]` | status.ts | Show index stats |
| `remove <path>` | remove.ts | Remove a file from the index |
| `analytics [dir]` | analytics.ts | Usage analytics with trend comparison |
| `map [dir]` | map.ts | Dependency graph (Mermaid format) |
| `benchmark <file>` | benchmark.ts | Run search quality benchmark |
| `benchmark-models` | benchmark-models.ts | Compare embedding model performance |
| `eval <file>` | eval.ts | A/B eval harness (with/without RAG) |
| `conversation` | conversation.ts | Conversation subcommands (search, sessions, index) |
| `checkpoint` | checkpoint.ts | Checkpoint subcommands (create, list, search) |
| `annotations [dir]` | annotations.ts | List annotations (optionally filter by `--path`) |
| `session-context` | session-context.ts | Session start context summary (used by hook) |
| `doctor` | doctor.ts | Diagnose common setup issues |
| `cleanup` | cleanup.ts | Remove mimirs config and data from a project (`-y` to skip confirmation) |
| `demo [dir]` | demo.ts | Interactive feature demo |

## Configuration Options

Stored in `.mimirs/config.json`, validated by `RagConfigSchema` (Zod):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `include` | `string[]` | 50+ patterns | Glob patterns for files to index |
| `exclude` | `string[]` | 20+ patterns | Glob patterns to skip |
| `generated` | `string[]` | `[]` | Glob patterns for generated files (demoted in search) |
| `chunkSize` | `number` | 512 | Characters per chunk (not tokens). Min 64 |
| `chunkOverlap` | `number` | 50 | Overlapping characters between chunks. Min 0 |
| `hybridWeight` | `number` | 0.7 | Vector weight in hybrid merge (BM25 gets 0.3) |
| `searchTopK` | `number` | 10 | Default number of search results |
| `embeddingModel` | `string` | `Xenova/all-MiniLM-L6-v2` | ONNX embedding model |
| `embeddingDim` | `number` | 384 | Output vector dimension |
| `embeddingMerge` | `boolean` | `true` | Merge oversized chunk embeddings via windowing |
| `generated` | `string[]` | `[]` | Glob patterns for generated files (demoted in search) |
| `incrementalChunks` | `boolean` | `false` | Enable chunk-level incremental updates |
| `indexBatchSize` | `number` | 50 | Chunks per embedding batch |
| `indexThreads` | `number` | auto | ONNX thread count |
| `parentGroupingMinCount` | `number` | 2 | Min sibling chunks for parent grouping |
| `benchmarkTopK` | `number` | 5 | Top-K for benchmark evaluation |
| `benchmarkMinRecall` | `number` | 0.8 | Minimum recall threshold |
| `benchmarkMinMrr` | `number` | 0.6 | Minimum MRR threshold |

## See Also

- [Architecture](architecture.md) -- high-level module overview
- [Tools module](modules/tools/) -- MCP tool registration details
- [CLI module](modules/cli/) -- command implementation details
- [Config module](modules/config/) -- schema and validation
- [RagConfig entity](entities/rag-config.md) -- full schema breakdown
