# Tool: search_commits

`search_commits` lets an agent search a project's git history by meaning rather
than by scrolling `git log`. It answers questions like "why was the
path-normalization logic added?", "when did we switch the embedding model?", or
"what has this author been working on lately?". The tool finds commits two ways
at once — by *meaning* (vector similarity over the indexed commit text) and by
*keyword* (full-text match on the commit message and diff summary) — blends the
two scores, applies author/date/path filters and a score threshold, and returns
the surviving commits ranked by relevance.

The tool is registered on the MCP server by `registerGitHistoryTools`, which
declares the tool name, a description, and the argument schema, then wires up the
search handler (`src/tools/git-history-tools.ts:34-109`). It is read-only: it
queries the index and formats text, and never writes to the database.

Commit history must already be indexed for this tool to return anything. The
index is populated by the [`mimirs history index`](../cli/history.md) command,
which walks `git log`, embeds each commit, and writes rows into the index
database. If nothing has been indexed yet, the tool short-circuits with a message
telling the caller to index first (`src/tools/git-history-tools.ts:58-66`).

## What it does

When the handler runs it first checks whether any commits are indexed at all. If
so, it embeds the query into a single vector, runs two independent searches over
the stored commits — a vector (semantic) search and a full-text search — then
merges the two result sets into one ranked list, deduplicated by commit hash. It
drops anything below the score threshold, sorts by the blended score, truncates
to the requested count, and renders each surviving commit into a short text
block.

```mermaid
flowchart TD
    callTool["search_commits(query, top, author,<br>since, until, path, threshold, directory)"]
    resolve["resolveProject(directory)<br>→ RagDB handle + config"]
    statusCheck{"getGitHistoryStatus()<br>totalCommits === 0?"}
    emptyMsg["return: No git history indexed.<br>Run index_files() or mimirs history index"]
    embedQ["embed(query)<br>→ 384-dim query vector"]
    vec["searchGitCommits(vector, top, filters)<br>vec_git_commits MATCH, score 1/(1+distance)"]
    fts["textSearchGitCommits(query, top, filters)<br>fts_git_commits MATCH, score 1/(1+abs(rank))"]
    merge["merge by hash into Map<br>blend with HYBRID_WEIGHT = 0.7"]
    cut["filter score >= threshold<br>sort desc, slice(top)"]
    emptyResults{"results.length === 0?"}
    noMatch["return: No commits found matching query"]
    format["format each commit, prepend header<br>return single text content item"]

    callTool --> resolve --> statusCheck
    statusCheck -->|yes| emptyMsg
    statusCheck -->|no| embedQ
    embedQ --> vec
    embedQ --> fts
    vec --> merge
    fts --> merge
    merge --> cut --> emptyResults
    emptyResults -->|yes| noMatch
    emptyResults -->|no| format
```

1. The client calls the tool with a `query` and optional `top`, `author`,
   `since`, `until`, `path`, `threshold`, and `directory`. The schema requires
   `query` to be at most 2000 characters and defaults `top` to 10 and `threshold`
   to 0 (`src/tools/git-history-tools.ts:38-54`).
2. `resolveProject` turns the optional `directory` into an absolute path, loads
   the project config, applies the embedding model settings, and hands back the
   `RagDB` handle. If the directory does not exist it throws before any search
   runs (`src/tools/index.ts:22-37`).
3. The handler asks the database how many commits are indexed via
   `getGitHistoryStatus`. When the count is zero it returns a fixed "not indexed"
   message and stops — it never embeds the query or touches the search tables
   (`src/tools/git-history-tools.ts:58-66`).
4. The query string is embedded once. `embed` loads the shared
   sentence-transformer model and returns a single mean-pooled, L2-normalized
   `Float32Array` (`src/embeddings/embed.ts:95-103`).
5. The vector, the requested count, and the four filters are passed to
   `searchGitCommits`, which runs a nearest-neighbor search over the
   `vec_git_commits` virtual table, joins back to the commit rows, applies the
   filters, and scores each hit (`src/db/git-history.ts:154-187`).
