# CLI: session-context

`mimirs session-context` prints a short orientation summary meant to be read once at the start of a working session. Instead of making you run several commands by hand to learn "what was I doing here," it gathers the most useful facts about a project — what is currently uncommitted, the last few commits, how big the search index is, which recent searches found nothing useful, and any notes left on files you are actively editing — and prints them as one block of Markdown.

The whole command is a read-only aggregator. It never re-indexes and never mutates git state. It only runs `git` in read mode and runs a handful of `SELECT` queries against the local index database. If a section has no data — clean working tree, empty index, no search history — that section is simply skipped, and in the extreme case (nothing at all to report) the command prints nothing and exits cleanly.

## When to use it

Run it when you (or an agent) open a project and want a fast picture of its current state before deciding what to do next. It is the CLI counterpart of the orientation a fresh session needs: recent activity plus index health plus any warnings worth knowing. Because it only reads from the subsystems it touches, it is safe to run as often as you like.

## How it works

The dispatcher in `src/cli/index.ts` maps the `session-context` subcommand to `sessionContextCommand`, passing the raw argument list and a `getFlag` helper that looks up a named flag's value (`src/cli/index.ts:157-158`). The handler then resolves the target directory and builds up an array of Markdown sections, one per data source, before joining and printing them at the end (`src/cli/commands/session-context.ts:16-101`).

The interesting part of this command is not the call order — it is the chain of guards. Every section is conditional, so the page below the diagram is mostly about which branch fires when.

```mermaid
flowchart TD
    startNode([mimirs session-context dir]) --> resolveDir[Resolve target directory<br>positional > --dir > .]
    resolveDir --> gitRoot{git rev-parse<br>--show-toplevel ok?}

    gitRoot -- "no (not a repo / no git)" --> openDb
    gitRoot -- "yes" --> statusCheck{git status --short<br>non-empty?}
    statusCheck -- yes --> appendStatus[Append Uncommitted changes]
    statusCheck -- no --> logCheck
    appendStatus --> logCheck{git log --oneline -5<br>non-empty?}
    logCheck -- yes --> appendLog[Append Recent commits]
    logCheck -- no --> openDb
    appendLog --> openDb

    openDb[new RagDB dir] --> filesCheck{getStatus<br>totalFiles > 0?}
    filesCheck -- yes --> appendIndex[Append Index]
    filesCheck -- no --> queriesCheck
    appendIndex --> queriesCheck{getAnalytics 7<br>totalQueries > 0?}
    queriesCheck -- yes --> gapsCheck{any zero-result<br>or low-score?}
    queriesCheck -- no --> annoGate
    gapsCheck -- yes --> appendGaps[Append Search gaps]
    gapsCheck -- no --> annoGate
    appendGaps --> annoGate{git root known<br>and modified files?}

    annoGate -- yes --> loadNotes[getAnnotations per file<br>collect NOTE lines]
    annoGate -- no --> closeDb
    loadNotes --> notesCheck{any notes?}
    notesCheck -- yes --> appendNotes[Append Annotations on modified files]
    notesCheck -- no --> closeDb
    appendNotes --> closeDb

    closeDb[db.close in finally] --> printCheck{sections non-empty?}
    printCheck -- yes --> printOut[Print joined Markdown to stdout]
    printCheck -- no --> doneNode([Exit, print nothing])
    printOut --> doneNode
```

