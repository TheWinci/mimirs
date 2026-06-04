# Tool: file_history

`file_history` answers one question: which commits touched this file, and when. It reads the project's already-indexed git history and returns the matching commits newest-first, so an agent can understand how a file evolved without shelling out to `git log` or walking the repository. Because the data is served from the local SQLite index, it works even when the agent has no git access to the working tree, and it is faster than `git log` on large repositories.

This tool only reads. It never spawns `git`, never touches the working tree, and never modifies the index. The commit rows it returns must have been written earlier by the history indexer (run via `index_files()` or `mimirs history index`). If that has never run for the project, the tool simply returns nothing useful and points the caller at indexing.

The tool is registered alongside `search_commits` in `registerGitHistoryTools` `src/tools/git-history-tools.ts:34`. Where `search_commits` ranks commits by semantic relevance to a query, `file_history` is a plain chronological lookup scoped to one file path.

## When to use it

Use `file_history` when you already know the file and want its change timeline: who last touched it, when it was introduced, how active it has been, or the commit messages around a regression. If instead you want to find *why* something changed across the repo, or you only have a topic rather than a path, reach for [search_commits](search-commits.md), which embeds your query and searches all commit messages and diff summaries.

## The flow

```mermaid
sequenceDiagram
    autonumber
    participant Caller as MCP caller
    participant Tool as file_history handler
    participant Resolve as resolveProject
    participant RagDB
    participant SQLite as git_commit_files + git_commits
    Caller->>Tool: file_history(path, top, since, directory)
    Tool->>Resolve: resolveProject(directory, getDB)
    Resolve-->>Tool: { db: RagDB }
    Tool->>RagDB: getFileHistory(path, top, since)
    RagDB->>SQLite: SELECT gc.* WHERE file_path = path<br>OR file_path LIKE '%/'||path<br>ORDER BY date DESC LIMIT top
    SQLite-->>RagDB: rows (newest first)
    RagDB-->>Tool: GitCommitRow[]
    alt no rows
        Tool-->>Caller: "No commits found for ..." hint
    else rows found
        Tool->>Tool: format each row (formatCommitRow)
        Tool-->>Caller: header + one block per commit
    end
```

1. The caller invokes the tool with a file `path` and optional `top`, `since`, and `directory` arguments. The argument shape is validated by the Zod schema declared on the tool; `path` is the only required field `src/tools/git-history-tools.ts:115`.
2. The handler resolves which project to read. `resolveProject` turns the optional `directory` (falling back to `RAG_PROJECT_DIR`, then the current working directory) into an absolute path, verifies it exists, loads that project's config, applies the embedding config, and hands back the `RagDB` for that directory `src/tools/index.ts:22`.
3. The handler calls `ragDb.getFileHistory(path, top, since)` `src/tools/git-history-tools.ts:126`. This `RagDB` method is a thin wrapper that forwards to the standalone query function with the same arguments `src/db/index.ts:1056-1058`.
4. The query joins `git_commit_files` to `git_commits` and matches the file with an exact-or-boundary path test, optionally adds a `date >= since` clause, orders by commit date descending, and limits to `top` rows `src/db/git-history.ts:278-290`.
5. SQLite returns the raw rows, already sorted newest-first by the `ORDER BY gc.date DESC` clause.
6. Each raw row is turned into a `GitCommitRow` by `parseRow`, which decodes the JSON `files_changed` and `refs` columns and coerces the merge flag to a boolean `src/db/git-history.ts:89-119`.
7. If the result list is empty, the handler returns a single text line telling the caller no commits matched and asking whether git history is indexed `src/tools/git-history-tools.ts:128-135`.
8. Otherwise the handler builds a Markdown header with the path and commit count, then maps each row through `formatCommitRow` and joins the blocks `src/tools/git-history-tools.ts:137-140`.
9. The assembled text is returned as a single MCP text content item — there is no structured payload, just formatted Markdown.

## Path matching: exact or directory-boundary

The match is built to accept either the full repo-relative path or just the trailing part of it, while refusing to match across a mid-token boundary. The SQL tests two things with `OR`: an exact equality `gcf.file_path = ?`, and a `LIKE` against the pattern `` `%/${escaped}` `` `src/db/git-history.ts:278-282`. The `%/` prefix forces the match to land on a real path separator, so the value you pass must be a *whole path segment suffix*, not an arbitrary substring of the end.

