import { embeddingBytes } from "../utils/vec";
import { Database } from "bun:sqlite";
import { type GitCommitRow, type GitCommitSearchResult } from "./types";
import { escapeLike, sanitizeFTS } from "../search/usages";

export interface GitCommitInsert {
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

export function insertCommitBatch(db: Database, commits: GitCommitInsert[]) {
  const tx = db.transaction(() => {
    for (const c of commits) {
      db.run(
        `INSERT OR IGNORE INTO git_commits
         (hash, short_hash, message, author_name, author_email, date,
          files_changed, insertions, deletions, is_merge, refs, diff_summary, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.hash,
          c.shortHash,
          c.message,
          c.authorName,
          c.authorEmail,
          c.date,
          JSON.stringify(c.filesChanged.map((f) => f.path)),
          c.insertions,
          c.deletions,
          c.isMerge ? 1 : 0,
          JSON.stringify(c.refs),
          c.diffSummary,
          new Date().toISOString(),
        ]
      );

      const inserted = db.query<{ c: number }, []>("SELECT changes() as c").get()!.c;
      if (inserted === 0) continue;

      const commitId = Number(
        db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
      );

      // Insert vector embedding
      db.run(
        "INSERT INTO vec_git_commits (commit_id, embedding) VALUES (?, ?)",
        [commitId, embeddingBytes(c.embedding)]
      );

      // Insert per-file stats
      for (const f of c.filesChanged) {
        db.run(
          "INSERT OR IGNORE INTO git_commit_files (commit_id, file_path, insertions, deletions) VALUES (?, ?, ?, ?)",
          [commitId, f.path, f.insertions, f.deletions]
        );
      }
    }
  });
  tx();
}

export function getLastIndexedCommit(db: Database): string | null {
  const row = db
    .query<{ hash: string }, []>(
      "SELECT hash FROM git_commits ORDER BY date DESC LIMIT 1"
    )
    .get();
  return row?.hash ?? null;
}

export function hasCommit(db: Database, hash: string): boolean {
  const row = db
    .query<{ id: number }, [string]>(
      "SELECT id FROM git_commits WHERE hash = ?"
    )
    .get(hash);
  return row != null;
}

function parseRow(row: {
  id: number;
  hash: string;
  short_hash: string;
  message: string;
  author_name: string;
  author_email: string;
  date: string;
  files_changed: string;
  insertions: number;
  deletions: number;
  is_merge: number;
  refs: string;
  diff_summary: string | null;
}): GitCommitRow {
  return {
    id: row.id,
    hash: row.hash,
    shortHash: row.short_hash,
    message: row.message,
    authorName: row.author_name,
    authorEmail: row.author_email,
    date: row.date,
    filesChanged: JSON.parse(row.files_changed || "[]"),
    insertions: row.insertions,
    deletions: row.deletions,
    isMerge: row.is_merge === 1,
    refs: JSON.parse(row.refs || "[]"),
    diffSummary: row.diff_summary,
  };
}

type RawRow = {
  id: number;
  hash: string;
  short_hash: string;
  message: string;
  author_name: string;
  author_email: string;
  date: string;
  files_changed: string;
  insertions: number;
  deletions: number;
  is_merge: number;
  refs: string;
  diff_summary: string | null;
};

function applyFilters(
  results: GitCommitSearchResult[],
  author?: string,
  since?: string,
  until?: string,
  path?: string
): GitCommitSearchResult[] {
  // Dates compare lexically against full ISO timestamps. Truncate the stored
  // date to the filter's granularity so a date-only bound is inclusive of that
  // whole day — `until: "2025-01-31"` must keep commits made ON the 31st
  // ("2025-01-31T10:00:00Z" > "2025-01-31" would otherwise drop them all).
  // Normalize a "YYYY-MM-DD HH:MM" filter's space to "T" so positions align.
  const sinceN = since?.replace(" ", "T");
  const untilN = until?.replace(" ", "T");
  return results.filter((r) => {
    if (author && !r.authorName.toLowerCase().includes(author.toLowerCase()) &&
        !r.authorEmail.toLowerCase().includes(author.toLowerCase())) return false;
    if (sinceN && r.date.slice(0, sinceN.length) < sinceN) return false;
    if (untilN && r.date.slice(0, untilN.length) > untilN) return false;
    if (path && !r.filesChanged.some((f) => f.includes(path))) return false;
    return true;
  });
}

export function searchGitCommits(
  db: Database,
  queryEmbedding: Float32Array,
  topK: number = 10,
  author?: string,
  since?: string,
  until?: string,
  path?: string
): GitCommitSearchResult[] {
  const hasFilters = !!(author || since || until || path);
  const fetchLimit = hasFilters ? topK * 5 : topK * 2;

  const rows = db
    .query<
      RawRow & { commit_id: number; distance: number },
      [Uint8Array, number]
    >(
      `SELECT v.commit_id, v.distance, gc.*
       FROM (SELECT commit_id, distance FROM vec_git_commits WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
       JOIN git_commits gc ON gc.id = v.commit_id`
    )
    .all(embeddingBytes(queryEmbedding), fetchLimit);

  let results: GitCommitSearchResult[] = rows.map((row) => ({
    ...parseRow(row),
    score: 1 / (1 + row.distance),
  }));

  if (hasFilters) {
    results = applyFilters(results, author, since, until, path);
  }

  return results.slice(0, topK);
}

export function textSearchGitCommits(
  db: Database,
  query: string,
  topK: number = 10,
  author?: string,
  since?: string,
  until?: string,
  path?: string
): GitCommitSearchResult[] {
  const hasFilters = !!(author || since || until || path);
  const fetchLimit = hasFilters ? topK * 5 : topK * 2;

  const rows = db
    .query<
      RawRow & { rank: number },
      [string, number]
    >(
      `SELECT gc.*, fts.rank
       FROM fts_git_commits fts
       JOIN git_commits gc ON gc.id = fts.rowid
       WHERE fts_git_commits MATCH ?
       ORDER BY fts.rank
       LIMIT ?`
    )
    .all(sanitizeFTS(query), fetchLimit);

  let results: GitCommitSearchResult[] = rows.map((row) => ({
    ...parseRow(row),
    score: 1 / (1 + Math.abs(row.rank)),
  }));

  if (hasFilters) {
    results = applyFilters(results, author, since, until, path);
  }

  return results.slice(0, topK);
}

/**
 * Batch variant of {@link getFileHistory}: fetch the top-K commits per
 * file across many paths in a single SQL pass + JS group. Avoids N
 * round-trips when the wiki bundle builder needs history for every member
 * file in a community. Uses exact-match on `git_commit_files.file_path`,
 * which assumes the indexer stores project-relative paths consistently
 * with the wiki pipeline's path style. Returns one entry per requested
 * path (empty array if no commits matched).
 */
export function getFileHistoryForPaths(
  db: Database,
  filePaths: string[],
  topK: number = 20,
): Map<string, GitCommitRow[]> {
  const out = new Map<string, GitCommitRow[]>();
  for (const p of filePaths) out.set(p, []);
  if (filePaths.length === 0) return out;
  const BATCH = 499;
  for (let i = 0; i < filePaths.length; i += BATCH) {
    const batch = filePaths.slice(i, i + BATCH);
    const ph = batch.map(() => "?").join(",");
    const rows = db
      .query<RawRow & { matched_path: string }, string[]>(
        `SELECT gc.*, gcf.file_path AS matched_path
         FROM git_commit_files gcf
         JOIN git_commits gc ON gc.id = gcf.commit_id
         WHERE gcf.file_path IN (${ph})
         ORDER BY gc.date DESC`,
      )
      .all(...batch);
    for (const r of rows) {
      const path = r.matched_path;
      const arr = out.get(path);
      if (!arr || arr.length >= topK) continue;
      arr.push(parseRow(r));
    }
  }
  return out;
}

export function getFileHistory(
  db: Database,
  filePath: string,
  topK: number = 20,
  since?: string
): GitCommitRow[] {
  // Match the exact repo-relative path or any path ending at a "/" boundary,
  // so getFileHistory("db.ts") matches "src/db.ts" but never "src/mydb.ts".
  // Escape LIKE metacharacters (%, _) so a path like "foo_bar.ts" matches
  // literally rather than treating "_" as a wildcard.
  const escaped = escapeLike(filePath);
  let sql = `SELECT gc.*
     FROM git_commit_files gcf
     JOIN git_commits gc ON gc.id = gcf.commit_id
     WHERE (gcf.file_path = ? OR gcf.file_path LIKE ? ESCAPE '\\')`;
  const params: (string | number)[] = [filePath, `%/${escaped}`];

  if (since) {
    sql += " AND gc.date >= ?";
    params.push(since);
  }

  sql += " ORDER BY gc.date DESC LIMIT ?";
  params.push(topK);

  const rows = db
    .query<RawRow, (string | number)[]>(sql)
    .all(...params);

  return rows.map(parseRow);
}

export interface CoChangeResult {
  filePath: string;
  together: number; // commits where this file changed alongside the target
  fileCommits: number; // total commits (in scope) touching this file
  targetCommits: number; // total commits (in scope) touching the target file
  jaccard: number; // together / (target ∪ file) — penalizes hub files
  confidence: number; // together / min(target, file) — directional coupling
}

/**
 * Files that historically change in the same commit as `filePath` — "logical
 * coupling" the static import graph cannot see (doc↔code, test↔impl, synced
 * mirrors, sibling files with no import edge).
 *
 * Scope guards keep the signal clean: merge commits are excluded (they touch
 * everything), and commits touching more than `maxCommitFiles` distinct files
 * are dropped as bulk/sweeping changes that couple unrelated files by accident.
 * Ranked by Jaccard so ubiquitous files (package.json, lockfiles) sink even
 * though they co-occur with everything. Target match is exact-or-suffix, the
 * same path semantics as {@link getFileHistory}.
 */
export function getCoChangedFiles(
  db: Database,
  filePath: string,
  opts?: { topK?: number; minTogether?: number; maxCommitFiles?: number },
): CoChangeResult[] {
  const topK = opts?.topK ?? 15;
  const minTogether = opts?.minTogether ?? 2;
  const maxCommitFiles = opts?.maxCommitFiles ?? 25;
  const like = `%/${escapeLike(filePath)}`;

  const rows = db
    .query<
      {
        file_path: string;
        together: number;
        file_commits: number;
        target_commits: number;
        jaccard: number;
        confidence: number;
      },
      { $max: number; $path: string; $like: string; $min: number; $top: number }
    >(
      `WITH good AS (
         SELECT gcf.commit_id AS cid, gcf.file_path AS path
         FROM git_commit_files gcf
         JOIN git_commits gc ON gc.id = gcf.commit_id AND gc.is_merge = 0
         WHERE gcf.commit_id IN (
           SELECT commit_id FROM git_commit_files
           GROUP BY commit_id HAVING COUNT(*) BETWEEN 2 AND $max
         )
       ),
       tcommits AS (
         SELECT DISTINCT cid FROM good
         WHERE path = $path OR path LIKE $like ESCAPE '\\'
       ),
       tn AS (SELECT COUNT(*) AS n FROM tcommits),
       counts AS (SELECT path, COUNT(DISTINCT cid) AS n FROM good GROUP BY path),
       co AS (
         SELECT g.path, COUNT(DISTINCT g.cid) AS together
         FROM good g
         WHERE g.cid IN (SELECT cid FROM tcommits)
           AND NOT (g.path = $path OR g.path LIKE $like ESCAPE '\\')
         GROUP BY g.path
       )
       SELECT co.path AS file_path,
              co.together AS together,
              counts.n AS file_commits,
              tn.n AS target_commits,
              (co.together * 1.0) / (tn.n + counts.n - co.together) AS jaccard,
              (co.together * 1.0) / MIN(tn.n, counts.n) AS confidence
       FROM co
       JOIN counts ON counts.path = co.path
       CROSS JOIN tn
       WHERE co.together >= $min
       ORDER BY jaccard DESC, together DESC
       LIMIT $top`,
    )
    .all({ $max: maxCommitFiles, $path: filePath, $like: like, $min: minTogether, $top: topK });

  return rows.map((r) => ({
    filePath: r.file_path,
    together: r.together,
    fileCommits: r.file_commits,
    targetCommits: r.target_commits,
    jaccard: r.jaccard,
    confidence: r.confidence,
  }));
}

/**
 * Get all indexed commit hashes ordered oldest to newest.
 */
export function getAllCommitHashes(db: Database): string[] {
  return db
    .query<{ hash: string }, []>("SELECT hash FROM git_commits ORDER BY date ASC")
    .all()
    .map((r) => r.hash);
}

/**
 * Purge indexed commits that are no longer reachable in git.
 * Keeps shared history intact, only removes orphaned commits.
 */
export function purgeOrphanedCommits(db: Database, reachableHashes: Set<string>): number {
  const allIndexed = db
    .query<{ id: number; hash: string }, []>("SELECT id, hash FROM git_commits")
    .all();

  const orphaned = allIndexed.filter((r) => !reachableHashes.has(r.hash));
  if (orphaned.length === 0) return 0;

  const tx = db.transaction(() => {
    for (const { id } of orphaned) {
      db.run("DELETE FROM git_commit_files WHERE commit_id = ?", [id]);
      db.run("DELETE FROM vec_git_commits WHERE commit_id = ?", [id]);
      db.run("DELETE FROM git_commits WHERE id = ?", [id]);
    }
    db.run("INSERT INTO fts_git_commits(fts_git_commits) VALUES ('rebuild')");
  });
  tx();

  return orphaned.length;
}

/**
 * Clear all git history from the index.
 */
export function clearGitHistory(db: Database): void {
  const tx = db.transaction(() => {
    db.run("DELETE FROM git_commit_files");
    db.run("DELETE FROM vec_git_commits");
    db.run("DELETE FROM git_commits");
    db.run("INSERT INTO fts_git_commits(fts_git_commits) VALUES ('rebuild')");
  });
  tx();
}

export function getGitHistoryStatus(db: Database): {
  totalCommits: number;
  lastCommitDate: string | null;
  lastCommitHash: string | null;
} {
  const row = db
    .query<{ count: number; last_date: string | null; last_hash: string | null }, []>(
      `SELECT COUNT(*) as count,
              MAX(date) as last_date,
              (SELECT hash FROM git_commits ORDER BY date DESC LIMIT 1) as last_hash
       FROM git_commits`
    )
    .get()!;

  return {
    totalCommits: row.count,
    lastCommitDate: row.last_date,
    lastCommitHash: row.last_hash,
  };
}