1. **Resolve the target directory.** If the first positional argument after the subcommand exists and does not start with `--`, it is used; otherwise the `--dir` flag is consulted; otherwise the current directory `.` is used. The result is passed through `resolve()` to an absolute path (`src/cli/commands/session-context.ts:17`).
2. **Find the git root.** It asks git for the repository root with `git rev-parse --show-toplevel`. Every git call goes through a small wrapper that spawns the process, captures stdout, and returns the trimmed text only on a zero exit code — otherwise `null` (`src/cli/commands/session-context.ts:5-14`). If no root is found, the two git-dependent blocks (commits/status and per-file notes) are skipped entirely.
3. **Uncommitted changes.** Inside the git branch, `git status --short` runs against the root; when it produces output, that output is appended verbatim under a "Uncommitted changes" heading (`src/cli/commands/session-context.ts:23-26`).
4. **Recent commits.** `git log --oneline -5` runs, and when non-empty, the last five commits are appended under "Recent commits" (`src/cli/commands/session-context.ts:28-31`).
5. **Open the index database.** A `RagDB` is constructed rooted at the resolved directory. This is wrapped in a `try` so that a genuine open-time failure does not crash the command (`src/cli/commands/session-context.ts:36-37`).
6. **Index stats.** `getStatus()` is called; only if at least one file is indexed does the handler append an "Index" line with the file count, chunk count, and last-indexed timestamp (`src/cli/commands/session-context.ts:38-43`).
7. **Search gaps.** `getAnalytics(7)` looks at the last seven days of logged searches. When any searches were recorded, the handler builds a "Search gaps" section from zero-result and low-relevance queries (`src/cli/commands/session-context.ts:45-63`).
8. **Annotations on modified files.** Back inside the git branch, it lists files changed versus `HEAD` (`git diff --name-only HEAD`) plus untracked-but-not-ignored files (`git ls-files --others --exclude-standard`), de-duplicates them into a `Set`, and looks up annotations for each. Any notes found become an "Annotations on modified files" section (`src/cli/commands/session-context.ts:66-91`).
9. **Close the database.** The handle is released in a `finally` block via `db?.close()`, so it closes on every path — success, a thrown query, or a failed open (`src/cli/commands/session-context.ts:94-96`).
10. **Print.** If any sections were collected, they are joined with blank lines and printed to stdout; if the array is empty, nothing is printed (`src/cli/commands/session-context.ts:98-100`).

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `[dir]` | positional string | no | Project directory to inspect. Used only when present and not starting with `--`. Resolved to an absolute path. Defaults to `.` (the current directory). |
| `--dir D` | flag string | no | Alternative way to set the target directory. Consulted only when no usable positional `dir` was given. |

Both inputs feed the same `dir` variable. The positional argument wins when it looks like a real path; otherwise `--dir` is used; otherwise the current directory (`src/cli/commands/session-context.ts:17`). The same directory is handed both to the git calls (as the starting point for `rev-parse`) and to the `RagDB` constructor (as the project root under which it manages `.mimirs/index.db`), so a directory with neither git nor index history simply yields empty sections rather than an error.

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| Session orientation summary | Markdown text on stdout via `cli.log`, a thin wrapper over `console.log` (`src/utils/log.ts:49-53`). Composed of up to five `##` sections — "Uncommitted changes", "Recent commits", "Index", "Search gaps", "Annotations on modified files" — separated by blank lines. No section is printed if its source is empty, and the whole output is empty when nothing is available. |

The command produces no other observable output: it does not write to the working tree, and nothing is logged back into the query log.

### What each section contains

| Section | Source | Contents |
| --- | --- | --- |
| Uncommitted changes | `git status --short` | The short-format working-tree status, printed as-is. |
| Recent commits | `git log --oneline -5` | The five most recent commits, one per line. |
| Index | `getStatus()` | `<N> files, <M> chunks (last indexed: <timestamp>)`. Shows `unknown` when no timestamp is stored. |
| Search gaps | `getAnalytics(7)` | Up to five most frequent zero-result queries (with counts) and up to five lowest-scoring low-relevance queries (with their top score to two decimals). |
| Annotations on modified files | `getAnnotations(path)` per changed/untracked file | One `[NOTE]` line per annotation: the file path (and symbol name when the note is symbol-scoped) followed by the note text. |

## State changes

This command makes no persistent state changes to the index or the working tree. It is purely a reader of git output and `SELECT` query results.

