import { type RagDB } from "../db";
import { type GitCommitInsert } from "../db/git-history";
import { embedBatchMerged } from "../embeddings/embed";
import { log } from "../utils/log";
import { runGit, findGitRoot } from "./exec";

const FIELD_SEP = "\x1f"; // ASCII unit separator — safe delimiter for git format
const RECORD_SEP = "\x1e"; // ASCII record separator — delimits commits

interface RawCommit {
  hash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  parentCount: number;
  refs: string;
}

interface FileChange {
  path: string;
  insertions: number;
  deletions: number;
}

/**
 * Parse git log output into structured commits.
 * Uses ASCII delimiters to avoid issues with commit messages containing special chars.
 */
function parseGitLog(output: string): RawCommit[] {
  if (!output) return [];

  return output
    .split(RECORD_SEP)
    .filter((s) => s.trim())
    .map((entry) => {
      const fields = entry.trim().split(FIELD_SEP);
      if (fields.length < 7) return null;

      const [hash, authorName, authorEmail, date, parents, refs, ...messageParts] = fields;
      // A commit message can itself contain the record separator; the split
      // then yields a fragment whose first field isn't a hash. Drop those
      // instead of parsing them as bogus commits.
      if (!COMMIT_HASH.test(hash)) return null;
      const message = messageParts.join(FIELD_SEP).trim();
      return {
        hash,
        message,
        authorName,
        authorEmail,
        date,
        // %P lists parent hashes space-separated; merges have 2+.
        parentCount: parents.trim() ? parents.trim().split(/\s+/).length : 0,
        refs: refs || "",
      };
    })
    .filter((c): c is RawCommit => c !== null);
}

// These functions pass commit hashes as git *revision* arguments. `--` only
// guards path args (and would make git read the hash as a pathspec), so it can't
// protect a revision. Instead assert each value is hash-shaped before spawning:
// a future caller that routes a branch name or path here fails closed rather than
// smuggling a leading-dash git option.
const COMMIT_HASH = /^[0-9a-f]{4,64}$/i;
function assertCommitHashes(hashes: string[]): void {
  for (const h of hashes) {
    if (!COMMIT_HASH.test(h)) {
      throw new Error(`Refusing git call: non-hash revision argument ${JSON.stringify(h)}`);
    }
  }
}

function parseNumstatLines(lines: string[]): FileChange[] {
  return lines
    .filter((line) => line.includes("\t"))
    .map((line) => {
      const [ins, del, path] = line.split("\t");
      return {
        path: path || "",
        // Binary files show "-" for insertions/deletions
        insertions: ins === "-" ? 0 : parseInt(ins, 10) || 0,
        deletions: del === "-" ? 0 : parseInt(del, 10) || 0,
      };
    })
    .filter((f) => f.path);
}

/**
 * Get file changes (numstat) for a batch of commits.
 *
 * Non-merge commits: one `git log --no-walk --numstat` per 500-hash batch
 * (the old shape spawned one `diff-tree` per commit — N subprocesses).
 * Merge commits: `git log/diff-tree` emit NOTHING for a merge without `-m`,
 * so every merge used to index with zero file changes — including evil-merge
 * conflict resolutions that exist in no branch commit. They get a per-hash
 * `diff-tree -m --first-parent` (what the merge landed on its target branch).
 */
async function getFileChanges(
  hashes: string[],
  gitRoot: string,
  mergeHashes: Set<string>
): Promise<Map<string, FileChange[]>> {
  assertCommitHashes(hashes);
  const result = new Map<string, FileChange[]>();
  for (const h of hashes) result.set(h, []);

  // core.quotepath=false: keep non-ASCII paths literal ("café.ts"), not
  // octal-escaped+quoted, so they match in getFileHistory.
  const plain = hashes.filter((h) => !mergeHashes.has(h));
  const BATCH = 500; // batched argv — a full-history index can be 10k+ hashes
  for (let i = 0; i < plain.length; i += BATCH) {
    const batch = plain.slice(i, i + BATCH);
    const output = await runGit(
      [
        "-c", "core.quotepath=false",
        "log", "--no-walk", "--numstat", `--format=${RECORD_SEP}%H`,
        ...batch,
      ],
      gitRoot
    );
    if (output === null) continue; // leaves [] — caller's commits still index

    for (const record of output.split(RECORD_SEP)) {
      const lines = record.split("\n").filter((l) => l.trim());
      if (lines.length === 0) continue;
      const hash = lines[0].trim();
      if (!COMMIT_HASH.test(hash)) continue;
      result.set(hash, parseNumstatLines(lines.slice(1)));
    }
  }

  for (const hash of mergeHashes) {
    const output = await runGit(
      [
        "-c", "core.quotepath=false",
        "diff-tree", "--no-commit-id", "-r", "--numstat", "-m", "--first-parent", "--root", hash,
      ],
      gitRoot
    );
    if (output) result.set(hash, parseNumstatLines(output.split("\n")));
  }

  return result;
}

