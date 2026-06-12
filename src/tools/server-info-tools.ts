import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve, join } from "path";
import { existsSync } from "fs";
import { type GetDB, resolveProject } from "./index";
import { getModelId, getEmbeddingDim } from "../embeddings/embed";
import { readLockHolderPid } from "../control/producer";
import { isPidAlive } from "../utils/index-lock";

export interface ConnectedDBInfo {
  projectDir: string;
  readonly?: boolean;
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
        `  db_dir:      ${process.env.RAG_DB_DIR || `${projectDir}/.mimirs`}`,
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
          lines.push(`  - ${conn.projectDir}${conn.readonly ? "  (query-only)" : ""}`);
          lines.push(`    opened: ${age} ago  |  last_active: ${idle} ago`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  server.tool(
    "connect_repo",
    "Connect another repo's mimirs index for cross-repo queries. Opens it QUERY-ONLY — no indexing, no writes; the repo's own mimirs server keeps it fresh — and reports its status: size, last indexed, embedding model, and whether a live server maintains it. After connecting, pass that repo's path as `directory` to search, read_relevant, and other read tools.",
    {
      directory: z
        .string()
        .describe("Path to the repo to connect. Must already have a mimirs index (.mimirs/index.db)."),
    },
    async ({ directory }) => {
      const resolved = resolve(directory);
      if (!existsSync(resolved)) {
        throw new Error(`Directory does not exist: ${resolved}`);
      }
      const primary = resolve(process.env.RAG_PROJECT_DIR || process.cwd());
      if (resolved === primary) {
        return {
          content: [{
            type: "text" as const,
            text: `${resolved} is this server's primary project — already connected (read-write). No connect needed.`,
          }],
        };
      }
      if (!existsSync(join(resolved, ".mimirs", "index.db"))) {
        throw new Error(
          `No mimirs index at ${resolved} — index that repo from its own side first ` +
          `(run \`mimirs index\` there, or open it in an IDE running mimirs).`,
        );
      }

      // Opens query-only (foreign dir) and validates schema + embedding
      // model/dim compatibility against that repo's own config.
      const db = getDB(resolved);
      const status = db.getStatus();
      const recorded = db.getRecordedEmbeddingModel();

      // Freshness: a live server in that repo keeps its index current via its
      // watcher; without one the index is frozen at last_indexed.
      const holder = readLockHolderPid(resolved);
      const holderAlive = holder !== null && isPidAlive(holder);

      const lines = [
        `Connected ${resolved} (query-only).`,
        ``,
        `  files:        ${status.totalFiles}`,
        `  chunks:       ${status.totalChunks}`,
        `  last_indexed: ${status.lastIndexed ?? "never"}`,
        `  model:        ${recorded.model ?? "(pre-stamp index — assumed current default)"}`,
        ``,
        holderAlive
          ? `  freshness: live mimirs server (pid ${holder}) maintains this index — results stay current.`
          : `  freshness: NO live server in that repo — results are frozen at last_indexed. Refresh by running \`mimirs index\` there.`,
        ``,
        `Use it by passing directory: "${resolved}" to search/read_relevant/etc. Write tools (annotate, checkpoints, index_files without intent) stay with that repo's own server.`,
      ];

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
