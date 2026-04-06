import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AnnotationRow } from "../db";
import { embed } from "../embeddings/embed";
import { type GetDB, resolveProject } from "./index";

export function registerAnnotationTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "annotate",
    "Attach a persistent note to a file or symbol that surfaces inline in future read_relevant results. Call this immediately when you encounter: a known bug or race condition, fragile code that shouldn't be changed yet, a non-obvious architectural constraint, or a workaround that needs context. Calling again with the same path+symbol updates the existing note.",
    {
      path: z.string().describe("File path (relative to project root) the note applies to"),
      note: z.string().describe("The note text"),
      symbol: z
        .string()
        .optional()
        .describe("Symbol name (function, class, etc.) the note applies to — omit for file-level notes"),
      author: z
        .string()
        .optional()
        .describe("Label for who wrote the note — e.g. 'agent', 'human' (default: 'agent')"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ path, note, symbol, author, directory }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);

      const embText = symbol ? `${symbol}: ${note}` : note;
      const embedding = await embed(embText);
      const id = ragDb.upsertAnnotation(path, note, embedding, symbol ?? null, author ?? "agent");

      const target = symbol ? `${path}  •  ${symbol}` : path;
      return {
        content: [{ type: "text" as const, text: `Annotation #${id} saved for ${target}` }],
      };
    }
  );

  server.tool(
    "get_annotations",
    "Retrieve persistent notes attached to files or symbols. Pass path to get all notes for a file. Pass query to search semantically across all annotations. Pass both to filter by file and rank by relevance.",
    {
      path: z
        .string()
        .optional()
        .describe("File path to retrieve annotations for"),
      query: z
        .string()
        .optional()
        .describe("Semantic search query — finds annotations by meaning across all files"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ path, query, directory }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);

      let results: AnnotationRow[];
      if (query) {
        const embedding = await embed(query);
        const searchResults = ragDb.searchAnnotations(embedding, 10);
        results = path ? searchResults.filter((r) => r.path === path) : searchResults;
      } else if (path) {
        results = ragDb.getAnnotations(path);
      } else {
        results = ragDb.getAnnotations();
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No annotations found." }],
        };
      }

      const text = results
        .map((r) => {
          const target = r.symbolName ? `${r.path}  •  ${r.symbolName}` : r.path;
          const authorStr = r.author ? ` [${r.author}]` : "";
          return `#${r.id}  ${target}${authorStr}\n  ${r.note}\n  (${r.updatedAt})`;
        })
        .join("\n\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