6. The same count, raw query string, and filters are passed to
   `textSearchGitCommits`, which runs a full-text match over the
   `fts_git_commits` index and scores by FTS rank (`src/db/git-history.ts:189-225`).
7. The two lists are merged into a map keyed by commit hash. Each entry gets a
   blended hybrid score using a fixed weight of 0.7 for the vector component and
   0.3 for the text component (`src/tools/git-history-tools.ts:74-88`).
8. The merged entries are filtered to those at or above `threshold`, sorted by
   descending score, and sliced to `top` (`src/tools/git-history-tools.ts:90-93`).
9. If nothing survives, a fixed "no commits found" message is returned, echoing
   the query and the author filter if one was given
   (`src/tools/git-history-tools.ts:95-102`).
10. Otherwise each commit is rendered into a text block and the joined text,
    prefixed with a results header, is returned as the tool's single content item
    (`src/tools/git-history-tools.ts:104-107`).

## Inputs

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string (≤ 2000 chars) | yes | What to search for. Used both as the text to embed for the vector search and, raw, as the keyword query for the full-text search (`src/tools/git-history-tools.ts:39`). |
| `top` | integer ≥ 1 | no | Maximum number of commits to return. Defaults to 10. Also caps how many candidates each underlying search fetches (`src/tools/git-history-tools.ts:40-41`). |
| `author` | string | no | Case-insensitive substring match against the commit's author name *or* email (`src/tools/git-history-tools.ts:42-43`, `src/db/git-history.ts:145-146`). |
| `since` | string | no | ISO date string. Keeps only commits whose date is at or after this value, using a plain string comparison on the stored ISO date (`src/tools/git-history-tools.ts:44-45`, `src/db/git-history.ts:147`). |
| `until` | string | no | ISO date string. Keeps only commits whose date is at or before this value (`src/tools/git-history-tools.ts:46-47`, `src/db/git-history.ts:148`). |
| `path` | string | no | Substring match against the paths a commit touched. A commit is kept if any of its changed-file paths contains this substring (`src/tools/git-history-tools.ts:48-49`, `src/db/git-history.ts:149`). |
| `threshold` | number 0–1 | no | Minimum blended relevance score. Defaults to 0, so by default nothing is dropped on score (`src/tools/git-history-tools.ts:50-51`, `src/tools/git-history-tools.ts:91`). |
| `directory` | string | no | Project directory whose commit index to search. Defaults to the `RAG_PROJECT_DIR` environment variable, then the current working directory (`src/tools/index.ts:26`). |

## Outputs

| Output | Where it lands / shape / description |
| --- | --- |
| Ranked commits | A single text content item. It opens with the header `## Results for "<query>" (<n> commits, <total> indexed)` and then one block per commit (`src/tools/git-history-tools.ts:104-107`). |
| Per-commit block | Three lines: rank, short hash, score to two decimals, the date portion of the commit timestamp, `@author`, an optional ` [merge]` tag and ` (refs)` list; then the first line of the commit message; then up to five changed file paths with a `+N more` overflow note and the total insertions/deletions (`src/tools/git-history-tools.ts:7-19`). |
| Empty-index message | When no commit is indexed: `No git history indexed. Run \`index_files()\` or \`mimirs history index\` first.` (`src/tools/git-history-tools.ts:60-65`). |
| No-match message | When commits exist but none survive filtering and threshold: `No commits found matching "<query>"` plus ` by <author>` when an author filter was given (`src/tools/git-history-tools.ts:95-102`). |

This tool only reads. It does not write or modify any stored state, so there is
no state-change step in the flow.

## How the two searches work

Both searches read from `git_commits` (the commit metadata) and its companion
search tables, and both apply the same four filters and the same candidate
over-fetch strategy. They return the same `GitCommitSearchResult` shape — every
commit field plus a `score` (`src/db/types.ts:99-101`).

**Vector search.** `searchGitCommits` runs an inner query against the
`vec_git_commits` vec0 table that matches the query embedding and orders by
distance, then joins the matched commit ids back to their `git_commits` rows
(`src/db/git-history.ts:171-175`). Each result's `score` is `1 / (1 + distance)`,
mapping a smaller distance to a higher score (`src/db/git-history.ts:179`).

