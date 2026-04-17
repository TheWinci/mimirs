# git-history

The persistence layer for commit-history indexing. Writes commits plus their per-file stats into `git_commits` / `git_commit_files` / `vec_git_commits` / `fts_git_commits` and runs the semantic + BM25 queries that power `search_commits` and `mimirs history search`. The file is idempotent by design — `INSERT OR IGNORE` on the unique `hash` column means re-running `mimirs history index` is free.

**Source:** `src/db/git-history.ts`

## Key exports

| Export | Shape | Purpose |
|---|---|---|
| `GitCommitInsert` (interface) | write-side shape — adds `embedding: Float32Array` and per-file `{ path, insertions, deletions }` to the readable `GitCommitRow` fields | Input to `insertCommitBatch` |
| `insertCommitBatch(db, commits)` | `→ void` | Transactional batch insert: `git_commits` with `INSERT OR IGNORE` on `hash`, `vec_git_commits` embedding, plus `git_commit_files` rows for every touched file — all skipped cleanly when the commit was already indexed |
| `getLastIndexedCommit(db)` | `→ hash \| null` | Returns the most recent indexed commit's hash, anchor for the next `git log <hash>..HEAD` range |
| `hasCommit(db, hash)` | `→ boolean` | Fast-path dedupe; consulted per-commit while streaming `git log` output |
| `getAllCommitHashes(db)` | `→ string[]` | Every indexed hash; used by `purgeOrphanedCommits` to diff against `git rev-list` |
| `purgeOrphanedCommits(db, reachableHashes)` | `→ count` | Deletes every row whose hash is not in the reachable set — cleans up after force-push / history rewrites |
| `clearGitHistory(db)` | `→ void` | Nukes `git_commits` / `git_commit_files` / `vec_git_commits` / `fts_git_commits`. Recovery path for dim changes |
| `getGitHistoryStatus(db)` | `→ { totalCommits, firstCommit, lastCommit }` | Surface for `mimirs history status` and the `index_status` tool |
| `searchGitCommits(db, queryEmbedding, topK, filters?)` | `→ GitCommitSearchResult[]` | Vector search against `vec_git_commits` with optional `author` / `since` / `until` / `path` filters applied post-rank |
| `textSearchGitCommits(db, query, topK, filters?)` | `→ GitCommitSearchResult[]` | FTS5 `MATCH` against `fts_git_commits`; uses `sanitizeFTS` from `search/usages` to quote tokens |
| `getFileHistory(db, path, topK?)` | `→ GitCommitRow[]` | Joins `git_commit_files` back to `git_commits` to return commits that touched a path, ordered by date |

## Usage examples

Writing history — the indexer batches commits with embeddings already attached:

```ts
// src/git/indexer.ts
const lastHash = getLastIndexedCommit(db);
const commits = await readCommitsSince(projectDir, lastHash);
const embeddings = await embedBatch(commits.map(c => c.message + "\n" + c.diffSummary));
insertCommitBatch(db, commits.map((c, i) => ({ ...c, embedding: embeddings[i] })));
```

Reading history — the MCP `search_commits` tool and `file_history` tool:

```ts
// src/tools/git-history-tools.ts
const queryEmbedding = await embed(query);
const semantic = db.searchGitCommits(queryEmbedding, topK, { author, since, until, path });

// src/tools/git-tools.ts — file_history handler
const commits = db.getFileHistory(path, topK ?? 20);
```

Cleanup after history rewrites:

```ts
// src/git/indexer.ts — called when detecting a force-push
const reachable = new Set(await listReachableHashes(projectDir));
const removed = purgeOrphanedCommits(db, reachable);
```

## Dependencies

| Direction | Target | Notes |
|---|---|---|
| Imports | `bun:sqlite` | `Database` parameter from the facade |
| Imports | `./types.GitCommitRow`, `GitCommitSearchResult` | Row shapes |
| Imports | `../search/usages.sanitizeFTS` | FTS5 token quoting — prevents `+ - * AND OR NOT NEAR ( )` in commit messages from being parsed as operators |

## Internals

- **`INSERT OR IGNORE` then `changes()` probe.** The insert is idempotent on `hash`. A zero `changes()` means the row existed; the code bails before writing `vec_git_commits` or `git_commit_files` for that commit. This is what makes `mimirs history index` safe to re-run without duplication.
- **Per-file stats are normalised.** `git_commit_files(commit_id, file_path, insertions, deletions)` lets `getFileHistory` query by path with a single join, avoiding the per-row JSON parse that `git_commits.files_changed` would need.
- **`vec_git_commits.embedding` is `FLOAT[getEmbeddingDim()]`.** Same dim as `vec_chunks`, sized at schema init. Changing the embedding model invalidates these rows — `clearGitHistory` followed by a re-index is the recovery.
- **FTS sync is trigger-based.** Three triggers on `git_commits` forward inserts/updates/deletes into `fts_git_commits`. No code path writes to the FTS table directly.
- **`files_changed` stored as JSON.** Denormalised for cheap reads when the caller just wants "what files did this commit touch?"; `git_commit_files` is the normalised side used for path-based queries.
- **`purgeOrphanedCommits` exists for force-push recovery.** Without it, rewritten history would leave orphan rows indexed forever. Diffing against `git rev-list --all` is the canonical source of reachable hashes.

## See also

- [db](index.md)
- [types](types.md)
- [files](files.md)
- [conversation](conversation.md)
- [graph](graph.md)
- [Architecture](../../architecture.md)
- [Data Flows](../../data-flows.md)
