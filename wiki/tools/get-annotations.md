# Tool: get_annotations

`get_annotations` reads back the persistent notes that agents and people pin to files and symbols while working in a project. Those notes are short caveats — a known bug, a race condition, a fragile spot that should not be touched yet, a non-obvious constraint, or a workaround that needs context — written through the [annotate](annotate.md) tool so the warning survives across sessions. `get_annotations` is the read side: you call it to surface those caveats on demand, either by asking for every note on one file or by searching the whole note collection by meaning.

It solves a simple but real problem. Notes left behind are only useful if you can find them again. Inside `read_relevant` they already show up automatically as inline `[NOTE]` blocks next to the code they warn about, but that only covers chunks that happen to rank for your query. `get_annotations` gives direct access: list a file's notes before editing it, or run a semantic search like "concurrency hazards" across every annotation to collect related caveats that live in different files.

The tool is registered alongside its siblings in `registerAnnotationTools`, which wires `annotate`, `get_annotations`, and `delete_annotation` onto the MCP server (`src/tools/annotation-tools.ts:7`). The handler itself spans `src/tools/annotation-tools.ts:58-87`.

## How it works

The handler takes three optional arguments — `path`, `query`, and `directory` — and chooses one of three retrieval paths based on which of `path` and `query` were supplied. There is no required argument; calling it with nothing is valid and returns every note in the project.

```mermaid
flowchart TD
    Start([get_annotations called<br>with path?, query?, directory?]) --> Resolve[resolveProject:<br>absolute dir, load config,<br>apply embedding settings,<br>return RagDB handle]
    Resolve --> HasQuery{query<br>present?}
    HasQuery -->|yes| Embed[embed query into<br>384-dim Float32Array]
    Embed --> Search[searchAnnotations<br>vector search, top 10]
    Search --> HasPathToo{path<br>also given?}
    HasPathToo -->|yes| Filter[keep only rows<br>where row.path === path]
    HasPathToo -->|no| Keep[keep all 10 rows]
    HasQuery -->|no| HasPath{path<br>present?}
    HasPath -->|yes| GetByPath[getAnnotations path:<br>all notes for that file,<br>newest first]
    HasPath -->|no| GetAll[getAnnotations:<br>every note in project,<br>newest first]
    Filter --> Empty{rows<br>empty?}
    Keep --> Empty
    GetByPath --> Empty
    GetAll --> Empty
    Empty -->|yes| NoneOut["return text:<br>No annotations found."]
    Empty -->|no| Format[format each row into<br>one text block, joined]
    Format --> Out([single MCP text content block])
```

1. The caller invokes the tool with any combination of `path`, `query`, and `directory`. All three are optional and validated by Zod string schemas (`src/tools/annotation-tools.ts:44-57`).
2. The handler resolves which project to read from. `resolveProject` turns the optional `directory` into an absolute path (falling back to the `RAG_PROJECT_DIR` environment variable, then the current working directory), verifies it exists, loads that project's config, applies its embedding settings, and returns the `RagDB` handle for that project (`src/tools/index.ts:22-37`). If the directory does not exist, this throws before any query runs.
3. If a `query` was supplied, the handler embeds it. `embed` runs the configured sentence-embedding model (the default is `Xenova/all-MiniLM-L6-v2`, a 384-dimension model) over the query text and returns one mean-pooled, normalized `Float32Array` (`src/embeddings/embed.ts:94-102`).
4. The embedding is passed to `searchAnnotations` with a fixed limit of 10. This runs a vector-similarity search over the stored note embeddings and returns the closest matches, ordered by distance (`src/tools/annotation-tools.ts:63-64`).
5. When both `query` and `path` are given, the ranked search results are filtered in memory down to rows whose `path` exactly equals the supplied `path`, so you get a relevance-ranked view scoped to one file. When only `query` is given, all ten ranked rows are kept (`src/tools/annotation-tools.ts:65`).
6. If there is no `query` but a `path` was given, the handler skips embedding entirely and asks the database for every note on that exact path (`src/tools/annotation-tools.ts:66-67`).
7. If neither argument was given, it fetches every note in the project (`src/tools/annotation-tools.ts:68-69`).
8. If the chosen path produced no rows, the handler returns the plain string `"No annotations found."` (`src/tools/annotation-tools.ts:72-76`).
9. Otherwise it formats each note into a human-readable block and returns the joined text (`src/tools/annotation-tools.ts:78-86`).