**Full-text search.** `textSearchGitCommits` matches the query against the
`fts_git_commits` FTS5 table — which indexes the commit `message` and
`diff_summary` columns — and orders by FTS5's built-in `rank`
(`src/db/git-history.ts:206-213`, `src/db/index.ts:475-480`). The query is first
run through `sanitizeFTS`, which splits on whitespace and wraps every token in
double quotes (joining them with `OR`) so that characters FTS5 would otherwise
treat as operators (`+`, `-`, `*`, `AND`, `OR`, `NOT`, `NEAR`, parentheses) are
matched literally instead of throwing a syntax error
(`src/search/usages.ts:39-43`). Its `score` is
`1 / (1 + abs(rank))`; FTS5 ranks are negative, so the absolute value turns the
best (most negative) rank into the highest score (`src/db/git-history.ts:217`).

**Filter-aware over-fetch.** Both functions ask the SQL layer for more rows than
`top` so the in-code filters have material to work with. When any of `author`,
`since`, `until`, or `path` is set they fetch `topK * 5` candidates; otherwise
`topK * 2` (`src/db/git-history.ts:163-164`, `src/db/git-history.ts:198-199`). The
filters then run in JavaScript over those candidates via `applyFilters`, and each
function finally slices its filtered list back down to `top`
(`src/db/git-history.ts:137-152`, `src/db/git-history.ts:182-186`,
`src/db/git-history.ts:220-224`). Because the over-fetch is bounded, a very
narrow filter combined with a large indexed history can still miss matching
commits that ranked just outside the candidate window.

## Hybrid scoring and dedup

The handler merges the two result lists with a `Map` keyed by commit `hash`.
Every vector hit seeds the map with its full result object. Then, for each
full-text hit, the handler either blends into an existing entry or adds a new one
(`src/tools/git-history-tools.ts:74-88`):

```
// commit found by both searches
score = 0.7 * vectorScore + 0.3 * textScore

// commit found only by full-text search
score = 0.3 * textScore
```

The blend weight is the constant `HYBRID_WEIGHT = 0.7` declared inline in the
handler — semantic similarity counts for 70% and keyword match for 30%
(`src/tools/git-history-tools.ts:76`). Unlike some other search tools in this
project, this weight is hardcoded here and is not read from the project config.

A consequence of the merge order is worth knowing: a commit found *only* by the
vector search keeps its raw vector score (it is never down-weighted), while a
commit found *only* by full-text search is multiplied by `0.3`. So a strong
keyword-only hit is penalized relative to a strong vector-only hit, and a commit
found by both gets the full weighted blend. After merging, entries below
`threshold` are dropped, the rest are sorted by descending score, and the list is
sliced to `top` (`src/tools/git-history-tools.ts:90-93`).

## Branches and failure cases

| Branch | Behavior |
| --- | --- |
| Directory does not exist | `resolveProject` throws `Directory does not exist: <path>` before any search runs (`src/tools/index.ts:30-32`). |
| No commits indexed | `getGitHistoryStatus().totalCommits === 0` short-circuits with the "No git history indexed" message; the query is never embedded (`src/tools/git-history-tools.ts:58-66`). |
| Commits exist but none match | After filtering and threshold the result list is empty, so the "No commits found matching" message is returned (`src/tools/git-history-tools.ts:95-102`). |
| `author` filter | Kept only if the substring (lower-cased) appears in the author name or email (`src/db/git-history.ts:145-146`). |
| `since` / `until` filter | Kept only if the stored ISO date string compares `>= since` / `<= until`. This is a lexical string compare, which works because dates are stored as ISO strings (`src/db/git-history.ts:147-148`). |
| `path` filter | Kept only if some changed-file path string contains the substring; `filesChanged` is a flat array of path strings parsed from the stored `files_changed` JSON (`src/db/git-history.ts:149`, `src/db/git-history.ts:112`). |
| Any filter set | Both searches widen their candidate fetch to `topK * 5` to survive in-code filtering; with no filters they fetch `topK * 2` (`src/db/git-history.ts:163-164`, `src/db/git-history.ts:198-199`). |
| `threshold` set above 0 | Merged commits scoring below the threshold are removed before sorting (`src/tools/git-history-tools.ts:91`). |
| Commit with more than five changed files | The block lists the first five and appends ` +N more` (`src/tools/git-history-tools.ts:11-12`). |
| Merge commit / commit with refs | The header line gains a ` [merge]` tag and/or a ` (<ref>, <ref>)` list when those fields are populated (`src/tools/git-history-tools.ts:8-9`). |

