import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GetDB, resolveProject } from "./index";
import { getModelId, getEmbeddingDim } from "../embeddings/embed";

export interface ConnectedDBInfo {
  projectDir: string;
  openedAt: Date;
  lastAccessed: Date;
}

export function registerServerInfoTools(
  server: McpServer,
  getDB: GetDB,
  getConnectedDBs?: () => ConnectedDBInfo[],
) {
  server.tool(
    "server_info",
    "Show the current MCP server configuration: resolved project directory, database location, index status, embedding model, active config, and all currently connected databases.",
    {
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ directory }) => {
      const { projectDir, db: ragDb, config } = await resolveProject(directory, getDB);
      const status = ragDb.getStatus();

      const lines: string[] = [
        "## Server",
        `  version:     ${(await import("../../package.json")).version}`,
        `  project_dir: ${projectDir}`,
        `  db_dir:      ${process.env.RAG_DB_DIR || `${projectDir}/.rag`}`,
        `  log_level:   ${process.env.LOG_LEVEL || "warn"}`,
        "",
        "## Index",
        `  files:        ${status.totalFiles}`,
        `  chunks:       ${status.totalChunks}`,
        `  last_indexed: ${status.lastIndexed ?? "never"}`,
        "",
        "## Embedding",
        `  model: ${getModelId()}`,
        `  dim:   ${getEmbeddingDim()}`,
        "",
        "## Config (.mimirs/config.json)",
        `  chunk_size:      ${config.chunkSize}`,
        `  chunk_overlap:   ${config.chunkOverlap}`,
        `  hybrid_weight:   ${config.hybridWeight}`,
        `  search_top_k:    ${config.searchTopK}`,
        `  incremental:     ${config.incrementalChunks}`,
        `  include:         ${config.include.length} patterns`,
        `  exclude:         ${config.exclude.length} patterns`,
      ];

      if (config.indexBatchSize) lines.push(`  index_batch:     ${config.indexBatchSize}`);
      if (config.indexThreads) lines.push(`  index_threads:   ${config.indexThreads}`);

      // Connected databases
      if (getConnectedDBs) {
        const connections = getConnectedDBs();
        lines.push("", `## Connected Databases (${connections.length})`);
        for (const conn of connections) {
          const age = formatDuration(Date.now() - conn.openedAt.getTime());
          const idle = formatDuration(Date.now() - conn.lastAccessed.getTime());
          lines.push(`  - ${conn.projectDir}`);
          lines.push(`    opened: ${age} ago  |  last_active: ${idle} ago`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