The practical rule is in the source comment: `getFileHistory("db.ts")` matches `src/db.ts` but never `src/mydb.ts` `src/db/git-history.ts:273-274`. The exact-equality arm covers the case where you pass the complete stored path (for example `src/db/git-history.ts`); the boundary `LIKE` arm covers passing a shorter suffix that starts at a directory boundary (for example `db/git-history.ts` or `git-history.ts`). Because the boundary is anchored at `/`, a value that does not begin at a segment start — like `b/git-history.ts` — will not match `src/db/git-history.ts`.

Before the value is interpolated into the `LIKE` pattern it runs through `escapeLike`, which escapes the SQL `LIKE` metacharacters `%`, `_`, and `\` and pairs with the `ESCAPE '\\'` clause `src/search/usages.ts:24-26`, `src/db/git-history.ts:277-281`. Without this, a path containing `_` (such as `git_history.ts`) would treat the underscore as a single-character wildcard and silently match unrelated files like `gitXhistory.ts`. The exact-equality arm is bound separately and is not subject to LIKE wildcards at all.

A short suffix is still convenient but can pull in same-named files in other directories — for example `index.ts` matches every indexed `index.ts` across the tree. Prefer the most specific suffix you can give.

This matching style differs from the sibling `search_commits` tool. There, the `path` filter does a plain substring `includes` check against each commit's changed files `src/db/git-history.ts:149`, so a fragment like `db/git` *would* match there. Only `file_history` uses the exact-or-boundary form.

## Newest-first ordering and the limit

Results come back in reverse chronological order because the query ends with `ORDER BY gc.date DESC` `src/db/git-history.ts:289`. The `date` column is the commit's ISO timestamp stored as text, and string comparison of ISO dates sorts correctly, so the newest commit is always first. The `LIMIT ?` clause caps the row count at `top`, which defaults to 20 when the caller omits it `src/tools/git-history-tools.ts:116`. Because the limit is applied after sorting, you always get the *most recent* `top` commits, not an arbitrary slice.

## The optional `since` filter

When `since` is supplied, the query appends `AND gc.date >= ?` before the ordering and pushes the value into the parameter list `src/db/git-history.ts:284-287`. This is a direct string comparison against the stored ISO date, so a value like `2025-01-01` keeps only commits on or after that date. The comparison is inclusive of the boundary date. When `since` is omitted the clause is not added at all, so the full history for the file is eligible (still capped by `top`).

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `path` | string | yes | File path to look up, matched as a full path or a directory-boundary suffix against indexed commit file paths. Most specific is safest; a bare filename may match files of the same name in other directories `src/tools/git-history-tools.ts:115`. |
| `top` | integer ≥ 1 | no (default 20) | Maximum number of commits to return. Applied as the `LIMIT` after newest-first sorting `src/tools/git-history-tools.ts:116`. |
| `since` | string | no | ISO date (e.g. `2025-01-01`). Keeps only commits with `date >= since`. Omit for the file's full history `src/tools/git-history-tools.ts:118`. |
| `directory` | string | no | Project directory to read. Falls back to `RAG_PROJECT_DIR`, then the current working directory `src/tools/git-history-tools.ts:120`. |

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| Commit history text | A single MCP text content item. A header line `## History for "<path>" (<N> commits)` followed by one block per commit, newest first `src/tools/git-history-tools.ts:137-140`. |
| Per-commit block | Three lines: rank + bold short hash + date + `@author` (with a `[merge]` tag for merge commits); the first line of the commit message; and a `Files:` line listing up to five changed paths (with `+K more` if there are more) and `(+insertions -deletions)` totals `src/tools/git-history-tools.ts:21-32`. |
| Empty-result hint | If nothing matched, a single line `No commits found for "<path>". Is git history indexed?` `src/tools/git-history-tools.ts:132`. |

The per-commit block carries no relevance score. That is the visible difference from [search_commits](search-commits.md): `formatCommitRow` omits the score because chronological history has no notion of relevance, whereas `formatCommitResult` (used by `search_commits`) prints a `(0.xx)` score `src/tools/git-history-tools.ts:15`. The date shown in each block is just the date portion of the stored ISO timestamp, taken from before the `T` `src/tools/git-history-tools.ts:23`. The short hash is the first eight characters of the full hash, fixed at index time `src/git/indexer.ts:345`.

## Branches and failure cases