### Path-only retrieval

When you pass only `path`, the handler calls `ragDb.getAnnotations(path)` (`src/tools/annotation-tools.ts:67`). That `RagDB` method forwards to the module function `getAnnotations`, passing the open database handle as its first argument (`src/db/index.ts:901-903`). The function builds `SELECT * FROM annotations WHERE 1=1` and, because a `path` was supplied, appends `AND path = ?`, then orders by `updated_at DESC` so the most recently edited note appears first (`src/db/annotations.ts:101-135`). The `symbol_name` column is not filtered here, since the handler passes no `symbolName` — both file-level notes (where `symbol_name` is `NULL`) and symbol-level notes on that file come back together. The match is exact string equality against the stored `path`, so the value you pass must be the same project-relative path the note was written with; this handler does no normalization before querying. There is no top-K cap on this path, so it returns every matching note.

### Semantic query across annotations

When you pass `query` (with or without `path`), the handler embeds the query text and calls `ragDb.searchAnnotations(embedding, 10)` (`src/tools/annotation-tools.ts:63-64`). That runs a nearest-neighbour search against `vec_annotations`, a `vec0` virtual table that stores one embedding per note keyed by `annotation_id` (`src/db/index.ts:419-422`). The SQL pulls the 10 nearest rows with `embedding MATCH ?` ordered by `distance`, then joins back to the `annotations` table to recover each note's full row (`src/db/annotations.ts:137-173`). This is why semantic search finds notes by meaning rather than exact wording: a query about "data races" can surface a note that says "this counter is not thread-safe" even though the words differ.

Each note's embedding was computed at write time, not at read time. The `annotate` tool embeds the note text — prefixed with the symbol name when one is given (`${symbol}: ${note}`) — and stores that vector, so symbol-level notes carry their symbol into the searchable text (`src/tools/annotation-tools.ts:30-32`). `searchAnnotations` returns each row with an extra `score` field computed as `1 / (1 + distance)` (`src/db/annotations.ts:171`), but this handler does not display the score — it only relies on the ordering and reformats the rows.

### path + query combination

Supplying both narrows a semantic search to a single file. The search still runs across all notes and returns the global top 10 by relevance; the handler then filters that list in memory, keeping only rows whose `path` equals the supplied `path` (`src/tools/annotation-tools.ts:65`). Because the filter is applied after the database already limited the result to 10, a file with many notes can lose relevant ones that ranked outside the global top 10 — the limit is enforced before the path filter, not after. For an exhaustive list of one file's notes, prefer path-only retrieval, which has no top-K cap.

The three modes compared:

| supplied arguments | retrieval call | ordering | cap | scope |
| --- | --- | --- | --- | --- |
| `path` only | `getAnnotations(path)` | `updated_at DESC` (newest first) | none | one file, all notes |
| `query` only | `searchAnnotations(embedding, 10)` | vector distance (most relevant first) | 10 | whole project |
| `path` + `query` | `searchAnnotations(embedding, 10)`, then in-memory `path` filter | vector distance | 10 before filter | one file, but only notes inside the global top 10 |
| neither | `getAnnotations()` | `updated_at DESC` | none | whole project, all notes |

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | string | no | Project-relative file path to retrieve notes for. Used alone for a full list of that file's notes, or with `query` to scope a semantic search to that file. Matched by exact string equality against stored paths (`src/db/annotations.ts:105-108`). |
| `query` | string | no | Natural-language search text. When present, the handler embeds it and ranks notes by vector similarity across the whole project, capped at the top 10 (`src/tools/annotation-tools.ts:62-65`). |
| `directory` | string | no | Which project to read from. Defaults to the `RAG_PROJECT_DIR` environment variable, then the current working directory. Resolved to an absolute path and checked for existence by `resolveProject` (`src/tools/index.ts:26-32`). |

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| matching annotations | A single MCP text content block. Each note is rendered as `#<id>  <path>` (or `#<id>  <path>  •  <symbolName>` for symbol notes), an optional ` [<author>]` suffix, then the note text and the `updatedAt` timestamp on their own indented lines, with a blank line between notes (`src/tools/annotation-tools.ts:78-86`). |
| empty-result message | When no note matches, the same content block instead carries the literal string `"No annotations found."` (`src/tools/annotation-tools.ts:72-76`). |

