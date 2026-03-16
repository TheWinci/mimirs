import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { indexDirectory } from "../indexing/indexer";
import { type GetDB, resolveProject } from "./index";

export function registerIndexTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "index_files",
    "Index files in a directory for semantic search. Skips unchanged files and prunes deleted ones.",
    {
      directory: z
        .string()
        .optional()
        .describe(
          "Directory to index. Defaults to RAG_PROJECT_DIR env or cwd"
        ),
      patterns: z
        .array(z.string())
        .optional()
        .describe(
          "Override include patterns (e.g. ['**/*.md', '**/*.ts']). Uses .rag/config.json if not provided"
        ),
    },
    async ({ directory, patterns }) => {
      const { projectDir, db: ragDb, config: baseConfig } = await resolveProject(directory, getDB);
      const config = patterns ? { ...baseConfig, include: patterns } : baseConfig;

      const result = await indexDirectory(projectDir, ragDb, config);

      return {
        content: [
          {
            type: "text" as const,
            text: `Indexing complete:\n  Indexed: ${result.indexed}\n  Skipped (unchanged): ${result.skipped}\n  Pruned (deleted): ${result.pruned}${result.errors.length > 0 ? `\n  Errors: ${result.errors.join("; ")}` : ""}`,
          },
        ],
      };
    }
  );

  server.tool(
    "index_status",
    "Show the current state of the RAG index for a project directory.",
    {
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ directory }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);
      const status = ragDb.getStatus();

      return {
        content: [
          {
            type: "text" as const,
            text: `Index status:\n  Files: ${status.totalFiles}\n  Chunks: ${status.totalChunks}\n  Last indexed: ${status.lastIndexed || "never"}`,
          },
        ],
      };
    }
  );

  server.tool(
    "remove_file",
    "Remove a specific file from the RAG index.",
    {
      path: z.string().describe("Absolute path of the file to remove"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ path, directory }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);
      const removed = ragDb.removeFile(path);

      return {
        content: [
          {
            type: "text" as const,
            text: removed
              ? `Removed ${path} from index`
              : `${path} was not in the index`,
          },
        ],
      };
    }
  );
}
