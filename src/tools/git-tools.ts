import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "path";
import { type GetDB, resolveProject } from "./index";

// Canonical git helpers now live in src/git/exec.ts; imported for local use and
// re-exported so existing importers (e.g. cli/commands/affected.ts) keep their path.
import { runGit, findGitRoot, getHeadSha } from "../git/exec";
export { runGit, findGitRoot, getHeadSha };

export function registerGitTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "git_context",
    "Show git context for the working tree: uncommitted changes annotated with index status, recent commits, and changed files. Use this at the start of a session to understand what has already been modified before searching or editing.",
    {
      since: z
        .string()
        .optional()
        .describe("Commit ref, branch, or ISO date to look back to (default: HEAD~5)"),
      include_diff: z
        .boolean()
        .optional()
        .describe("Include full unified diff of uncommitted changes, truncated to 200 lines (default: false)"),
      files_only: z
        .boolean()
        .optional()
        .describe("Return file paths only — omit commit messages and diff body (default: false)"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ since, include_diff, files_only, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const gitRoot = await findGitRoot(resolve(projectDir));
      if (!gitRoot) {
        return { content: [{ type: "text" as const, text: "Not a git repository." }] };
      }

      // Resolve `since` into a concrete ref. Three cases:
      //  - leading "-": reject (would be parsed as a git option — e.g.
      //    `--output=...` is a write primitive on a read-only tool)
      //  - ISO-date shaped: translate to a ref via `git rev-list -1 --before`
      //    (range syntax `2025-01-01..HEAD` is an unknown-revision error)
      //  - anything else: validate with rev-parse so a typo'd ref is a loud
      //    error instead of silently empty sections
      let sinceRef: string;
      if (since !== undefined) {
        if (since.startsWith("-")) {
          return { content: [{ type: "text" as const, text: `Invalid since: "${since}" — must be a commit ref, branch, or ISO date.` }] };
        }
        if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
          const dated = await runGit(["rev-list", "-1", `--before=${since}`, "HEAD"], gitRoot);
          if (!dated) {
            return { content: [{ type: "text" as const, text: `No commits found before date ${since}.` }] };
          }
          sinceRef = dated;
        } else {
          const verified = await runGit(["rev-parse", "--verify", "--quiet", `${since}^{commit}`], gitRoot);
          if (!verified) {
            return { content: [{ type: "text" as const, text: `Unknown commit ref: "${since}".` }] };
          }
          sinceRef = since;
        }
      } else {
        // Default lookback: HEAD~5 doesn't resolve in repos with ≤5 commits —
        // fall back to the root commit so fresh repos still report history.
        const def = await runGit(["rev-parse", "--verify", "--quiet", "HEAD~5"], gitRoot);
        sinceRef = def
          ? "HEAD~5"
          : (await runGit(["rev-list", "--max-parents=0", "--first-parent", "-1", "HEAD"], gitRoot)) ?? "HEAD";
      }

      const sections: string[] = [];

      // 1. Uncommitted changes (-z: NUL-separated, unquoted — `--short` C-quotes
      // paths with spaces, which then never match the index lookup). raw: a
      // worktree-only first entry starts with a SPACE (" M file"); trim ate it
      // and corrupted the first entry's status + path.
      const statusOutput = await runGit(["status", "--porcelain", "-z"], gitRoot, { raw: true });
      if (statusOutput) {
        const statusEntries: { status: string; filePath: string }[] = [];
        const parts = statusOutput.split("\0").filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
          const entry = parts[i];
          const status = entry.slice(0, 2);
          let filePath = entry.slice(3);
          // Renames/copies emit the ORIGINAL path as the next NUL field; the
          // entry itself holds the new path. Check BOTH columns: worktree-only
          // renames (`git mv` + `add -N`) report " R", not "R ".
          if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") i++;
          statusEntries.push({ status, filePath });
        }
        if (statusEntries.length > 0) {
          const annotated = statusEntries.map(({ status, filePath }) => {
            const absPath = resolve(gitRoot, filePath);
            const tag = ragDb.getFileByPath(absPath) != null ? "[indexed]" : "[not indexed]";
            return files_only ? `${filePath}  ${tag}` : `${status} ${filePath}  ${tag}`;
          });
          sections.push("## Uncommitted changes\n" + annotated.join("\n"));
        }
      }

      // 2. Recent commits (omit body when files_only)
      if (!files_only) {
        const logOutput = await runGit(["log", "--oneline", `${sinceRef}..HEAD`], gitRoot);
        if (logOutput) {
          sections.push(`## Recent commits (since ${since ?? sinceRef})\n` + logOutput);
        }
      }

      // 3. Changed files since sinceRef
      const diffFilesOutput = await runGit(["diff", "--name-only", `${sinceRef}..HEAD`], gitRoot);
      if (diffFilesOutput) {
        sections.push(`## Changed files (since ${since ?? sinceRef})\n` + diffFilesOutput);
      }

      // 4. Diff (opt-in, truncated to 200 lines)
      if (include_diff && !files_only) {
        const diffOutput = await runGit(["diff", "HEAD"], gitRoot);
        if (diffOutput) {
          const diffLines = diffOutput.split("\n");
          const truncated = diffLines.length > 200;
          const body = diffLines.slice(0, 200).join("\n");
          sections.push("## Diff\n" + body + (truncated ? "\n[truncated]" : ""));
        }
      }

      const text =
        sections.length > 0
          ? sections.join("\n\n")
          : "Nothing to report (clean working tree, no recent commits in range).";

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