There is, however, a real side effect from opening the database that is worth knowing. The `RagDB` constructor ensures its data directory exists with `mkdirSync(ragDir, { recursive: true })` and then opens (creating if absent) `index.db`, running `initSchema()` to create every table with `CREATE TABLE IF NOT EXISTS` (`src/db/index.ts:106-139`). So pointing `session-context` at a project that has never been indexed does not fail — it materializes an empty `.mimirs/index.db` with the full schema. The visible result is still "no index sections," because the counts come back at zero, but the directory and an empty database file are created as a side effect.

The other transient piece of state is the SQLite connection itself. The handler is responsible for closing the handle and does so in a `finally` block. The optional-chaining `db?.close()` matters here: if the constructor threw before assigning `db`, it is still `null` and `close()` is never called on an undefined value (`src/cli/commands/session-context.ts:94-96`).

## Branches and failure cases

The handler is built almost entirely out of "show this section only if there is something to show" guards, so most of its behavior lives in the branches.

- **Not a git repository.** When `git rev-parse --show-toplevel` returns `null` (non-zero exit, or `git` not on PATH), the entire git portion — uncommitted changes, recent commits, and the annotations-on-modified-files block — is skipped, because all three are nested under `if (gitRoot)` (`src/cli/commands/session-context.ts:22`, `src/cli/commands/session-context.ts:66`). The index and search-gaps sections can still appear.
- **`git` command fails or is absent.** The `runGit` wrapper swallows spawn errors in a `try/catch` and returns `null` on any non-zero exit, so a broken or missing `git` degrades to empty sections rather than a crash (`src/cli/commands/session-context.ts:6-13`).
- **Clean working tree.** `git status --short` produces empty output, so the "Uncommitted changes" section is omitted (`src/cli/commands/session-context.ts:24`).
- **No commit history.** `git log --oneline -5` returns empty in a repository with no commits, so "Recent commits" is omitted (`src/cli/commands/session-context.ts:29`).
- **Empty or absent index.** Because the `RagDB` constructor creates the schema, a project that has never been indexed does not throw — `getStatus()` simply reports zero files, and the `if (dbStatus.totalFiles > 0)` guard omits the "Index" line (`src/cli/commands/session-context.ts:39`). Likewise `getAnalytics(7)` returns `totalQueries: 0` and the search-gaps section is skipped.
- **Database open fails.** The surrounding `try/catch` exists for genuine open-time failures rather than the empty-index case. Two such failures are possible: a read-only or permission-denied data directory, which the constructor turns into a descriptive `EROFS`/`EACCES` error (`src/db/index.ts:110-123`), and an embedding-dimension mismatch against an existing `vec_chunks` table (`src/db/index.ts:160-167`). Either is caught here and the index, search-gaps, and annotation sections are all skipped silently (`src/cli/commands/session-context.ts:92-93`).
- **No search history.** The search-gaps section is gated on `analytics.totalQueries > 0` for the seven-day window; with no logged searches it is skipped (`src/cli/commands/session-context.ts:46`).
- **Searches exist but no gaps.** Even when there are queries, the section is only emitted if there is at least one zero-result query or one low-relevance query to list; a project whose searches all succeeded with good scores shows nothing here (`src/cli/commands/session-context.ts:60-62`).
- **Top-N truncation.** Zero-result and low-relevance lists are each capped at five entries via `.slice(0, 5)`, even though the underlying queries return up to ten rows (`src/cli/commands/session-context.ts:50`, `src/cli/commands/session-context.ts:56`).
- **No modified files.** When neither `git diff --name-only HEAD` nor `git ls-files --others --exclude-standard` returns anything, the modified-files set is empty and the annotation loop is skipped (`src/cli/commands/session-context.ts:78`).
- **Modified files with no notes.** When changed files exist but none carry annotations, the inner loop produces no lines and the "Annotations on modified files" section is omitted (`src/cli/commands/session-context.ts:87`).
- **Nothing to report.** If every section is skipped, `sections` is empty and the final `if (sections.length > 0)` guard means the command prints nothing at all and exits normally (`src/cli/commands/session-context.ts:98`).

