import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { relative } from "path";
import { type AnnotationRow } from "../db";
import { search, searchChunks } from "../search/hybrid";
import { type GetDB, resolveProject } from "./index";

export function registerSearchTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "search",
    "Search the full codebase by meaning — finds files that grep misses. Use natural language ('how does auth work') or symbol names. Searches all indexed files semantically + by keyword in <100ms. Returns ranked file paths with snippets. Use read_relevant next to get full content with line ranges.",
    {
      query: z.string().describe("The search query (natural language)"),
      directory: z
        .string()
        .optional()
        .describe(
          "Project directory to search. Defaults to RAG_PROJECT_DIR env or cwd"
        ),
      top: z
        .number()
        .optional()
        .describe("Number of results to return (default: from config or 10)"),
    },
    async ({ query, directory, top }) => {
      const { db: ragDb, config } = await resolveProject(directory, getDB);

      const start = performance.now();
      const results = await search(query, ragDb, top ?? config.searchTopK, 0, config.hybridWeight, config.enableReranking);
      const durationMs = Math.round(performance.now() - start);
      const { totalFiles } = ragDb.getStatus();

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found across ${totalFiles} indexed files. Has the directory been indexed? Try calling index_files first.`,
            },
          ],
        };
      }

      const header = `── ${results.length} results across ${totalFiles} indexed files (${durationMs}ms) ──`;

      const body = results
        .map(
          (r) =>
            `${r.score.toFixed(4)}  ${r.path}\n  ${r.snippets[0]?.slice(0, 400)}...`
        )
        .join("\n\n");

      const footer = `\n── Tip: call read_relevant with the same query to get full function/class content with exact line ranges. ──`;

      return {
        content: [{ type: "text" as const, text: `${header}\n\n${body}${footer}` }],
      };
    }
  );

  server.tool(
    "read_relevant",
    "Get the actual content of the most relevant code chunks — individual functions, classes, or sections — with exact line ranges for navigation. Smarter than grep: finds code by meaning, not just string matching. Multiple chunks from the same file can appear. Use this instead of search + Read when you need the content itself.",
    {
      query: z.string().describe("The search query (natural language)"),
      directory: z
        .string()
        .optional()
        .describe(
          "Project directory to search. Defaults to RAG_PROJECT_DIR env or cwd"
        ),
      top: z
        .number()
        .optional()
        .describe("Max chunks to return (default: 8)"),
      threshold: z
        .number()
        .optional()
        .describe("Min relevance score to include (default: 0.3)"),
    },
    async ({ query, directory, top, threshold }) => {
      const { projectDir, db: ragDb, config } = await resolveProject(directory, getDB);

      const start = performance.now();
      const results = await searchChunks(
        query,
        ragDb,
        top ?? 8,
        threshold ?? 0.3,
        config.hybridWeight,
        config.enableReranking
      );
      const durationMs = Math.round(performance.now() - start);
      const { totalFiles } = ragDb.getStatus();

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No relevant chunks found across ${totalFiles} indexed files. Has the directory been indexed? Try calling index_files first.`,
            },
          ],
        };
      }

      const uniqueFiles = new Set(results.map((r) => r.path));
      const header = `── ${results.length} chunks from ${uniqueFiles.size} files (searched ${totalFiles} files in ${durationMs}ms) ──`;

      // Batch-fetch annotations for all unique paths (avoids N+1 queries)
      const uniqueRelPaths = [...new Set(results.map((r) => relative(projectDir, r.path)))];
      const annotationsByPath = new Map<string, AnnotationRow[]>();
      for (const relPath of uniqueRelPaths) {
        const anns = ragDb.getAnnotations(relPath);
        if (anns.length > 0) annotationsByPath.set(relPath, anns);
      }

      // Collect entity names for the follow-up suggestion
      const entityNames = results
        .map((r) => r.entityName)
        .filter((name): name is string => name != null && name.length > 0);
      const topEntity = entityNames[0];

      const body = results
        .map((r) => {
          const lineRange = r.startLine != null && r.endLine != null ? `:${r.startLine}-${r.endLine}` : "";
          const entity = r.entityName ? `  •  ${r.entityName}` : "";
          const resultHeader = `[${r.score.toFixed(2)}] ${r.path}${lineRange}${entity}`;

          // Surface annotations for this file (and matching entity if applicable)
          const relPath = relative(projectDir, r.path);
          const fileAnnotations = annotationsByPath.get(relPath) ?? [];
          const relevant = fileAnnotations.filter(
            (a) => a.symbolName == null || a.symbolName === r.entityName
          );
          const noteBlock = relevant.length > 0
            ? relevant.map((a) => {
                const target = a.symbolName ? ` (${a.symbolName})` : "";
                return `[NOTE${target}] ${a.note}`;
              }).join("\n") + "\n"
            : "";

          return `${resultHeader}\n${noteBlock}${r.content}`;
        })
        .join("\n\n---\n\n");

      const footerHint = topEntity
        ? `call find_usages("${topEntity}") to see all call sites before modifying.`
        : `call find_usages("<symbol>") to see all call sites before modifying.`;
      const footer = `\n── Tip: ${footerHint} ──`;

      return {
        content: [{ type: "text" as const, text: `${header}\n\n${body}${footer}` }],
      };
    }
  );

  server.tool(
    "search_symbols",
    "Find where a function, class, type, or interface is defined — by name, not semantics. Faster than grep for symbol lookup: searches the pre-built symbol index across all indexed files. Use find_usages next to see where the symbol is called.",
    {
      symbol: z.string().describe("Symbol name to search for"),
      exact: z
        .boolean()
        .optional()
        .describe("Require exact match (case-insensitive). Default: false (substring match)"),
      type: z
        .enum(["function", "class", "interface", "type", "enum", "export"])
        .optional()
        .describe("Filter by symbol type"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      top: z.number().optional().describe("Max results (default: 20)"),
    },
    async ({ symbol, exact, type, directory, top }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);

      const results = ragDb.searchSymbols(symbol, exact ?? false, type, top ?? 20);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No exported symbols matching "${symbol}" found.` }],
        };
      }

      const body = results
        .map((r) => {
          const snippet = r.snippet ? `\n${r.snippet.slice(0, 300)}` : "";
          return `${r.path}  •  ${r.symbolName} (${r.symbolType})${snippet}`;
        })
        .join("\n\n---\n\n");

      const topSymbol = results[0].symbolName;
      const footer = `\n── Tip: call find_usages("${topSymbol}") to see all call sites, or read_relevant("${topSymbol}") for full context. ──`;

      return { content: [{ type: "text" as const, text: `${body}${footer}` }] };
    }
  );

  server.tool(
    "write_relevant",
    "Find the best file and location to insert new code or docs. Returns semantically appropriate insertion points with anchors for precise placement. Use this before adding a new function to find which file and position it belongs in.",
    {
      content: z.string().describe("The content you want to add — a function, class, doc section, etc."),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      top: z
        .number()
        .optional()
        .describe("Number of candidate locations to return (default: 3)"),
      threshold: z
        .number()
        .optional()
        .describe("Min relevance score (default: 0.3)"),
    },
    async ({ content, directory, top, threshold }) => {
      const { db: ragDb, config } = await resolveProject(directory, getDB);

      const topN = top ?? 3;
      const chunks = await searchChunks(
        content,
        ragDb,
        topN * 3,
        threshold ?? 0.3,
        config.hybridWeight,
        config.enableReranking
      );

      if (chunks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No relevant location found. The index may be empty — try index_files first." }],
        };
      }

      // Best-scoring chunk per file, up to topN
      const byFile = new Map<string, (typeof chunks)[0]>();
      for (const r of chunks) {
        const existing = byFile.get(r.path);
        if (!existing || r.score > existing.score) {
          byFile.set(r.path, r);
        }
      }

      const candidates = [...byFile.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);

      const body = candidates
        .map((r) => {
          const insertAfter = r.entityName
            ? `after \`${r.entityName}\` (chunk ${r.chunkIndex})`
            : `after chunk ${r.chunkIndex}`;
          const anchor = r.content.slice(-150).trim();
          return `[${r.score.toFixed(2)}] ${r.path}\n  Insert ${insertAfter}\n  Anchor: ...${anchor}`;
        })
        .join("\n\n---\n\n");

      const topFile = candidates[0].path;
      const footer = `\n── Tip: call read_relevant with your content query to see the surrounding code at the insertion point. ──`;

      return { content: [{ type: "text" as const, text: `${body}${footer}` }] };
    }
  );
}
