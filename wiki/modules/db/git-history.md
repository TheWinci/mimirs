# git-history

The persistence layer for commit-history indexing. Writes commits plus their per-file stats into `git_commits` / `git_commit_files` / `vec_git_commits` / `fts_git_commits`, and runs the semantic + BM25 queries that back `search_commits` and `mimirs history search`. The file is idempotent by design — `INSERT OR IGNORE` on the unique `hash` column means re-running `mimirs history index` is free.

**Source:** `src/db/git-history.ts`

## Public API

```ts
interface GitCommitInsert {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  filesChanged: { path: string; insertions: number; deletions: number }[];
  insertions: number;
  deletions: number;
  isMerge: boolean;
  refs: string[];
  diffSummary: string | null;
  embedding: Float32Array;
}

function insertCommitBatch(db: Database, commits: GitCommitInsert[]): void;

function getLastIndexedCommit(db: Database): string | null;

function hasCommit(db: Database, hash: string): boolean;

function getAllCommitHashes(db: Database): string[];

function purgeOrphanedCommits(
  db: Database,
  reachableHashes: Set<string>
): number;

function clearGitHistory(db: Database): void;

function getGitHistoryStatus(db: Database): {
  totalCommits: number;
  lastCommitDate: string | null;
  lastCommitHash: string | null;
};

function searchGitCommits(
  db: Database,
  queryEmbedding: Float32Array,
  topK?: number,
  author?: string,
  since?: string,
  until?: string,
  path?: string
): GitCommitSearchResult[];

function textSearchGitCommits(
  db: Database,
  query: string,
  topK?: number,
  author?: string,
  since?: string,
  until?: string,
  path?: string
): GitCommitSearchResult[];

function getFileHistory(
  db: Database,
  filePath: string,
  topK?: number,
  since?: string
): GitCommitRow[];
```

## Row shapes

Four tables are written by this file:

- **`git_commits`** — one row per indexed commit, unique on `hash`. Stores the readable `GitCommitRow` fields plus `indexed_at`. `files_changed` is denormalised as a JSON array of paths for cheap "what did this commit touch" reads; `refs` is a JSON array of branch/tag names.
- **`git_commit_files(commit_id, file_path, insertions, deletions)`** — the normalised per-file stats. One row per touched path; `INSERT OR IGNORE` skips duplicates within a commit. This is what `getFileHistory` joins against when querying by path.
- **`vec_git_commits(commit_id, embedding)`** — vec0 table, `embedding FLOAT[getEmbeddingDim()]`. Shares dimension with `vec_chunks`.
- **`fts_git_commits`** — FTS5 mirror of `git_commits.message` + `diff_summary`. Kept in sync by triggers on the `git_commits` table; no code path writes to FTS directly.

## Usage

Writing history — the indexer batches commits with embeddings already attached:

```ts
// src/git/indexer.ts
const lastHash = getLastIndexedCommit(db);
const commits = await readCommitsSince(projectDir, lastHash);
const embeddings = await embedBatch(
  commits.map((c) => c.message + "\n" + c.diffSummary)
);
insertCommitBatch(
  db,
  commits.map((c, i) => ({ ...c, embedding: embeddings[i] }))
);
```

Reading history — the MCP `search_commits` tool passes filter args positionally:

```ts
// src/tools/git-history-tools.ts
const queryEmbedding = await embed(query);
const semantic = db.searchGitCommits(
  queryEmbedding,
  topK,
  author,  // optional
  since,   // optional ISO date
  until,   // optional ISO date
  path     // optional substring filter on filesChanged
);

// src/tools/git-tools.ts — file_history handler
const commits = db.getFileHistory(path, topK ?? 20);
```

Cleanup after history rewrites:

```ts
// src/git/indexer.ts — called when detecting a force-push or rebase
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

- **`INSERT OR IGNORE` then `changes()` probe.** The insert is idempotent on `hash`. A zero `changes()` means the row existed; the code `continue`s before writing `vec_git_commits` or `git_commit_files` for that commit. This is what makes `mimirs history index` safe to re-run without duplication.
- **`getFileHistory` matches with `LIKE '%path'`.** Suffix match means callers can pass either an absolute path or a relative one; the `since` filter is an ISO date applied via `AND gc.date >= ?`.
- **Filter args are positional, not an object.** `searchGitCommits` and `textSearchGitCommits` accept `(author, since, until, path)` after `topK`. Filters are applied post-rank in `applyFilters`, which over-fetches `topK * 5` rows when any filter is set (vs `topK * 2` unfiltered) so top-K survives filtering.
- **Per-file stats are normalised.** `git_commit_files(commit_id, file_path, insertions, deletions)` lets `getFileHistory` query by path with a single join, avoiding a per-row JSON parse on `git_commits.files_changed`.
- **`files_changed` stored as JSON.** Denormalised for cheap reads when the caller just wants "what files did this commit touch?"; `git_commit_files` is the normalised side used for path-based queries.
- **`purgeOrphanedCommits` rebuilds FTS.** Deletes are per-row against `git_commit_files`, `vec_git_commits`, and `git_commits`, then a single `INSERT INTO fts_git_commits(fts_git_commits) VALUES ('rebuild')` resyncs the virtual table. `clearGitHistory` does the same rebuild after bulk deletes.
- **`vec_git_commits.embedding` is `FLOAT[getEmbeddingDim()]`.** Same dim as `vec_chunks`, sized at schema init. Changing the embedding model invalidates these rows — `clearGitHistory` followed by a re-index is the recovery.

## See also

- [db](index.md)
- [types](types.md)
- [files](files.md)
- [conversation](conversation.md)
- [graph](graph.md)
- [Architecture](../../architecture.md)
- [Data Flows](../../data-flows.md)