/**
 * Handle force push: find which indexed commits are still reachable,
 * purge the orphaned ones, and return the latest surviving commit
 * as the new sinceRef for incremental indexing.
 *
 * A FAILED `git log --all` (lock contention, OOM, …) must be distinguishable
 * from "no shared history": the caller responds to the latter with
 * clearGitHistory(), and one transient subprocess failure must not wipe the
 * entire commit index.
 */
async function handleForcePush(
  db: RagDB,
  gitRoot: string,
  onProgress?: (msg: string, opts?: { transient?: boolean }) => void,
): Promise<
  | { status: "recovered"; hash: string; purged: number }
  | { status: "no-shared-history" }
  | { status: "git-failed" }
> {
  // Get all commits currently reachable from any ref
  const reachableOutput = await runGit(
    ["log", "--format=%H", "--all"],
    gitRoot
  );
  if (reachableOutput === null) return { status: "git-failed" };

  const reachable = new Set(reachableOutput.split("\n").filter(Boolean));

  // Purge indexed commits that are no longer reachable
  const purged = db.purgeOrphanedCommits(reachable);

  // Find the latest remaining indexed commit to use as sinceRef
  const lastHash = db.getLastIndexedCommit();
  if (!lastHash) return { status: "no-shared-history" };

  return { status: "recovered", hash: lastHash, purged };
}

/**
 * Build the embeddable text for a commit.
 * Combines the commit message with file change context for better semantic matching.
 */
