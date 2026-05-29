# CLI: history

`mimirs history` is a small command group for working with a project's git commit history as searchable data. It has three subcommands: `index` builds the searchable commit store, `search` queries it by meaning and keyword, and `status` reports how much is indexed. Indexing is the prerequisite for the commit-history features exposed elsewhere — the [search_commits](../tools/search-commits.md) and [file_history](../tools/file-history.md) tools both read the same indexed commit data, so they return nothing until `history index` has run.

## How it works

The top-level command dispatches on its first argument to one of the three subcommands, printing a usage block for anything else (`src/cli/commands/history.ts:10-33`).

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Cmd as historyCommand
    participant Indexer as indexGitHistory
    participant DB as RagDB
    participant Embed as embed()
    User->>Cmd: mimirs history <sub> ...
    alt sub == index
        Cmd->>Indexer: indexGitHistory(dir, db, {since, threads, onProgress})
        Indexer->>DB: getLastIndexedCommit / insert commit rows
        Indexer-->>Cmd: {indexed, skipped, total}
        Cmd->>User: "Done: N indexed, M skipped (Ts)"
    else sub == search
        Cmd->>DB: getGitHistoryStatus
        Cmd->>Embed: embed(query)
        Cmd->>DB: searchGitCommits + textSearchGitCommits
        Cmd->>Cmd: merge by hash, 0.7/0.3 hybrid score, sort
        Cmd->>User: ranked commit list
    else sub == status
        Cmd->>DB: getGitHistoryStatus
        Cmd->>User: count + last commit
    else unknown
        Cmd->>User: usage; error+exit 1 if a bad subcommand
    end
