import { Database } from "bun:sqlite";
import { type GitCommitRow, type GitCommitSearchResult } from "./types";
import { sanitizeFTS } from "../search/usages";

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
        [commitId, new Uint8Array(c.embedding.buffer)]
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
  return results.filter((r) => {
    if (author && !r.authorName.toLowerCase().includes(author.toLowerCase()) &&
        !r.authorEmail.toLowerCase().includes(author.toLowerCase())) return false;
    if (since && r.date < since) return false;
    if (until && r.date > until) return false;
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
    .all(new Uint8Array(queryEmbedding.buffer), fetchLimit);

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

export function getFileHistory(
  db: Database,
  filePath: string,
  topK: number = 20,
  since?: string
): GitCommitRow[] {
  let sql = `SELECT gc.*
     FROM git_commit_files gcf
     JOIN git_commits gc ON gc.id = gcf.commit_id
     WHERE gcf.file_path LIKE ?`;
  const params: (string | number)[] = [`%${filePath}`];

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
