import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "path";
import { existsSync } from "fs";
import { RagDB } from "../db";
import { loadConfig, applyEmbeddingConfig, type RagConfig } from "../config";
import { registerSearchTools } from "./search";
import { registerIndexTools } from "./index-tools";
import { registerGraphTools } from "./graph-tools";
import { registerConversationTools } from "./conversation-tools";
import { registerCheckpointTools } from "./checkpoint-tools";
import { registerAnnotationTools } from "./annotation-tools";
import { registerAnalyticsTools } from "./analytics-tools";
import { registerGitTools } from "./git-tools";
import { registerGitHistoryTools } from "./git-history-tools";
import { registerServerInfoTools, type ConnectedDBInfo } from "./server-info-tools";
import { registerWikiTools } from "./wiki-tools";

export type GetDB = (dir: string) => RagDB;
export type WriteStatus = (status: string) => void;

/** Resolve the project directory, database, and config from an optional directory param. */
export async function resolveProject(
  directory: string | undefined,
  getDB: GetDB
): Promise<{ projectDir: string; db: RagDB; config: RagConfig }> {
  const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();

  // Resolve to absolute and verify it doesn't escape via path traversal
  const resolved = resolve(projectDir);
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }

  const config = await loadConfig(resolved);
  applyEmbeddingConfig(config);
  return { projectDir: resolved, db: getDB(resolved), config };
}

export function registerAllTools(
  server: McpServer,
  getDB: (dir: string) => RagDB,
  getConnectedDBs?: () => ConnectedDBInfo[],
  writeStatus?: WriteStatus,
) {
  registerSearchTools(server, getDB);
  registerIndexTools(server, getDB, writeStatus);
  registerGraphTools(server, getDB);
  registerConversationTools(server, getDB);
  registerCheckpointTools(server, getDB);
  registerAnnotationTools(server, getDB);
  registerAnalyticsTools(server, getDB);
  registerGitTools(server, getDB);
  registerGitHistoryTools(server, getDB);
  registerServerInfoTools(server, getDB, getConnectedDBs);
  registerWikiTools(server, getDB);
}
