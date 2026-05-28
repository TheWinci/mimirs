# CLI: session-context

`mimirs session-context` prints a short briefing for a new coding session: what is currently uncommitted, the last five commits, how big the local index is, recent search gaps, and any annotations attached to files that are being modified right now. The point is to compress the "what is this repo in the middle of?" question into one stdout dump that an agent or a returning user can read before doing anything else.

It is a composition command — it does not invent new data sources, it just calls the same DB methods and `git` subcommands that the underlying MCP tools (`git_context`, `list_checkpoints`, `get_annotations`, `search_analytics`) expose individually.

## Flow

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant CLI as sessionContextCommand
    participant Git as git CLI
    participant DB as RagDB
    User->>CLI: mimirs session-context [dir|--dir]
    CLI->>Git: rev-parse --show-toplevel
    Git-->>CLI: repo root (or null)
    CLI->>Git: status --short
    CLI->>Git: log --oneline -5
    CLI->>DB: new RagDB(dir); getStatus()
    CLI->>DB: getAnalytics(7)
    CLI->>Git: diff --name-only HEAD
    CLI->>Git: ls-files --others --exclude-standard
    CLI->>DB: getAnnotations(path) per modified file
    DB-->>CLI: annotation rows
    CLI-->>User: joined sections (or nothing)
    CLI->>DB: db.close()
```

1. The command resolves the project directory from the first positional argument, the `--dir` flag, or the current directory (`src/cli/commands/session-context.ts:17`). Sections are built up in an array and only printed if at least one section has content.
2. `git rev-parse --show-toplevel` checks whether the directory is in a repo at all. If it is not, the entire git block (status + log + modified-file annotations) is skipped.
3. `git status --short` lists staged/unstaged/untracked changes; emitted under `## Uncommitted changes` only if the output is non-empty.
4. `git log --oneline -5` gives the last five commits as `## Recent commits`.
5. A `RagDB` is opened. If `getStatus().totalFiles > 0` an `## Index` line with file count, chunk count, and last-indexed timestamp is added. When the project has no index yet the section is suppressed (it would just be noise).
6. `getAnalytics(7)` returns query stats over the last 7 days — a shorter window than `mimirs analytics` defaults to, because session-context is meant to highlight *recent* gaps. Only zero-result and low-score lists are kept, capped at 5 each, joined under `## Search gaps`.
7. If a repo root was found, `git diff --name-only HEAD` and `git ls-files --others --exclude-standard` are unioned into one set of files the user is currently touching (modified + new-untracked).
8. For each modified file, `db.getAnnotations(relPath)` returns persistent notes left by previous sessions. Annotations with a `symbolName` are rendered as `path • symbol`, otherwise just the path. Each note becomes a `[NOTE]` line under `## Annotations on modified files`.
9. Sections are joined with blank lines and printed. If nothing accumulated (no repo, no index, no analytics, no annotations), nothing is printed.

## Inputs

| Input | Where it comes from | Effect |
|---|---|---|
| `directory` (positional) | First arg if it does not start with `--` | Project directory to look at. |
| `--dir D` | Long flag form of the same | Used when no positional is given. |

The command does not write anywhere — there are no `--out`-style flags. Both `git` and `RagDB` errors are swallowed: `runGit` returns `null` on non-zero exit, and the DB block is wrapped in `try { ... } catch { /* No RAG index — skip DB sections */ }` (`src/cli/commands/session-context.ts:92-96`).

## Outputs

A single text block on stdout. Each section header is a markdown `## …`. The sections are emitted in this order, each one conditional on having content:

1. `## Uncommitted changes` — `git status --short`.
2. `## Recent commits` — last 5 commits, oneline.
3. `## Index` — total files, total chunks, last indexed timestamp (or `"unknown"` when never indexed).
4. `## Search gaps` — top 5 zero-result queries and top 5 low-relevance queries over the last 7 days.
5. `## Annotations on modified files` — `[NOTE]` lines for every annotation row attached to a path that appears in `git diff --name-only HEAD` or the untracked list.

The output is *not* a checkpoint summary. Past checkpoints are not included here — for those use `list_checkpoints` or `search_checkpoints`. The page-packet item "recent checkpoints" describes the conceptual goal of the briefing, but the current implementation focuses on git state, index health, and annotations.

## Branches and failure cases

- Not a git repo: `gitRoot` is `null`, so all three git-derived sections are skipped. The DB block still runs (no index → also skipped, gracefully).
- No index: `new RagDB(dir)` may throw if the DB file is missing or corrupt. The whole DB block is wrapped in a bare `try/catch`. The error is swallowed silently; only git output (if any) is printed.
- Empty windows: `analytics.totalQueries === 0` skips the `## Search gaps` section entirely. If zero-result and low-score buckets are both empty but there were other queries, the section is still omitted because the inner `lines` array stays empty.
- No modified files: the annotations loop never runs; nothing is added.
- All sections empty: nothing is printed at all — there is no fallback "session-context found nothing" message. Scripting on top of this command should not assume a minimum amount of output.

## Example

```sh
mimirs session-context
```

Illustrative output:

```
## Uncommitted changes
 M src/server/index.ts
?? scripts/new-thing.ts

## Recent commits
<sha> feat: validate links and files for flows
<sha> feat: wiki state changes
<sha> fix: wiki no strict signals
<sha> fix: no bundled pages
<sha> feat: flow based wiki

## Index
214 files, 4123 chunks (last indexed: 2026-05-27T09:31:14Z)

## Search gaps
Zero-result queries (last 7 days):
  2× "rate limiter config"
Low-relevance queries:
  "embedding model swap" (score: 0.18)

## Annotations on modified files
  [NOTE] src/server/index.ts • startServer: transport must connect before slow startup work or the client times out
```

## Composition with MCP tools

This command is intentionally a shortcut for what an agent would otherwise stitch together by calling several MCP tools at session start:

- `git_context` — produces uncommitted changes and recent commits.
- `list_checkpoints` — the page packet lists this as a part of the briefing, but the current CLI does not call into checkpoint storage. If you need recent checkpoints, call that tool separately.
- `get_annotations` — what `db.getAnnotations(relPath)` exposes; here it is filtered to only the files the user is currently editing instead of the whole project.
- `search_analytics` — the underlying `getAnalytics(days)` is the same DB method.

A new agent that wants the full briefing can run `mimirs session-context` once and skip the four tool calls.

## Related flows

- [tools/git-context](../tools/git-context.md) — same git output, MCP tool form.
- [tools/list-checkpoints](../tools/list-checkpoints.md) — checkpoint listing (not called by this command yet; complementary).
- [tools/get-annotations](../tools/get-annotations.md) — the annotation source.
- [cli/analytics](analytics.md) — the longer-window version of the search-gaps section.

## Key source files

- `src/cli/commands/session-context.ts` — section assembly, git wrappers, annotation lookup.
- `src/db/index.ts` — `RagDB.getStatus`, `getAnalytics`, `getAnnotations`.
