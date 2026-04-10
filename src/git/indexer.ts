import { type RagDB } from "../db";
import { type GitCommitInsert } from "../db/git-history";
import { embedBatchMerged } from "../embeddings/embed";
import { log } from "../utils/log";

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

async function runGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}

async function findGitRoot(dir: string): Promise<string | null> {
  return runGit(["rev-parse", "--show-toplevel"], dir);
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
      if (fields.length < 6) return null;

      const [hash, authorName, authorEmail, date, refs, ...messageParts] = fields;
      const message = messageParts.join(FIELD_SEP).trim();
      // Count parents from hash — merge commits have 2+ parents
      // We'll get parent count separately
      return {
        hash,
        message,
        authorName,
        authorEmail,
        date,
        parentCount: 0, // filled in separately
        refs: refs || "",
      };
    })
    .filter((c): c is RawCommit => c !== null);
}

/**
 * Get file changes (numstat) for a batch of commits.
 */
async function getFileChanges(
  hashes: string[],
  gitRoot: string
): Promise<Map<string, FileChange[]>> {
  const result = new Map<string, FileChange[]>();

  // Process in batches to avoid argument list too long
  const BATCH = 50;
  for (let i = 0; i < hashes.length; i += BATCH) {
    const batch = hashes.slice(i, i + BATCH);
    for (const hash of batch) {
      const output = await runGit(
        ["diff-tree", "--no-commit-id", "-r", "--numstat", hash],
        gitRoot
      );
      if (!output) {
        result.set(hash, []);
        continue;
      }

      const files: FileChange[] = output
        .split("\n")
        .filter((line) => line.trim())
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

      result.set(hash, files);
    }
  }

  return result;
}

/**
 * Get parent counts for commits to detect merges.
 */
async function getParentCounts(
  hashes: string[],
  gitRoot: string
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  // Single git command for all hashes
  const output = await runGit(
    ["log", "--format=%H %P", "--no-walk", ...hashes],
    gitRoot
  );
  if (!output) return result;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(" ");
    const hash = parts[0];
    const parentCount = parts.length - 1;
    result.set(hash, parentCount);
  }

  return result;
}

/**
 * Handle force push: find which indexed commits are still reachable,
 * purge the orphaned ones, and return the latest surviving commit
 * as the new sinceRef for incremental indexing.
 */
async function handleForcePush(
  db: RagDB,
  gitRoot: string,
  onProgress?: (msg: string, opts?: { transient?: boolean }) => void,
): Promise<{ hash: string; purged: number } | null> {
  // Get all commits currently reachable from any ref
  const reachableOutput = await runGit(
    ["log", "--format=%H", "--all"],
    gitRoot
  );
  if (!reachableOutput) return null;

  const reachable = new Set(reachableOutput.split("\n").filter(Boolean));

  // Purge indexed commits that are no longer reachable
  const purged = db.purgeOrphanedCommits(reachable);

  // Find the latest remaining indexed commit to use as sinceRef
  const lastHash = db.getLastIndexedCommit();
  if (!lastHash) return null;

  return { hash: lastHash, purged };
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

  // Determine the range to index
  let sinceRef = options?.since;
  if (!sinceRef) {
    const lastHash = db.getLastIndexedCommit();
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
        if (recovery) {
          sinceRef = recovery.hash;
          onProgress?.(`Purged ${recovery.purged} orphaned commits, resuming from ${recovery.hash.slice(0, 8)}`);
        } else {
          onProgress?.("No shared history found — rebuilding full index.");
          db.clearGitHistory();
        }
      }
    }
  }

  // Get commit log
  const logArgs = [
    "log",
    `--format=${RECORD_SEP}%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%D${FIELD_SEP}%B`,
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

  if (commits.length === 0) {
    onProgress?.("No new commits to index");
    return result;
  }

  onProgress?.(`Found ${commits.length} commits to index`);

  // Filter out already-indexed commits
  const newCommits = commits.filter((c) => !db.hasCommit(c.hash));
  result.skipped = commits.length - newCommits.length;

  if (newCommits.length === 0) {
    onProgress?.("All commits already indexed");
    return result;
  }

  onProgress?.(`Indexing ${newCommits.length} new commits...`);

  // Get file changes and parent counts
  const hashes = newCommits.map((c) => c.hash);
  const [fileChanges, parentCounts] = await Promise.all([
    getFileChanges(hashes, gitRoot),
    getParentCounts(hashes, gitRoot),
  ]);

  // Build embeddable texts
  const texts: string[] = [];
  for (const commit of newCommits) {
    const files = fileChanges.get(commit.hash) || [];
    commit.parentCount = parentCounts.get(commit.hash) || 0;
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

  return result;
}
