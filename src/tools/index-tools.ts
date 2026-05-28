import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { indexDirectory } from "../indexing/indexer";
import { type GetDB, type WriteStatus, resolveProject } from "./index";

export function registerIndexTools(server: McpServer, getDB: GetDB, writeStatus?: WriteStatus) {
  server.tool(
    "index_files",
    "Index files in a directory for semantic search. Without patterns, indexes the project from config and prunes deleted or now-excluded files. With patterns, refreshes or expands only matching files and leaves the rest of the index untouched.",
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
          "Refresh only these include patterns (e.g. ['**/*.md', 'src/**/*.ts']). Does not prune files outside the matched set. To shrink the index, update .mimirs/config.json excludes and call index_files without patterns"
        ),
    },
    async ({ directory, patterns }) => {
      const { projectDir, db: ragDb, config: baseConfig } = await resolveProject(directory, getDB);
      const config = patterns ? { ...baseConfig, include: patterns } : baseConfig;

      let totalFiles = 0;
      let processedFiles = 0;

      const result = await indexDirectory(projectDir, ragDb, config, (msg) => {
        if (!writeStatus) return;

        if (msg === "file:done") {
          processedFiles++;
          if (totalFiles > 0) {
            const pct = Math.round((processedFiles / totalFiles) * 100);
            writeStatus(`${processedFiles}/${totalFiles} files (${pct}%)`);
          }
          return;
        }

        const foundMatch = msg.match(/^Found (\d+) files to index$/);
        if (foundMatch) {
          totalFiles = parseInt(foundMatch[1], 10);
          writeStatus(`0/${totalFiles} files`);
          return;
        }

        if (msg.startsWith("scanning files")) {
          writeStatus(msg);
        }
      }, undefined, { prune: !patterns });

      if (writeStatus) {
        const dbStatus = ragDb.getStatus();
        const lines = [
          `done`,
          `indexed: ${result.indexed}, skipped: ${result.skipped}, pruned: ${result.pruned}`,
          `total files: ${dbStatus.totalFiles}, total chunks: ${dbStatus.totalChunks}`,
        ];
        if (result.locked) lines.splice(1, 0, "mode: query-only (another mimirs process owns indexing)");
        writeStatus(lines.join("\n"));
      }

      const dbStatus = ragDb.getStatus();
      if (result.locked) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Indexing skipped:",
                `  ${result.lockReason ?? "Another mimirs process owns the index lock."}`,
                `  Existing index: ${dbStatus.totalFiles} files, ${dbStatus.totalChunks} chunks`,
                "  This server can still answer queries against the existing index.",
              ].join("\n"),
            },
          ],
        };
      }

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
