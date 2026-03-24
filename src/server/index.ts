import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve, join } from "path";
import { checkIndexDir } from "../utils/dir-guard";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
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

  const dirCheck = checkIndexDir(startupDir);
  const isHomeDirTrap = !dirCheck.safe;
  if (isHomeDirTrap) {
    process.stderr.write(
      `[local-rag] WARNING: ${dirCheck.reason}\n` +
      `[local-rag] Skipping auto-index and file watcher.\n`
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
    let totalFiles = 0;
    let processedFiles = 0;

    const ragDir = join(startupDir, ".rag");
    const writeStatus = (status: string) => {
      try { mkdirSync(ragDir, { recursive: true }); writeFileSync(statusPath!, status); } catch {}
    };
    writeStatus("starting");
    indexDirectory(startupDir, startupDb, startupConfig, (msg) => {
      if (msg === "file:done") {
        processedFiles++;
        if (totalFiles > 0) {
          const pct = Math.round((processedFiles / totalFiles) * 100);
          writeStatus(`${processedFiles}/${totalFiles} files (${pct}%)`);
        }
        return;
      }

      process.stderr.write(`[local-rag] ${msg}\n`);

      const foundMatch = msg.match(/^Found (\d+) files to index$/);
      if (foundMatch) {
        totalFiles = parseInt(foundMatch[1], 10);
        writeStatus(`0/${totalFiles} files`);
      }
    }).then((result) => {
      const dbStatus = startupDb.getStatus();
      const doneStatus = [
        `done`,
        `version: ${version}`,
        `finished: ${new Date().toISOString()}`,
        `indexed: ${result.indexed}, skipped: ${result.skipped}, pruned: ${result.pruned}`,
        `total files: ${dbStatus.totalFiles}, total chunks: ${dbStatus.totalChunks}`,
      ].join("\n");
      writeStatus(doneStatus);
      process.stderr.write(
        `[local-rag] Startup index: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned\n`
      );

      // Start watching after initial index completes
      watcher = startWatcher(startupDir, startupDb, startupConfig, (msg) => {
        process.stderr.write(`[local-rag] ${msg}\n`);
      });
    }).catch((err) => {
      writeStatus(`error\nversion: ${version}\nfailed: ${new Date().toISOString()}\n${err instanceof Error ? err.message : err}`);
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

  // Write to indexing-status on abnormal exit so the file doesn't stay stuck on "starting"
  const statusPath = !isHomeDirTrap ? join(startupDir, ".rag", "indexing-status") : null;
  function writeExitStatus(reason: string) {
    if (!statusPath) return;
    try {
      // Only overwrite if indexing hadn't finished (file still exists and doesn't start with "done")
      const current = readFileSync(statusPath, "utf8");
      if (current.startsWith("done") || current.startsWith("error")) return;
      writeFileSync(statusPath, [
        `interrupted`,
        `version: ${version}`,
        `stopped: ${new Date().toISOString()}`,
        `reason: ${reason}`,
      ].join("\n"));
    } catch {}
  }

  // Graceful shutdown
  function cleanup(reason: string = "shutdown") {
    writeExitStatus(reason);
    process.stderr.write("[local-rag] Shutting down...\n");
    if (watcher) watcher.close();
    if (convWatcher) convWatcher.close();
    for (const d of dbMap.values()) d.close();
    dbMap.clear();
    process.exit(0);
  }

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGHUP", () => cleanup("SIGHUP"));
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[local-rag] Uncaught exception: ${err.message}\n`);
    cleanup(`uncaught exception: ${err.message}`);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[local-rag] Unhandled rejection: ${err instanceof Error ? err.message : err}\n`);
    cleanup(`unhandled rejection: ${err instanceof Error ? err.message : err}`);
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
