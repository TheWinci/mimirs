import { resolve, relative } from "path";
import { realpathSync } from "fs";
import { runGit, findGitRoot, getHeadSha } from "./exec";

/**
 * Has the code a memory was written against moved on? Each input carries the
 * `commitHash` it was stamped with and the project-relative files it concerns.
 *
 * Verdict per input (or `null` = no signal, render nothing):
 *  - `current`  — stamped at HEAD, or HEAD moved but none of its files changed.
 *  - `stale`    — at least one of its files changed since the stamp (committed
 *                 or in the working tree); `changedFiles` lists which.
 *  - `diverged` — the stamped commit is no longer in history (rebase/squash or
 *                 a different clone); can't compare reliably.
 *
 * `null` is returned for legacy/unstamped rows, rows with no files to anchor on,
 * and non-git projects — staleness is opt-in signal, never a false alarm.
 *
 * We compare working-tree-vs-commit (`git diff <sha>`), so uncommitted edits
 * count too. Diffs are cached per distinct sha so a result set with shared
 * stamps costs one git call, not one per row.
 */
export type FreshnessState = "current" | "stale" | "diverged";

export interface Freshness {
  state: FreshnessState;
  changedFiles: string[];
}

export interface FreshnessInput {
  commitHash: string | null;
  filesInvolved: string[];
}

export async function computeFreshness(
  projectDir: string,
  rows: FreshnessInput[],
): Promise<(Freshness | null)[]> {
  const head = await getHeadSha(projectDir);
  const root = await findGitRoot(projectDir);
  if (!head || !root) return rows.map(() => null); // non-git → no signal

  // `git rev-parse --show-toplevel` returns the canonical (symlink-resolved)
  // path, so canonicalise projectDir too — otherwise on macOS (/var → /private/
  // var) the project-relative→root-relative mapping is wrong and nothing matches.
  let canonicalProject = projectDir;
  try {
    canonicalProject = realpathSync(projectDir);
  } catch {
    /* projectDir should exist, but degrade to the raw path if not */
  }

  const diffCache = new Map<string, Set<string> | null>();
  const out: (Freshness | null)[] = [];

  for (const r of rows) {
    if (!r.commitHash || r.filesInvolved.length === 0) {
      out.push(null); // unstamped or nothing to anchor on
      continue;
    }
    if (r.commitHash === head) {
      out.push({ state: "current", changedFiles: [] });
      continue;
    }

    let changed = diffCache.get(r.commitHash);
    if (changed === undefined) {
      const diff = await runGit(["diff", "--name-only", r.commitHash], root);
      changed = diff == null ? null : new Set(diff.split("\n").filter(Boolean));
      diffCache.set(r.commitHash, changed);
    }
    if (changed === null) {
      out.push({ state: "diverged", changedFiles: [] }); // commit not in this history
      continue;
    }

    // Files are stored project-relative; git reports root-relative. Normalise
    // through an absolute path so subdir projects line up with the diff output.
    const hits = r.filesInvolved
      .map((f) => relative(root, resolve(canonicalProject, f)))
      .filter((rel) => changed!.has(rel));

    out.push(hits.length ? { state: "stale", changedFiles: hits } : { state: "current", changedFiles: [] });
  }

  return out;
}

/** One-line tag for a freshness verdict, or "" when there's no signal. */
export function freshnessTag(f: Freshness | null): string {
  if (!f) return "";
  switch (f.state) {
    case "current":
      return "✓ current";
    case "stale":
      return `⚠ stale — changed since: ${f.changedFiles.slice(0, 5).join(", ")}`;
    case "diverged":
      return "⚠ written on a commit not in current history";
  }
}