Unlike the conversation search tool, this handler does not wrap the full-text
search in a try/catch; the token quoting done by `sanitizeFTS` is what keeps a
stray operator character in the query from making the FTS match throw
(`src/search/usages.ts:39-43`).

## What the index contains

This tool can only surface what the history indexer wrote. The indexer walks
`git log --all` and, for each commit, records the changed files with
`git diff-tree --numstat`. Two indexer details shape what `search_commits` and
the `path` filter can see (`src/git/indexer.ts:84-92`):

- It passes `--root` to `diff-tree`, so the very first (parentless) commit's
  files are recorded too. Without this, a file first introduced in the root
  commit would be invisible to history searches and to the `path` filter.
- It runs with `-c core.quotepath=false`, so a non-ASCII path such as `café.ts`
  is stored literally instead of octal-escaped and quoted. That keeps the stored
  `files_changed` paths matching what callers actually pass to the `path` filter.

The per-commit block's short hash is the first eight characters of the full hash,
set at index time (`src/git/indexer.ts:345`).

## Example

Example arguments:

```json
{
  "query": "why did we switch the embedding model dimension",
  "author": "alice",
  "since": "2025-01-01",
  "path": "src/embeddings",
  "top": 3,
  "threshold": 0.4
}
```

Illustrative output text (values synthetic):

```
## Results for "why did we switch the embedding model dimension" (2 commits, 412 indexed)

1. **a1b2c3d4** (0.81) — 2025-02-14 — @alice
   feat: configurable embedding model + dimension
   Files: src/embeddings/embed.ts, src/config/index.ts (+96 -12)

2. **9f8e7d6c** (0.52) — 2025-01-20 — @alice [merge]
   Merge branch 'embed-dim-guard'
   Files: src/db/index.ts, src/embeddings/embed.ts +3 more (+44 -8)
```

Each block opens with the rank, short hash, blended score, the date portion of
the commit timestamp, and the author; merge commits and commits with refs get
extra tags. The second line is the first line of the commit message, and the
third lists the changed files (first five, with a `+N more` overflow) and the
insertion/deletion totals (`src/tools/git-history-tools.ts:14-18`).

## Key source files

| File | Role |
| --- | --- |
| `src/tools/git-history-tools.ts` | Registers the `search_commits` MCP tool and runs the empty-index guard → embed → dual search → hybrid merge → format sequence. |
| `src/db/git-history.ts` | `searchGitCommits` (vector) and `textSearchGitCommits` (full-text) query the commit tables, apply the author/date/path filters, and score results; `getGitHistoryStatus` powers the empty-index guard. |
| `src/embeddings/embed.ts` | `embed` turns the query string into a single normalized vector. |
| `src/search/usages.ts` | `sanitizeFTS` quotes query tokens so FTS5 treats operator characters literally. |
| `src/git/indexer.ts` | Walks `git log`, records changed files with `--root` and `core.quotepath=false`, embeds each commit, and writes the rows this tool reads. |
| `src/db/index.ts` | Defines the `git_commits`, `vec_git_commits`, and `fts_git_commits` tables and exposes the `RagDB` wrapper methods the tool calls. |
| `src/tools/index.ts` | `resolveProject` resolves the directory, database handle, and config used by the tool. |

## Related flows

- The [`mimirs history index`](../cli/history.md) command populates the
  `git_commits`, `vec_git_commits`, and `fts_git_commits` tables this tool reads;
  run it (or `mimirs history status` to check) before searching.
- The [`file_history`](../tools/file-history.md) tool, registered alongside this
  one in the same file, lists commits that touched a specific path in date order
  rather than by relevance (`src/tools/git-history-tools.ts:111-142`).
