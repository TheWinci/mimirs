import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RagDB } from "../db";
import { generateMermaid } from "../graph/resolver";

export function registerGraphTools(server: McpServer, getDB: (dir: string) => RagDB) {
  server.tool(
    "project_map",
    "Generate a Mermaid dependency graph of the project. Shows file relationships, exports, and entry points.",
    {
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      focus: z
        .string()
        .optional()
        .describe("File path (relative to project) to focus on — shows only nearby files"),
      zoom: z
        .enum(["file", "directory"])
        .optional()
        .describe("Zoom level: 'file' (default) or 'directory' for large projects"),
      maxNodes: z
        .number()
        .optional()
        .describe("Max nodes in graph (default: 50, auto-switches to directory view if exceeded)"),
    },
    async ({ directory, focus, zoom, maxNodes }) => {
      const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
      const ragDb = getDB(projectDir);

      const mermaid = generateMermaid(ragDb, {
        projectDir,
        focus,
        zoom: zoom ?? "file",
        maxNodes: maxNodes ?? 50,
      });

      return {
        content: [{ type: "text" as const, text: mermaid }],
      };
    }
  );

  server.tool(
    "find_usages",
    "Find every usage (call site or reference) of a symbol across the codebase. Returns file paths, line numbers, and the matching line. Excludes the file that defines the symbol. Use this before renaming or changing a function signature to understand the blast radius.",
    {
      symbol: z.string().describe("Symbol name to search for"),
      exact: z
        .boolean()
        .optional()
        .describe("Require exact word-boundary match (default: true). Set false for prefix/substring matching."),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      top: z.number().optional().describe("Max results to return (default: 30)"),
    },
    async ({ symbol, exact, directory, top }) => {
      const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
      const ragDb = getDB(projectDir);

      const results = ragDb.findUsages(symbol, exact ?? true, top ?? 30);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No usages of "${symbol}" found. The symbol may only appear in its definition file, or the index may need re-running.` }],
        };
      }

      // Group by file
      const byFile = new Map<string, { line: number | null; snippet: string }[]>();
      for (const r of results) {
        if (!byFile.has(r.path)) byFile.set(r.path, []);
        byFile.get(r.path)!.push({ line: r.line, snippet: r.snippet });
      }

      const fileCount = byFile.size;
      const lines: string[] = [
        `Found ${results.length} usage${results.length !== 1 ? "s" : ""} of "${symbol}" across ${fileCount} file${fileCount !== 1 ? "s" : ""}:\n`,
      ];

      for (const [path, usages] of byFile) {
        lines.push(path);
        for (const u of usages) {
          const lineStr = u.line != null ? `:${u.line}` : "";
          lines.push(`  ${lineStr}  ${u.snippet}`);
        }
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}