```

1. `historyCommand` reads the subcommand and switches to `index`, `search`, or `status` (`src/cli/commands/history.ts:10-21`).
2. For `index`, the target directory and `--since` are read, the database and config are loaded, and `indexGitHistory` is called with the configured thread count and a progress callback (`src/cli/commands/history.ts:36-58`).
3. `index` prints a `Done: N indexed, M skipped (Ts)` summary with elapsed seconds (`src/cli/commands/history.ts:60-61`).
4. For `search`, the query and flags are read; if no commits are indexed yet the command tells the user to run `history index` and stops (`src/cli/commands/history.ts:66-83`).
5. `search` embeds the query, runs a vector search and a text search over commits, merges them, and prints a ranked list (`src/cli/commands/history.ts:85-121`).
6. For `status`, the command reads the index stats and prints the commit count and last-indexed commit, or a "not indexed" hint (`src/cli/commands/history.ts:126-139`).
7. An unknown subcommand prints usage and exits `1`; bare `history` prints usage and exits normally (`src/cli/commands/history.ts:22-33`).

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| subcommand | positional | yes | One of `index`, `search`, `status`. Anything else prints usage (`src/cli/commands/history.ts:10-22`). |
| directory | positional | no | For `index` and `status`, the project directory (2nd positional). Defaults to `.` (`src/cli/commands/history.ts:37`, `src/cli/commands/history.ts:127`). |
| query | positional | yes for `search` | The search query (2nd positional after `search`). Missing or flag-like value is a usage error (`src/cli/commands/history.ts:66-70`). |
| `--since` | flag value | no | For `index`, a git ref to start indexing from. For `search`, a date filter passed to the commit query (`src/cli/commands/history.ts:39`, `src/cli/commands/history.ts:75`). |
| `--top` | flag value | no | For `search`, max results to return. Defaults to `10` (`src/cli/commands/history.ts:73`). |
| `--author` | flag value | no | For `search`, restrict to a commit author (`src/cli/commands/history.ts:74`). |
| `--dir` | flag value | no | For `search`, the project directory (search uses this flag, not a positional). Defaults to `.` (`src/cli/commands/history.ts:72`). |
| `-v` / `--verbose` | flag | no | For `index`, switches to full per-commit progress output (`src/cli/commands/history.ts:38`). |

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| Index summary | `Done: N indexed, M skipped (Ts)` printed after `index` (`src/cli/commands/history.ts:60-61`). |
| Indexed commit rows | Commit records with embeddings written to the database — see State changes. |
| Ranked commit results | For `search`, a header `Results for "<q>" (X of Y indexed):` then per-commit lines with short hash, score, date, author, first message line, and changed files with insert/delete counts (`src/cli/commands/history.ts:112-121`). |
| Empty-search message | `No commits found matching "<q>"` when nothing scores (`src/cli/commands/history.ts:106-107`). |
| Status report | For `status`, `Git history: N commits indexed` plus `Last commit: <hash8> (<date>)`, or a "not indexed" hint (`src/cli/commands/history.ts:132-137`). |

## Subcommands

| Subcommand | Purpose | Key flags |
| --- | --- | --- |
| `index` | Parse `git log` and store commits (with embeddings) into the commit table | `--since REF`, `-v` / `--verbose` |
| `search` | Hybrid semantic + keyword search over indexed commits | `--top N`, `--author A`, `--since S`, `--dir D` |
| `status` | Report indexed commit count and the last indexed commit | (directory positional only) |

## `--since` and incremental indexing

`history index` is incremental by default. When `--since` is given, it indexes only commits in the `<since>..HEAD` range (`src/cli/commands/history.ts:39`, `src/git/indexer.ts:275-277`). When `--since` is omitted, the indexer reads the last commit it already stored and uses that as the start point, so a re-run only picks up new commits since the previous run (`src/git/indexer.ts:241-251`). To avoid re-doing work, after building the commit range it also filters out any commit whose hash is already stored, counting those as skipped (`src/git/indexer.ts:296-298`).

The incremental path is force-push aware. If the previously indexed commit is no longer an ancestor of `HEAD` (history was rewritten), the indexer finds the last shared commit, purges the orphaned ones, and resumes from the fork point; if there is no shared history at all it clears the commit store and rebuilds from scratch (`src/git/indexer.ts:250-265`). When the directory is not a git repository, indexing is skipped and a zero-count result is returned (`src/git/indexer.ts:234-238`).

Progress output depends on `-v`: verbose mode streams every progress message through the standard progress renderer, while the default quiet mode only surfaces summary lines such as those starting with `Scanning`, `Found`, `Indexing`, `No `, `All `, or `Warning` (`src/cli/commands/history.ts:49-57`).

## Hybrid scoring in `search`

Commit search blends two retrieval methods. The query is embedded once, then `searchGitCommits` ranks commits by vector similarity and `textSearchGitCommits` ranks them by keyword match; both honor the `--author` and `--since` filters and the `--top` cap (`src/cli/commands/history.ts:85-89`). The two result sets are merged by commit hash. A commit found by both methods gets a blended score of `0.7 * vectorScore + 0.3 * textScore`, weighting semantic similarity over keyword match; a commit found only by text search is admitted at `0.3 * textScore` (`src/cli/commands/history.ts:91-100`). The merged commits are sorted by score descending and truncated to `--top` (`src/cli/commands/history.ts:102-104`).

Each printed result shows the short hash, the blended score to two decimals, the commit date (date portion only), the author, the first line of the message, and up to three changed files with a `+N more` suffix plus insertion/deletion counts (`src/cli/commands/history.ts:113-120`).

## State changes

### `git_commits` store populated

- **Before:** the commit store holds previously indexed commits, or is empty on a first run.
- **After:** it holds rows for every new commit in the indexed range, each with its embedding.
- `indexGitHistory` runs `git log`, parses the records, filters out already-stored commits, and writes the new ones into the database via the `RagDB` store; the returned `{ indexed, skipped, total }` counts drive the summary line (`src/git/indexer.ts:269-298`, `src/cli/commands/history.ts:46-61`). On a force push it may also delete orphaned commit rows or clear the whole store before re-indexing (`src/git/indexer.ts:257-264`).

## Branches and failure cases

- **Bare `history` (no subcommand):** prints usage and returns with the default exit code (`src/cli/commands/history.ts:22-28`).
- **Unknown subcommand:** prints usage, then an `Unknown subcommand` error, and exits `1` (`src/cli/commands/history.ts:29-32`).
- **`index` on a non-git directory:** the indexer reports it is not a git repo and returns zero counts (`src/git/indexer.ts:234-238`).
- **`index` with no new commits:** the already-indexed filter leaves nothing, so the summary shows everything as skipped (`src/git/indexer.ts:296-302`).
- **`index` force push detected:** orphaned commits are purged from the fork point, or the store is cleared if no shared history exists (`src/git/indexer.ts:250-265`).
- **`search` with missing or flag-like query:** prints the search usage and exits `1` (`src/cli/commands/history.ts:67-70`).
- **`search` with nothing indexed:** prints `No git history indexed. Run: mimirs history index` and returns (`src/cli/commands/history.ts:78-83`).
- **`search` with no matches:** prints `No commits found matching "<q>"` (`src/cli/commands/history.ts:106-109`).
- **`status` with nothing indexed:** prints the "not indexed" hint instead of stats (`src/cli/commands/history.ts:132-133`).

## Example

```bash
# Index this repo's history (incremental on re-run)
mimirs history index

# Re-index only commits after a tag
mimirs history index --since v1.2.0 --verbose

# Search commits, top 5, by one author
mimirs history search "fix windows path separators" --top 5 --author alice

# Check how much is indexed
mimirs history status
```

Illustrative `search` output (values synthetic):

```
Results for "fix windows path separators" (2 of 412 indexed):

  a1b2c3d  0.81  2026-01-14  @alice
    fix: normalize path separators on Windows
    src/db/files.ts, src/utils/path.ts (+12 -4)
```

## Related

- [tools/search-commits](../tools/search-commits.md) — the MCP tool that semantically searches the same indexed commits.
- [tools/file-history](../tools/file-history.md) — the MCP tool that lists a file's commits from the same store.

## Key source files

- `src/cli/commands/history.ts` — the command group: dispatch, the three subcommand handlers, and the hybrid-score merge.
- `src/git/indexer.ts` — `indexGitHistory`, the incremental/force-push-aware commit indexer, and `GitIndexResult`.
- `src/db/index.ts` — `RagDB`, exposing `getGitHistoryStatus`, `searchGitCommits`, `textSearchGitCommits`, `getLastIndexedCommit`, and the commit-writing methods.
- `src/embeddings/embed.ts` — `embed`, used to vectorize the search query.
- `src/cli/progress.ts` — progress renderers used during indexing.
