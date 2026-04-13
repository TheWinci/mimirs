import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve, relative } from "path";
import { generateProjectMap } from "../graph/resolver";
import { type GetDB, resolveProject } from "./index";

export function registerGraphTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "project_map",
    "Visualize how files relate to each other — imports, exports, and entry points. Faster than reading import statements across many files. Use 'focus' to zoom into a specific file's neighborhood. Use search or read_relevant next to explore specific areas of the map.",
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
        .int()
        .min(1)
        .optional()
        .describe("Max nodes in graph (default: 50, auto-switches to directory view if exceeded)"),
    },
    async ({ directory, focus, zoom, maxNodes }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const map = generateProjectMap(ragDb, {
        projectDir,
        focus,
        zoom: zoom ?? "file",
        maxNodes: maxNodes ?? 50,
      });

      const footer = `\n── Tip: call search("<topic>") to find files related to a specific area, or depends_on/depended_on_by for a single file's connections. ──`;

      return {
        content: [{ type: "text" as const, text: `${map}${footer}` }],
      };
    }
  );

  server.tool(
    "find_usages",
    "Find every call site or reference to a symbol across all indexed files — with file paths, line numbers, and matching lines. More reliable than grep for usage analysis: searches the chunk index so it won't miss aliased imports or re-exports. Use this before renaming or changing a function signature.",
    {
      symbol: z.string().min(1).max(200).describe("Symbol name to search for"),
      exact: z
        .boolean()
        .optional()
        .describe("Require exact word-boundary match (default: true). Set false for prefix/substring matching."),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      top: z.number().int().min(1).optional().describe("Max results to return (default: 30)"),
    },
    async ({ symbol, exact, directory, top }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

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

      const footer = `── Tip: call depended_on_by("<file>") on any file above to see its full importer tree. ──`;
      lines.push(footer);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  server.tool(
    "depends_on",
    "List all files that a given file imports (its dependencies). Shows the resolved import graph — what this file actually depends on. Use depended_on_by for the reverse direction.",
    {
      file: z.string().describe("File path (relative to project) to query"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ file, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const absPath = resolve(projectDir, file);
      const fileRecord = ragDb.getFileByPath(absPath);
      if (!fileRecord) {
        return { content: [{ type: "text" as const, text: `File "${file}" not found in index.` }] };
      }

      const deps = ragDb.getDependsOn(fileRecord.id);
      if (deps.length === 0) {
        return { content: [{ type: "text" as const, text: `${file} has no indexed dependencies.` }] };
      }

      const lines = [`${file} depends on ${deps.length} file${deps.length !== 1 ? "s" : ""}:\n`];
      for (const dep of deps) {
        lines.push(`  ${relative(projectDir, dep.path)}  (import: ${dep.source})`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "depended_on_by",
    "List all files that import a given file (reverse dependencies). Shows the blast radius before modifying a file — every file that would be affected by a change. Use find_usages for symbol-level granularity.",
    {
      file: z.string().describe("File path (relative to project) to query"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ file, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const absPath = resolve(projectDir, file);
      const fileRecord = ragDb.getFileByPath(absPath);
      if (!fileRecord) {
        return { content: [{ type: "text" as const, text: `File "${file}" not found in index.` }] };
      }

      const importers = ragDb.getDependedOnBy(fileRecord.id);
      if (importers.length === 0) {
        return { content: [{ type: "text" as const, text: `No files import ${file}.` }] };
      }

      const lines = [`${file} is imported by ${importers.length} file${importers.length !== 1 ? "s" : ""}:\n`];
      for (const imp of importers) {
        lines.push(`  ${relative(projectDir, imp.path)}  (import: ${imp.source})`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
