import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { registerServerInfoTools, type ConnectedDBInfo } from "./server-info-tools";

export type GetDB = (dir: string) => RagDB;
export type WriteStatus = (status: string) => void;

/** Resolve the project directory, database, and config from an optional directory param. */
export async function resolveProject(
  directory: string | undefined,
  getDB: GetDB
): Promise<{ projectDir: string; db: RagDB; config: RagConfig }> {
  const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
  const config = await loadConfig(projectDir);
  applyEmbeddingConfig(config);
  return { projectDir, db: getDB(projectDir), config };
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
  registerServerInfoTools(server, getDB, getConnectedDBs);
}