The shape of each row comes from `AnnotationRow`: `id`, `path`, `symbolName`, `note`, `author`, `createdAt`, and `updatedAt` (`src/db/types.ts:47-55`). The handler does not emit `createdAt` or the raw similarity score — only `id`, the target (`path` plus optional `symbolName`), `author`, `note`, and `updatedAt` reach the caller.

## Branches and failure cases

- **No arguments** — both `path` and `query` are absent, so the handler calls `getAnnotations()` with no filter and returns every note in the project, newest first (`src/tools/annotation-tools.ts:68-69`).
- **Path only** — semantic search is skipped entirely; no embedding model is loaded. The database returns every note on that exact path (`src/tools/annotation-tools.ts:66-67`).
- **Query only** — the query is embedded and the global top 10 nearest notes are returned, ranked by similarity (`src/tools/annotation-tools.ts:62-65`).
- **Path and query together** — the top-10 semantic results are filtered in memory to the given path; notes on that file that ranked outside the top 10 are not recovered (`src/tools/annotation-tools.ts:65`).
- **Empty result** — any path that yields zero rows returns the string `"No annotations found."` rather than an empty block or an error (`src/tools/annotation-tools.ts:72-76`).
- **Missing or invalid directory** — `resolveProject` throws `Directory does not exist: <path>` when the resolved directory is absent on disk, so the tool surfaces an error instead of querying (`src/tools/index.ts:30-32`).
- **Path mismatch** — because the path filter is exact string equality, a value that differs from the stored path (for example an absolute path when the note was stored relative, or differing separators) silently matches nothing and falls into the empty-result branch. This handler does not normalize the path before querying.
- **Corrupted model cache on the query path** — the first semantic query in a process loads the embedding model. If the cached model file is corrupted, `getEmbedder` deletes the cache directory and retries the load once before giving up (`src/embeddings/embed.ts:77-88`).

## State changes

`get_annotations` is read-only. It runs `SELECT` queries against the `annotations` and `vec_annotations` tables and never inserts, updates, or deletes a row. The notes it returns are created and modified by [annotate](annotate.md) and removed by [delete_annotation](delete-annotation.md); this tool only reads what those two have written. The only side effect on the query-only path is lazily loading the embedding model into memory the first time it is needed, which is a process-level singleton cache, not stored state (`src/embeddings/embed.ts:60-92`).

## Example

Retrieve every note attached to one file:

```json
{ "path": "src/db/index.ts" }
```

Search all notes by meaning, regardless of file:

```json
{ "query": "thread safety and concurrency hazards" }
```

Scope a semantic search to a single file:

```json
{ "path": "src/embeddings/embed.ts", "query": "model cache corruption" }
```

A non-empty response renders as text shaped like this (values are illustrative):

```
#7  src/db/index.ts  •  RagDB [agent]
  Constructor throws on EROFS/EACCES — set RAG_DB_DIR to a writable dir.
  (2026-05-30T11:04:18.221Z)

#3  src/db/index.ts [human]
  WAL mode plus busy_timeout=5000; concurrent writers will retry, not fail.
  (2026-05-28T09:12:50.880Z)
```

## Key source files

- `src/tools/annotation-tools.ts` — registers the tool and contains the handler that chooses the retrieval path, runs the query, and formats the output.
- `src/db/annotations.ts` — the database functions `getAnnotations` (path/symbol filter) and `searchAnnotations` (vector search) that back the two retrieval paths.
- `src/db/index.ts` — the `RagDB` methods that forward to those functions, and the `annotations` / `vec_annotations` table definitions.
- `src/db/types.ts` — defines `AnnotationRow`, the row shape returned to the handler.
- `src/embeddings/embed.ts` — turns the `query` string into the embedding used for semantic search, and owns the lazy model cache.
- `src/tools/index.ts` — `resolveProject`, which resolves the target project directory and database handle before any query runs.

## Related tools

- [annotate](annotate.md) — writes the notes this tool reads, including the symbol-prefixed embedding text that semantic search relies on.
- [delete_annotation](delete-annotation.md) — removes a note by its `id`; the workflow is to find the `id` here first, then delete.
- [annotations CLI](../cli/annotations.md) — the command-line equivalent for listing the same persistent notes outside an MCP session.
