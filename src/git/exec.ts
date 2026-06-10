// Shared git subprocess helpers. One home for `git` invocation so the tool
// layer, the history indexer, and staleness checks don't each carry a copy.

/**
 * Run `git` with the given args in `cwd`. Returns trimmed stdout on a clean
 * exit, or `null` on any non-zero exit or spawn failure (e.g. not a repo,
 * git not installed). Never throws.
 *
 * Pass `{ raw: true }` for output where leading whitespace is SIGNIFICANT —
 * `status --porcelain` encodes worktree-only changes with a leading space
 * (` M file`), and trim corrupted the first entry's status and path.
 */
export async function runGit(
  args: string[],
  cwd: string,
  opts?: { raw?: boolean },
): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    // Drain BOTH pipes concurrently: stderr left unread deadlocks git once it
    // fills the ~64KB pipe buffer (e.g. broken-ref warnings during log --all),
    // and stdout then never reaches EOF.
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return opts?.raw ? output : output.trim();
  } catch {
    return null;
  }
}

/** Absolute path of the repository root containing `dir`, or `null` if none. */
export async function findGitRoot(dir: string): Promise<string | null> {
  return runGit(["rev-parse", "--show-toplevel"], dir);
}

/**
 * Full SHA of the current HEAD commit for the repo containing `projectDir`, or
 * `null` when `projectDir` is not in a git repo (so callers degrade to "no
 * signal" rather than failing). Used to stamp memory (checkpoints/annotations)
 * with the code state it was written against.
 */
export async function getHeadSha(projectDir: string): Promise<string | null> {
  const root = await findGitRoot(projectDir);
  if (!root) return null;
  return runGit(["rev-parse", "HEAD"], root);
}