function buildEmbeddableText(
  commit: RawCommit,
  files: FileChange[]
): string {
  const parts = [commit.message];

  if (files.length > 0) {
    // Group by top-level directory
    const dirs = new Set<string>();
    for (const f of files) {
      const firstSlash = f.path.indexOf("/");
      dirs.add(firstSlash > 0 ? f.path.substring(0, firstSlash) : f.path);
    }

    parts.push(`\nFiles changed: ${files.map((f) => f.path).join(", ")}`);
    parts.push(`Modules affected: ${[...dirs].join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Build a diff summary from file changes.
 */
function buildDiffSummary(files: FileChange[]): string | null {
  if (files.length === 0) return null;

  const lines = files
    .slice(0, 20) // Cap to avoid huge summaries
    .map((f) => `${f.path} (+${f.insertions} -${f.deletions})`);

  if (files.length > 20) {
    lines.push(`... and ${files.length - 20} more files`);
  }

  return lines.join("\n");
}

export interface GitIndexResult {
  indexed: number;
  skipped: number;
  total: number;
}

/**
 * Index git history for a project directory.
 */
export async function indexGitHistory(
  projectDir: string,
  db: RagDB,
  options?: {
    since?: string;
    onProgress?: (msg: string, opts?: { transient?: boolean }) => void;
    threads?: number;
  }
): Promise<GitIndexResult> {
  const onProgress = options?.onProgress;
  const result: GitIndexResult = { indexed: 0, skipped: 0, total: 0 };

  const gitRoot = await findGitRoot(projectDir);
  if (!gitRoot) {
    onProgress?.("Not a git repository — skipping git history indexing");
    return result;
  }

  // Determine the range to index. The resume point is the HEAD recorded when
  // the last run completed (explicit cursor); legacy DBs without one fall back
  // to the newest indexed commit by date.
  let sinceRef = options?.since;
  if (!sinceRef) {
    const lastHash = db.getGitResumePoint() ?? db.getLastIndexedCommit();
    if (lastHash) {
      // Check if lastHash is still a valid ancestor
      const isAncestor = await runGit(
        ["merge-base", "--is-ancestor", lastHash, "HEAD"],
        gitRoot
      );
      if (isAncestor !== null) {
        sinceRef = lastHash;
      } else {
        // Force push detected — find the fork point to minimize re-indexing.
        // Walk indexed commits oldest-to-newest and find the last one still
        // in current history. Purge everything after it.
        onProgress?.("Force push detected — finding shared history...");
        const recovery = await handleForcePush(db, gitRoot, onProgress);
        if (recovery.status === "recovered") {
          sinceRef = recovery.hash;
          // Persist the recovered resume point NOW: the normal persist at the
          // end of a successful run is skipped by the "no new commits" early
          // returns, and a stale git_resume_head re-triggered this full
          // `git log --all` recovery scan on every subsequent run.
          db.setGitResumePoint(recovery.hash);
          onProgress?.(`Purged ${recovery.purged} orphaned commits, resuming from ${recovery.hash.slice(0, 8)}`);
        } else if (recovery.status === "no-shared-history") {
          onProgress?.("No shared history found — rebuilding full index.");
          db.clearGitHistory();
          db.clearGitResumePoint();
        } else {
          // Transient git failure — do NOT clear the index; retry next run.
          log.warn("git log --all failed during force-push recovery; keeping existing index, will retry", "git-index");
          return result;
        }
      }
    }
  }

  // Get commit log (%P = parent hashes, parsed into parentCount — a separate
  // per-batch parent lookup used to blow ARG_MAX on big repos and silently
  // mark every commit non-merge when it failed)
  const logArgs = [
    "log",
    `--format=${RECORD_SEP}%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%P${FIELD_SEP}%D${FIELD_SEP}%B`,
    "--all",
  ];
  if (sinceRef) {
    logArgs.push(`${sinceRef}..HEAD`);
  }

  onProgress?.("Scanning git history...");
  const logOutput = await runGit(logArgs, gitRoot);
  if (!logOutput) {
    onProgress?.("No commits found");
    return result;
  }

  const commits = parseGitLog(logOutput);
  result.total = commits.length;

  // Advance the resume point on "nothing to do" outcomes too — otherwise the
  // same already-covered range is re-listed (and a recovery hash re-checked)
  // on every subsequent run until a genuinely new commit lands. NEVER when the
  // caller passed an explicit --since: that scopes a partial index, and
  // jumping the cursor to HEAD would permanently skip everything below REF.
  const persistHead = async () => {
    if (options?.since) return;
    const head = await runGit(["rev-parse", "HEAD"], gitRoot);
    if (head) db.setGitResumePoint(head);
  };

  if (commits.length === 0) {
    onProgress?.("No new commits to index");
    await persistHead();
    return result;
  }

  onProgress?.(`Found ${commits.length} commits to index`);

  // Filter out already-indexed commits
  const newCommits = commits.filter((c) => !db.hasCommit(c.hash));
  result.skipped = commits.length - newCommits.length;

  if (newCommits.length === 0) {
    onProgress?.("All commits already indexed");
    await persistHead();
    return result;
  }

  onProgress?.(`Indexing ${newCommits.length} new commits...`);

  // Get file changes (parent counts already parsed from %P in the log format)
  const hashes = newCommits.map((c) => c.hash);
  const mergeHashes = new Set(newCommits.filter((c) => c.parentCount > 1).map((c) => c.hash));
  const fileChanges = await getFileChanges(hashes, gitRoot, mergeHashes);

  // Build embeddable texts
  const texts: string[] = [];
  for (const commit of newCommits) {
    const files = fileChanges.get(commit.hash) || [];
    texts.push(buildEmbeddableText(commit, files));
  }

  // Batch embed
  onProgress?.("Embedding commit messages...");
  const embeddings = await embedBatchMerged(
    texts,
    options?.threads,
    onProgress ? (msg: string) => onProgress(msg, { transient: true }) : undefined,
  );

  // Build insert batch
  const inserts: GitCommitInsert[] = newCommits.map((commit, i) => {
    const files = fileChanges.get(commit.hash) || [];
    const totalIns = files.reduce((s, f) => s + f.insertions, 0);
    const totalDel = files.reduce((s, f) => s + f.deletions, 0);
    const refs = commit.refs
      ? commit.refs.split(",").map((r) => r.trim()).filter(Boolean)
      : [];

    return {
      hash: commit.hash,
      shortHash: commit.hash.slice(0, 8),
      message: commit.message,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      date: commit.date,
      filesChanged: files,
      insertions: totalIns,
      deletions: totalDel,
      isMerge: commit.parentCount > 1,
      refs,
      diffSummary: buildDiffSummary(files),
      embedding: embeddings[i],
    };
  });

  // Insert in batches
  const DB_BATCH = 100;
  for (let i = 0; i < inserts.length; i += DB_BATCH) {
    const batch = inserts.slice(i, i + DB_BATCH);
    db.insertCommitBatch(batch);
    const done = Math.min(i + DB_BATCH, inserts.length);
    onProgress?.(`Indexed ${done}/${inserts.length} commits`, { transient: true });
  }

  result.indexed = inserts.length;
  onProgress?.(`Indexed ${result.indexed} commits`);

  // Record the explicit resume point only after a fully successful run.
  const head = await runGit(["rev-parse", "HEAD"], gitRoot);
  if (head) db.setGitResumePoint(head);

  return result;
}
