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
let initError: string | null = null;

function getDB(projectDir: string): RagDB {
  if (initError) {
    throw new Error(initError);
  }
  const resolved = resolve(projectDir);
  let db = dbMap.get(resolved);
  if (db) return db;
  db = new RagDB(resolved);
  dbMap.set(resolved, db);
  return db;
}

/** Write crash details to .rag/server-error.log so they're visible outside stderr */
function writeStartupError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : "(no stack)";
  const projectDir = process.env.RAG_PROJECT_DIR || process.cwd();
  try {
    const ragDir = join(projectDir, ".rag");
    mkdirSync(ragDir, { recursive: true });
    writeFileSync(
      join(ragDir, "server-error.log"),
      [
        `local-rag server failed at ${new Date().toISOString()}`,
        ``,
        `Error: ${msg}`,
        ``,
        stack,
        ``,
        `To diagnose: bunx @winci/local-rag doctor`,
      ].join("\n")
    );
  } catch {
    // Best-effort
  }
  log.error(`Startup failed: ${msg}`, "server");
}

export async function startServer() {
  let server: McpServer;
  try {
    server = new McpServer({
      name: "local-rag",
      version,
    });

    // Register all MCP tools
    registerAllTools(server, getDB);
  } catch (err) {
    // If we crash before connecting transport, the MCP client just sees
    // "Connection closed" with no details. Write diagnostics to a file.
    writeStartupError(err);
    throw err;
  }

  // Connect transport IMMEDIATELY so the MCP client's `initialize` handshake
  // is answered before any slow startup work (config I/O, session discovery,
  // indexing).  Without this, the client may time out, close the pipes, and
  // the server's subsequent stderr writes hit EPIPE.
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    writeStartupError(err);
    throw err;
  }

  // Auto-index on startup + start file watcher
  const startupDir = process.env.RAG_PROJECT_DIR || process.cwd();

  const dirCheck = checkIndexDir(startupDir);
  const isHomeDirTrap = !dirCheck.safe;
  if (isHomeDirTrap) {
    log.warn(`${dirCheck.reason} — skipping auto-index and file watcher`, "dir-guard");
  }

  // Preflight: verify DB can be created (catches missing Homebrew SQLite on macOS)
  let startupDb: ReturnType<typeof getDB>;
  try {
    startupDb = getDB(startupDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fix = msg.includes("brew install sqlite")
      ? `Fix: run "brew install sqlite" and restart your editor.`
      : msg.includes("EROFS") || msg.includes("EACCES")
        ? `Fix: set RAG_DB_DIR to a writable directory in your MCP config.`
        : `Check the local-rag README for setup instructions.`;

    initError = `${msg}\n\n${fix}`;
    log.error(`FATAL: ${msg} — ${fix}`, "db");

    // Write the error to indexing-status so it's visible to the user/IDE
    const ragDir = join(startupDir, ".rag");
    try {
      mkdirSync(ragDir, { recursive: true });
      writeFileSync(join(ragDir, "indexing-status"), [
        `error`,
        `version: ${version}`,
        `failed: ${new Date().toISOString()}`,
        msg,
        ``,
        fix,
      ].join("\n"));
    } catch (statusErr) {
      log.warn(`Could not write indexing-status: ${statusErr instanceof Error ? statusErr.message : statusErr}`, "status");
    }

    // Server is already connected — just return and let tool calls
    // hit the initError guard in getDB()
    return;
  }

  const startupConfig = await loadConfig(startupDir);

  let watcher: Watcher | null = null;
  let convWatcher: Watcher | null = null;

  // Define statusPath early so writeStatus can use it immediately
  const ragDir = join(startupDir, ".rag");
  const statusPath = !isHomeDirTrap ? join(ragDir, "indexing-status") : null;
  const writeStatus = (status: string) => {
    if (!statusPath) return;
    try {
      mkdirSync(ragDir, { recursive: true });
      writeFileSync(statusPath, status);
    } catch (statusErr) {
      log.warn(`Could not write indexing-status: ${statusErr instanceof Error ? statusErr.message : statusErr}`, "status");
    }
  };

  // Write status immediately so the file exists as soon as the MCP starts
  writeStatus(`starting\nversion: ${version}\nstarted: ${new Date().toISOString()}`);

  if (!isHomeDirTrap) {
    // Ensure .rag/ is gitignored
    ensureGitignore(startupDir).catch((err) => {
      log.warn(`Failed to update .gitignore: ${err instanceof Error ? err.message : err}`, "gitignore");
    });

    // Index in background — don't block server startup
    let totalFiles = 0;
    let processedFiles = 0;

    indexDirectory(startupDir, startupDb, startupConfig, (msg, progressOpts) => {
      if (msg === "file:done") {
        processedFiles++;
        if (totalFiles > 0) {
          const pct = Math.round((processedFiles / totalFiles) * 100);
          writeStatus(`${processedFiles}/${totalFiles} files (${pct}%)`);
        }
        return;
      }

      log.debug(msg, "indexer");

      // File scanning progress
      if (msg.startsWith("scanning files")) {
        writeStatus(msg);
        return;
      }

      // Model loading messages from embedder
      if (msg.startsWith("Loading embedding model") || msg.startsWith("Retrying model load")) {
        writeStatus(msg);
        return;
      }
      if (msg === "Model loaded") return;

      const foundMatch = msg.match(/^Found (\d+) files to index$/);
      if (foundMatch) {
        totalFiles = parseInt(foundMatch[1], 10);
        writeStatus(`0/${totalFiles} files`);
        return;
      }

      // Show per-file activity so status doesn't stay stuck on "0/N"
      if (totalFiles > 0 && !progressOpts?.transient) {
        const pct = Math.round((processedFiles / totalFiles) * 100);
        writeStatus(`${processedFiles}/${totalFiles} files (${pct}%)\n${msg}`);
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
      log.debug(`Startup index: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`, "indexer");

      // Start watching after initial index completes
      watcher = startWatcher(startupDir, startupDb, startupConfig, (msg) => {
        log.debug(msg, "watcher");
      });
    }).catch((err) => {
      writeStatus(`error\nversion: ${version}\nfailed: ${new Date().toISOString()}\n${err instanceof Error ? err.message : err}`);
      log.warn(`Startup indexing failed: ${err instanceof Error ? err.message : err}`, "indexer");
    });
  }

  // Start conversation tailing — find and tail the current session's JSONL
  const sessions = discoverSessions(startupDir);
  if (sessions.length > 0) {
    // Tail the most recent session (likely the current one)
    const currentSession = sessions[0];
    log.debug(`Indexing conversation: ${currentSession.sessionId.slice(0, 8)}...`, "conversation");

    convWatcher = startConversationTail(
      currentSession.jsonlPath,
      currentSession.sessionId,
      startupDb,
      (msg) => log.debug(msg, "conversation")
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
            log.debug(`Indexed past session ${session.sessionId.slice(0, 8)}...: ${result.turnsIndexed} turns`, "conversation");
          }
        }).catch((err) => {
          log.warn(`Failed to index session ${session.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`, "conversation");
        });
      }
    }
  }

  // Write to indexing-status on abnormal exit so the file doesn't stay stuck on "starting"
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
    } catch (statusErr) {
      log.warn(`Could not write exit status: ${statusErr instanceof Error ? statusErr.message : statusErr}`, "status");
    }
  }

  // Graceful shutdown
  function cleanup(reason: string = "shutdown") {
    writeExitStatus(reason);
    log.debug("Shutting down...", "shutdown");
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
    log.error(`Uncaught exception: ${err.message}`, "uncaught");
    cleanup(`uncaught exception: ${err.message}\n${err.stack ?? "(no stack)"}`);
  });
  process.on("unhandledRejection", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "(no stack)";
    log.error(`Unhandled rejection: ${msg}`, "uncaught");
    cleanup(`unhandled rejection: ${msg}\n${stack}`);
  });

}