## Where each section's data comes from

The git sections are produced directly from `git` output and are not interpreted further. The three index-backed sections each call a method on `RagDB`, which delegates to a focused module:

- **Index stats** come from `getStatus`, which runs three queries: `COUNT(*)` over `files`, `COUNT(*)` over `chunks`, and the newest `indexed_at` from `files`. It returns `{ totalFiles, totalChunks, lastIndexed }`, with `lastIndexed` falling back to `null` when no rows exist (`src/db/files.ts:354-372`). The handler renders `lastIndexed || "unknown"`, so a `null` shows as `unknown`.
- **Search gaps** come from `getAnalytics`, called with `days = 7`. It computes a cutoff timestamp seven days back, then queries the `query_log` table. Zero-result queries are rows with `result_count = 0`, grouped by query text and ordered by descending count. Low-relevance queries are rows whose recorded `top_score` is below `0.3`, ordered by ascending score — the worst matches first (`src/db/analytics.ts:33-44`). The handler shows the count for zero-result queries and the top score (two decimals) for low-relevance ones.
- **Annotations** come from `getAnnotations(path)`, which selects all annotation rows for a given file path ordered by most recently updated. Each row carries an optional `symbolName`; when present, the handler renders the target as `path • symbolName`, otherwise just the path (`src/db/annotations.ts:101-135`, `src/cli/commands/session-context.ts:83`). These are the same notes that surface as `[NOTE]` blocks elsewhere, so the prefix here matches that convention.

## Example

```sh
# Inspect the current directory
mimirs session-context

# Inspect another project explicitly
mimirs session-context ~/repos/other-project
# or
mimirs session-context --dir ~/repos/other-project
```

A representative (synthetic) summary:

```
## Uncommitted changes
 M src/cli/commands/session-context.ts
?? notes.txt

## Recent commits
<sha1> feat: flow based wiki
<sha2> docs: fixed links after new wiki
<sha3> fix: normalize path separators on Windows

## Index
421 files, 3180 chunks (last indexed: 2026-05-31T09:14:00.000Z)

## Search gaps
Zero-result queries (last 7 days):
  3× "how does rate limiting work"
  1× "websocket reconnect"
Low-relevance queries:
  "deploy pipeline" (score: 0.21)

## Annotations on modified files
  [NOTE] src/cli/commands/session-context.ts • runGit: returns null on non-zero exit, callers must guard
```

The exact counts, hashes, timestamps, and note text vary per project; sections you have no data for will not appear.

## Related pages

- [status](status.md) — the dedicated index-stats command; session-context reuses the same `getStatus()` summary as its "Index" line.
- [analytics](analytics.md) — the full search-analytics report; session-context surfaces a trimmed seven-day view of the same `query_log` data.
- [annotations](annotations.md) — listing and managing the per-file notes that session-context echoes for modified files.
- [git-context](../tools/git-context.md) — the MCP-side orientation tool covering the same uncommitted-changes-and-commits ground for agents.

## Key source files

| File | Role |
| --- | --- |
| `src/cli/index.ts` | CLI entrypoint; dispatches `session-context` to the handler and provides `getFlag`. |
| `src/cli/commands/session-context.ts` | The whole command: git wrapper, directory resolution, section assembly, and printing. |
| `src/db/files.ts` | `getStatus` — file/chunk counts and last-indexed timestamp. |
| `src/db/analytics.ts` | `getAnalytics` — zero-result and low-relevance query lookups over `query_log`. |
| `src/db/annotations.ts` | `getAnnotations` — per-file notes used for the modified-files section. |
| `src/db/index.ts` | `RagDB` — opens (and creates) `index.db`, runs `initSchema`, and exposes the thin method wrappers the handler calls. |
| `src/utils/log.ts` | `cli.log` — stdout output channel for the final summary. |
