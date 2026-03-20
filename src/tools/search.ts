import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RagDB, type AnnotationRow } from "../db";
import { loadConfig } from "../config";
import { search, searchChunks } from "../search/hybrid";

export function registerSearchTools(server: McpServer, getDB: (dir: string) => RagDB) {
  server.tool(
    "search",
    "Semantic search over indexed files. Returns ranked file paths with relevance scores and snippets.",
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
        .describe("Number of results to return (default: from config or 5)"),
    },
    async ({ query, directory, top }) => {
      const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
      const ragDb = getDB(projectDir);
      const config = await loadConfig(projectDir);

      const results = await search(query, ragDb, top ?? config.searchTopK, 0, config.hybridWeight);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No results found. Has the directory been indexed? Try calling index_files first.",
            },
          ],
        };
      }

      const text = results
        .map(
          (r) =>
            `${r.score.toFixed(4)}  ${r.path}\n  ${r.snippets[0]?.slice(0, 400)}...`
        )
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  server.tool(
    "read_relevant",
    "Retrieve the most relevant semantic chunks for a query. Returns full chunk content — individual functions, classes, or sections — ranked by relevance. No file deduplication: multiple chunks from the same file can appear. Use this instead of search + Read when you need the actual content.",
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
      const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
      const ragDb = getDB(projectDir);
      const config = await loadConfig(projectDir);

      const results = await searchChunks(
        query,
        ragDb,
        top ?? 8,
        threshold ?? 0.3,
        config.hybridWeight
      );

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No relevant chunks found. Has the directory been indexed? Try calling index_files first.",
            },
          ],
        };
      }

      const text = results
        .map((r) => {
          const lineRange = r.startLine != null && r.endLine != null ? `:${r.startLine}-${r.endLine}` : "";
          const entity = r.entityName ? `  •  ${r.entityName}` : "";
          const header = `[${r.score.toFixed(2)}] ${r.path}${lineRange}${entity}`;

          // Surface annotations for this file (and matching entity if applicable)
          const fileAnnotations = ragDb.getAnnotations(r.path);
          const relevant = fileAnnotations.filter(
            (a) => a.symbolName == null || a.symbolName === r.entityName
          );
          const noteBlock = relevant.length > 0
            ? relevant.map((a) => {
                const target = a.symbolName ? ` (${a.symbolName})` : "";
                return `[NOTE${target}] ${a.note}`;
              }).join("\n") + "\n"
            : "";

          return `${header}\n${noteBlock}${r.content}`;
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  server.tool(
    "search_symbols",
    "Search for exported symbols by name — functions, classes, types, interfaces, enums. Returns the files that export matching symbols with the defining code snippet. Faster than semantic search when you know the symbol name.",
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
      const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
      const ragDb = getDB(projectDir);

      const results = ragDb.searchSymbols(symbol, exact ?? false, type, top ?? 20);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No exported symbols matching "${symbol}" found.` }],
        };
      }

      const text = results
        .map((r) => {
          const snippet = r.snippet ? `\n${r.snippet.slice(0, 300)}` : "";
          return `${r.path}  •  ${r.symbolName} (${r.symbolType})${snippet}`;
        })
        .join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "write_relevant",
    "Find the best location to insert new content. Given code or documentation you want to add, returns the most semantically appropriate files and insertion points — the chunk after which your content belongs, with an anchor for precise placement.",
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
      const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
      const ragDb = getDB(projectDir);
      const config = await loadConfig(projectDir);

      const topN = top ?? 3;
      const chunks = await searchChunks(
        content,
        ragDb,
        topN * 3,
        threshold ?? 0.3,
        config.hybridWeight
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

      const text = candidates
        .map((r) => {
          const insertAfter = r.entityName
            ? `after \`${r.entityName}\` (chunk ${r.chunkIndex})`
            : `after chunk ${r.chunkIndex}`;
          const anchor = r.content.slice(-150).trim();
          return `[${r.score.toFixed(2)}] ${r.path}\n  Insert ${insertAfter}\n  Anchor: ...${anchor}`;
        })
        .join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
