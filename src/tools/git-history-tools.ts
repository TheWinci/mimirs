import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GetDB, resolveProject } from "./index";
import { embed } from "../embeddings/embed";
import { rrfFuse } from "../search/hybrid";
import { vectorScoreToCosine } from "../db/search";
import { type GitCommitSearchResult } from "../db/types";

// since/until are compared LEXICALLY against ISO timestamps in SQL — a
// non-ISO value ("yesterday", "01/02/2025") silently filters everything out.
// Validate the shape at the boundary and fail loudly instead.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
function validateIsoDate(value: string | undefined, name: string): string | null {
  if (value !== undefined && !ISO_DATE_RE.test(value)) {
    return `Invalid ${name}: "${value}" — expected an ISO date like 2025-01-31 (optionally with time).`;
  }
  return null;
}

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
        .describe("Filter commits from this ISO date on, inclusive (e.g. 2025-01-01)"),
      until: z.string().optional()
        .describe("Filter commits up to this ISO date, inclusive (a date-only value covers that whole day)"),
      path: z.string().optional()
        .describe("Filter to commits that touched this file path (substring match)"),
      threshold: z.number().min(0).max(1).optional().default(0)
        .describe("Minimum relevance score (0-1)"),
      directory: z.string().optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ query, top, author, since, until, path, threshold, directory }) => {
      const { db: ragDb, config } = await resolveProject(directory, getDB);

      const dateErr = validateIsoDate(since, "since") ?? validateIsoDate(until, "until");
      if (dateErr) {
        return { content: [{ type: "text" as const, text: dateErr }] };
      }

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

      // Hybrid search: vector + FTS, fused by rank like every other hybrid
      // search. The old hand-rolled blend scaled text-only hits by 0.3 (a
      // strong exact-keyword match ranked BELOW weak vector matches) and could
      // score a both-list hit lower than its vector-only score.
      const vectorResults = ragDb.searchGitCommits(queryEmbedding, top, author, since, until, path);
      const textResults = ragDb.textSearchGitCommits(query, top, author, since, until, path);

      // `threshold` compares the true cosine of the vector match (fused scores
      // are positional). Applied only to VECTOR-ONLY rows above threshold 0:
      // keyword hits are their own signal, and the default threshold of 0 must
      // not drop vector hits with a (legitimately) negative derived cosine.
      const cosineByHash = new Map<string, number | null>();
      for (const v of vectorResults) cosineByHash.set(v.hash, vectorScoreToCosine(v.score));
      const textHashes = new Set(textResults.map((t) => t.hash));

      let results = rrfFuse(vectorResults, textResults, config.hybridWeight, (r) => r.hash)
        .filter((r) => {
          if (threshold <= 0 || textHashes.has(r.hash)) return true;
          const cos = cosineByHash.get(r.hash);
          return cos == null || cos >= threshold;
        })
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
    "co_change",
    "Files that historically change in the same commit as a given file — logical coupling the import graph can't see (doc↔code, test↔impl, synced mirrors, sibling files with no import edge). Use before editing a file to find what else usually changes with it, or to widen a change's blast radius beyond static dependents. Ranked by Jaccard so ubiquitous files (lockfiles, manifests) sink. Requires git history to be indexed.",
    {
      path: z.string().describe("File path (relative to project root, suffix match)"),
      top: z.number().int().min(1).optional().default(15)
        .describe("Max coupled files to return"),
      minTogether: z.number().int().min(1).optional().default(2)
        .describe("Minimum co-change count to report a pair"),
      maxCommitFiles: z.number().int().min(2).optional().default(25)
        .describe("Ignore commits touching more than this many files (bulk/sweeping changes couple unrelated files)"),
      directory: z.string().optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ path, top, minTogether, maxCommitFiles, directory }) => {
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

      const results = ragDb.getCoChangedFiles(path, { topK: top, minTogether, maxCommitFiles });

      if (results.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No co-change found for "${path}". Either it changes alone, has too little history, or the path didn't match an indexed file.`,
          }],
        };
      }

      const header = `## Files that co-change with "${path}" (${results.length})\n`;
      const body = results
        .map((r, i) =>
          `${i + 1}. ${r.filePath}\n   together ${r.together} · jaccard ${r.jaccard.toFixed(2)} · confidence ${r.confidence.toFixed(2)} (${r.fileCommits} commits touch it)`)
        .join("\n");

      return { content: [{ type: "text" as const, text: header + "\n" + body }] };
    }
  );

  server.tool(
    "file_history",
    "Get the commit history for a specific file. Returns commits that touched the file, sorted by date (newest first). Faster than git log for indexed repositories.",
    {
      path: z.string().describe("File path (relative to project root, suffix match)"),
      top: z.number().int().min(1).optional().default(20)
        .describe("Max commits to return"),
      since: z.string().optional()
        .describe("Only show commits after this ISO date"),
      directory: z.string().optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ path, top, since, directory }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);

      const dateErr = validateIsoDate(since, "since");
      if (dateErr) {
        return { content: [{ type: "text" as const, text: dateErr }] };
      }

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
