import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "path";
import { type GetDB, resolveProject } from "./index";

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

export async function findGitRoot(dir: string): Promise<string | null> {
  return runGit(["rev-parse", "--show-toplevel"], dir);
}

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

      const sinceRef = since ?? "HEAD~5";
      const sections: string[] = [];

      // 1. Uncommitted changes
      const statusOutput = await runGit(["status", "--short"], gitRoot);
      if (statusOutput) {
        const statusLines = statusOutput.split("\n").filter(Boolean);
        if (statusLines.length > 0) {
          const annotated = statusLines.map((line) => {
            const filePart = line.slice(3).trim();
            const filePath = filePart.includes(" -> ") ? filePart.split(" -> ")[1] : filePart;
            const absPath = resolve(gitRoot, filePath);
            const tag = ragDb.getFileByPath(absPath) != null ? "[indexed]" : "[not indexed]";
            return files_only ? `${filePath}  ${tag}` : `${line}  ${tag}`;
          });
          sections.push("## Uncommitted changes\n" + annotated.join("\n"));
        }
      }

      // 2. Recent commits (omit body when files_only)
      if (!files_only) {
        const logOutput = await runGit(["log", "--oneline", `${sinceRef}..HEAD`], gitRoot);
        if (logOutput) {
          sections.push(`## Recent commits (since ${sinceRef})\n` + logOutput);
        }
      }

      // 3. Changed files since sinceRef
      const diffFilesOutput = await runGit(["diff", "--name-only", `${sinceRef}..HEAD`], gitRoot);
      if (diffFilesOutput) {
        sections.push(`## Changed files (since ${sinceRef})\n` + diffFilesOutput);
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
