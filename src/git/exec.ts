// Shared git subprocess helpers. One home for `git` invocation so the tool
// layer, the history indexer, and staleness checks don't each carry a copy.

/**
 * Run `git` with the given args in `cwd`. Returns trimmed stdout on a clean
 * exit, or `null` on any non-zero exit or spawn failure (e.g. not a repo,
 * git not installed). Never throws.
 */
export async function runGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 ? output.trim() : null;
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