- **Empty result.** If the query returns zero rows the handler short-circuits and returns the "No commits found" hint instead of an empty list `src/tools/git-history-tools.ts:128`. This single branch covers two real situations the tool cannot tell apart: the file genuinely has no commits matching the path/`since` filter, and the project has no indexed git history at all. The hint deliberately asks "Is git history indexed?" to nudge the caller toward [index_files](index-files.md) or the CLI `mimirs history index`.
- **Unindexed history is not pre-checked.** Unlike `search_commits`, this handler does not call `getGitHistoryStatus()` up front to detect an empty index `src/tools/git-history-tools.ts:58`. It runs the query unconditionally and only the empty-result branch reports the problem, so the failure surfaces the same generic hint whether the index is empty or the path simply did not match.
- **No `since` filter.** When `since` is absent the date clause is skipped and the full history (up to `top`) is eligible `src/db/git-history.ts:284`.
- **Over-broad path.** A short or bare-filename `path` can match same-named files in other directories because of suffix matching; the results then mix commits from several files, which is a behavior to be aware of rather than an error `src/db/git-history.ts:278-282`.
- **Mid-token suffix that is not a segment.** A suffix that does not begin at a directory boundary (for example `istory.ts`) will not match `git-history.ts`, because the `LIKE` arm is anchored at `%/` and the exact arm requires the whole path `src/db/git-history.ts:281-282`.
- **Bad directory.** If `directory` resolves to a path that does not exist, `resolveProject` throws `Directory does not exist: <path>` before any query runs `src/tools/index.ts:30-32`.
- **Limit floor.** The schema rejects `top` values below 1, so a caller cannot request zero or negative results `src/tools/git-history-tools.ts:116`.

## Where the data comes from

`file_history` is purely a reader; it depends on two tables being populated by the indexer. `git_commits` holds one row per commit with its hash, message, author, date, and aggregate insertion/deletion counts; `git_commit_files` holds one row per (commit, changed file) pair `src/db/index.ts:444-467`. The join in `getFileHistory` walks `git_commit_files` to find which commits touched a path, then pulls the full commit record from `git_commits`. There is an index `idx_gcf_path` on `git_commit_files(file_path)` so the suffix lookup does not scan every row from scratch `src/db/index.ts:468`.

Two indexer choices directly affect what this tool can find `src/git/indexer.ts:84-92`. The indexer records changed files with `git diff-tree --root`, so a file first introduced in the repository's root (parentless) commit is recorded too — otherwise its earliest history would be missing. And it runs with `-c core.quotepath=false`, so a non-ASCII path such as `café.ts` is stored literally rather than octal-escaped and quoted, which is what lets the exact-equality and boundary-`LIKE` arms match the path a caller actually passes.

Those rows are written when commit history is indexed — see the [history](../cli/history.md) CLI page for how the indexer walks `git log` and calls `insertCommitBatch` to populate both tables `src/db/git-history.ts:21-69`. This tool reads them; it never writes, so it has no state changes of its own.

## Example

Look up the ten most recent commits to a file since the start of 2025:

```json
{
  "path": "src/db/git-history.ts",
  "top": 10,
  "since": "2025-01-01"
}
```

A successful response looks like:

```
## History for "src/db/git-history.ts" (2 commits)

1. **a1b2c3d4** — 2025-03-14 — @Jane Dev
   feat: batch file-history lookups across paths
   Files: src/db/git-history.ts, src/wiki/bundle.ts (+48 -6)

2. **0f9e8d7c** — 2025-01-22 — @Jane Dev [merge]
   refactor: move git history queries into their own module
   Files: src/db/git-history.ts, src/db/index.ts, src/db/types.ts +2 more (+210 -180)
```

The short hashes, dates, authors, and counts above are synthetic placeholders; the line shapes match what `formatCommitRow` emits.

## Key source files

- `src/tools/git-history-tools.ts` — registers the `file_history` MCP tool, validates arguments, calls the query, and formats the response (`formatCommitRow`, lines 111-142).
- `src/db/git-history.ts` — `getFileHistory` builds and runs the exact-or-boundary, date-ordered SQL query and parses rows into `GitCommitRow` (lines 267-297).
- `src/search/usages.ts` — `escapeLike` escapes SQL `LIKE` metacharacters so a path with `_` matches literally (lines 24-26).
- `src/git/indexer.ts` — records changed files with `--root` and `core.quotepath=false`, populating the tables this tool reads (lines 84-92).
- `src/db/index.ts` — defines the `git_commits` / `git_commit_files` schema and the `idx_gcf_path` index, and exposes `getFileHistory` as a `RagDB` method.
- `src/tools/index.ts` — `resolveProject` resolves the directory argument to the right `RagDB`.
