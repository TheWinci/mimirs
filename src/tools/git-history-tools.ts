import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GetDB, resolveProject } from "./index";
import { embed } from "../embeddings/embed";
import { type GitCommitSearchResult } from "../db/types";

function formatCommitResult(r: GitCommitSearchResult, rank: number): string {
  const mergeTag = r.isMerge ? " [merge]" : "";
  const refsTag = r.refs.length > 0 ? ` (${r.refs.join(", ")})` : "";
  const date = r.date.split("T")[0];
  const files = r.filesChanged.slice(0, 5).join(", ");
  const more = r.filesChanged.length > 5 ? ` +${r.filesChanged.length - 5} more` : "";

  return [
    `${rank}. **${r.shortHash}** (${r.score.toFixed(2)}) — ${date} — @${r.authorName}${mergeTag}${refsTag}`,
    `   ${r.message.split("\n")[0]}`,
    `   Files: ${files}${more} (+${r.insertions} -${r.deletions})`,
  ].join("\n");
}

function formatCommitRow(r: import("../db/types").GitCommitRow, rank: number): string {
  const mergeTag = r.isMerge ? " [merge]" : "";
  const date = r.date.split("T")[0];
  const files = r.filesChanged.slice(0, 5).join(", ");
  const more = r.filesChanged.length > 5 ? ` +${r.filesChanged.length - 5} more` : "";

  return [
    `${rank}. **${r.shortHash}** — ${date} — @${r.authorName}${mergeTag}`,
    `   ${r.message.split("\n")[0]}`,
    `   Files: ${files}${more} (+${r.insertions} -${r.deletions})`,
  ].join("\n");
}

export function registerGitHistoryTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "search_commits",
    "Semantically search git commit history. Use this to find why code was changed, when decisions were made, or what an author worked on. Returns commits ranked by relevance to the query.",
    {
      query: z.string().max(2000).describe("Semantic search query"),
      top: z.number().int().min(1).optional().default(10)
        .describe("Number of results to return"),
      author: z.string().optional()
        .describe("Filter by author name or email (case-insensitive substring match)"),
      since: z.string().optional()
        .describe("Filter commits after this ISO date (e.g. 2025-01-01)"),
      until: z.string().optional()
        .describe("Filter commits before this ISO date"),
      path: z.string().optional()
        .describe("Filter to commits that touched this file path (substring match)"),
      threshold: z.number().min(0).max(1).optional().default(0)
        .describe("Minimum relevance score (0-1)"),
      directory: z.string().optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ query, top, author, since, until, path, threshold, directory }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);

      const status = ragDb.getGitHistoryStatus();
      if (status.totalCommits === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No git history indexed. Run `index_files()` or `mimirs history index` first.",
          }],
        };
      }

      const queryEmbedding = await embed(query);

      // Hybrid search: vector + FTS
      const vectorResults = ragDb.searchGitCommits(queryEmbedding, top, author, since, until, path);
      const textResults = ragDb.textSearchGitCommits(query, top, author, since, until, path);

      // Merge and deduplicate
      const seen = new Map<string, GitCommitSearchResult>();
      const HYBRID_WEIGHT = 0.7;

      for (const r of vectorResults) {
        seen.set(r.hash, r);
      }
      for (const r of textResults) {
        const existing = seen.get(r.hash);
        if (existing) {
          existing.score = HYBRID_WEIGHT * existing.score + (1 - HYBRID_WEIGHT) * r.score;
        } else {
          seen.set(r.hash, { ...r, score: (1 - HYBRID_WEIGHT) * r.score });
        }
      }

      let results = [...seen.values()]
        .filter((r) => r.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, top);

      if (results.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No commits found matching "${query}"${author ? ` by ${author}` : ""}.`,
          }],
        };
      }

      const header = `## Results for "${query}" (${results.length} commits, ${status.totalCommits} indexed)\n`;
      const body = results.map((r, i) => formatCommitResult(r, i + 1)).join("\n\n");

      return { content: [{ type: "text" as const, text: header + "\n" + body }] };
    }
  );

  server.tool(
    "file_history",
    "Get the commit history for a specific file. Returns commits that touched the file, sorted by date (newest first). Faster than git log for indexed repositories.",
    {
      path: z.string().describe("File path (relative to project root, substring match)"),
      top: z.number().int().min(1).optional().default(20)
        .describe("Max commits to return"),
      since: z.string().optional()
        .describe("Only show commits after this ISO date"),
      directory: z.string().optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ path, top, since, directory }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);

      const results = ragDb.getFileHistory(path, top, since);

      if (results.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No commits found for "${path}". Is git history indexed?`,
          }],
        };
      }

      const header = `## History for "${path}" (${results.length} commits)\n`;
      const body = results.map((r, i) => formatCommitRow(r, i + 1)).join("\n\n");

      return { content: [{ type: "text" as const, text: header + "\n" + body }] };
    }
  );
}
