import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "path";
import { homedir } from "os";
import { RagDB } from "../db";
import { loadConfig } from "../config";
import { indexDirectory } from "../indexing/indexer";
import { startWatcher, type Watcher } from "../indexing/watcher";
import { discoverSessions } from "../conversation/parser";
import { indexConversation, startConversationTail } from "../conversation/indexer";
import { ensureGitignore } from "../cli/setup";
import { registerAllTools } from "../tools";
import { log } from "../utils/log";

// Read version from package.json at module load time
const { version } = await import("../../package.json");

// Lazy-init DB per project directory — keep all open to avoid
// closing a DB that background tasks (auto-index, watcher) still use.
const dbMap = new Map<string, RagDB>();

function getDB(projectDir: string): RagDB {
  const resolved = resolve(projectDir);
  let db = dbMap.get(resolved);
  if (db) return db;
  db = new RagDB(resolved);
  dbMap.set(resolved, db);
  return db;
}

export async function startServer() {
  const server = new McpServer({
    name: "local-rag",
    version,
  });

  // Register all MCP tools
  registerAllTools(server, getDB);

  // Auto-index on startup + start file watcher
  const startupDir = process.env.RAG_PROJECT_DIR || process.cwd();

  const isHomeDirTrap = resolve(startupDir) === homedir();
  if (isHomeDirTrap) {
    process.stderr.write(
      `[local-rag] WARNING: project directory is your home folder (${startupDir}).\n` +
      `[local-rag] Skipping auto-index and file watcher. Set RAG_PROJECT_DIR to your project path.\n` +
      `[local-rag] Example: "env": { "RAG_PROJECT_DIR": "/path/to/your/project" }\n`
    );
  }
  const startupDb = getDB(startupDir);
  const startupConfig = await loadConfig(startupDir);

  let watcher: Watcher | null = null;
  let convWatcher: Watcher | null = null;

  if (!isHomeDirTrap) {
    // Ensure .rag/ is gitignored
    ensureGitignore(startupDir).catch((err) => {
      log.warn(`Failed to update .gitignore: ${err instanceof Error ? err.message : err}`, "server");
    });

    // Index in background — don't block server startup
    indexDirectory(startupDir, startupDb, startupConfig, (msg) => {
      process.stderr.write(`[local-rag] ${msg}\n`);
    }).then((result) => {
      process.stderr.write(
        `[local-rag] Startup index: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned\n`
      );

      // Start watching after initial index completes
      watcher = startWatcher(startupDir, startupDb, startupConfig, (msg) => {
        process.stderr.write(`[local-rag] ${msg}\n`);
      });
    }).catch((err) => {
      log.warn(`Startup indexing failed: ${err instanceof Error ? err.message : err}`, "server");
    });
  }

  // Start conversation tailing — find and tail the current session's JSONL
  const sessions = discoverSessions(startupDir);
  if (sessions.length > 0) {
    // Tail the most recent session (likely the current one)
    const currentSession = sessions[0];
    process.stderr.write(`[local-rag] Indexing conversation: ${currentSession.sessionId.slice(0, 8)}...\n`);

    convWatcher = startConversationTail(
      currentSession.jsonlPath,
      currentSession.sessionId,
      startupDb,
      (msg) => process.stderr.write(`[local-rag] ${msg}\n`)
    );

    // Also index any older sessions that haven't been indexed yet
    for (const session of sessions.slice(1)) {
      const existing = startupDb.getSession(session.sessionId);
      if (!existing || existing.mtime < session.mtime) {
        indexConversation(
          session.jsonlPath,
          session.sessionId,
          startupDb
        ).then((result) => {
          if (result.turnsIndexed > 0) {
            process.stderr.write(
              `[local-rag] Indexed past session ${session.sessionId.slice(0, 8)}...: ${result.turnsIndexed} turns\n`
            );
          }
        }).catch((err) => {
          log.warn(`Failed to index session ${session.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`, "conversation");
        });
      }
    }
  }

  // Graceful shutdown
  function cleanup() {
    process.stderr.write("[local-rag] Shutting down...\n");
    if (watcher) watcher.close();
    if (convWatcher) convWatcher.close();
    for (const d of dbMap.values()) d.close();
    dbMap.clear();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
