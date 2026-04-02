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
// Cleanup happens on process exit (signals + stdin EOF).
interface DBEntry {
  db: RagDB;
  openedAt: Date;
  lastAccessed: Date;
}
const dbMap = new Map<string, DBEntry>();
// Permanent (non-retryable) init errors — filesystem permission failures, missing
// native libs, etc. Transient errors like "database is locked" are NOT cached here
// so the next tool call can retry.
let permanentError: string | null = null;

function getDB(projectDir: string): RagDB {
  if (permanentError) {
    throw new Error(permanentError);
  }

  const resolved = resolve(projectDir);
  let entry = dbMap.get(resolved);

  if (entry) {
    entry.lastAccessed = new Date();
    return entry.db;
  }

  const db = new RagDB(resolved);
  dbMap.set(resolved, { db, openedAt: new Date(), lastAccessed: new Date() });

  return db;
}

/** Returns info about all currently open database connections. */
export function getConnectedDBs(): Array<{ projectDir: string; openedAt: Date; lastAccessed: Date }> {
  return Array.from(dbMap.entries()).map(([dir, entry]) => ({
    projectDir: dir,
    openedAt: entry.openedAt,
    lastAccessed: entry.lastAccessed,
  }));
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
  // Write "starting" status as the very first thing — overwrites any stale
  // "interrupted" from a previous instance before we do anything else.
  const startupDir = process.env.RAG_PROJECT_DIR || process.cwd();
  const dirCheck = checkIndexDir(startupDir);
  const isHomeDirTrap = !dirCheck.safe;
  const ragDir = join(startupDir, ".rag");
  const statusPath = !isHomeDirTrap ? join(ragDir, "status") : null;
  const instanceId = `pid:${process.pid}`;

  let shuttingDown = false;

  const writeStatus = (status: string) => {
    if (!statusPath || shuttingDown) return;
    try {
      mkdirSync(ragDir, { recursive: true });
      writeFileSync(statusPath, `${status}\n${instanceId}`);
    } catch (statusErr) {
      log.warn(`Could not write status: ${statusErr instanceof Error ? statusErr.message : statusErr}`, "status");
    }
  };

  writeStatus(`starting\nversion: ${version}\nstarted: ${new Date().toISOString()}`);

  // Register shutdown handlers early so any crash during startup is recorded.
  // The cleanup targets (watcher, convWatcher) start as null and get assigned
  // later — this is safe because cleanup just skips null values.
  let watcher: Watcher | null = null;
  let convWatcher: Watcher | null = null;

  function writeExitStatus(reason: string) {
    if (!statusPath) return;
    try {
      const current = readFileSync(statusPath, "utf8");
      // Only overwrite if this instance owns the status file.
      // Another instance may have started and written its own status —
      // clobbering it with "interrupted" would be incorrect.
      if (!current.includes(instanceId)) return;
      if (current.startsWith("done") || current.startsWith("error")) return;
      writeFileSync(statusPath, [
        `interrupted`,
        `version: ${version}`,
        `stopped: ${new Date().toISOString()}`,
        `reason: ${reason}`,
        instanceId,
      ].join("\n"));
    } catch (statusErr) {
      log.warn(`Could not write exit status: ${statusErr instanceof Error ? statusErr.message : statusErr}`, "status");
    }
  }

  function cleanup(reason: string = "shutdown") {
    shuttingDown = true;
    writeExitStatus(reason);
    log.debug("Shutting down...", "shutdown");
    if (watcher) watcher.close();
    if (convWatcher) convWatcher.close();
    for (const entry of dbMap.values()) entry.db.close();
    dbMap.clear();
    process.exit(0);
  }

  // Register signal/stdin handlers immediately so crashes during startup
  // still write "interrupted" instead of leaving stale status.
  process.stdin.on("end", () => {
    log.debug("stdin closed (IDE window likely closed)", "shutdown");
    cleanup("stdin closed");
  });
  process.stdin.on("error", () => {
    cleanup("stdin error");
  });
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

  if (isHomeDirTrap) {
    log.warn(`${dirCheck.reason} — skipping auto-index and file watcher`, "dir-guard");
  }

  writeStatus(`starting\nversion: ${version}\nphase: creating server`);

  let server: McpServer;
  try {
    server = new McpServer({
      name: "local-rag",
      version,
    });

    // Register all MCP tools
    registerAllTools(server, getDB, getConnectedDBs, writeStatus);
    writeStatus(`starting\nversion: ${version}\nphase: tools registered`);
  } catch (err) {
    // If we crash before connecting transport, the MCP client just sees
    // "Connection closed" with no details. Write diagnostics to a file.
    writeStartupError(err);
    writeStatus(`error\nversion: ${version}\nphase: tool registration failed\n${err instanceof Error ? err.message : err}`);
    throw err;
  }

  // Connect transport IMMEDIATELY so the MCP client's `initialize` handshake
  // is answered before any slow startup work (config I/O, session discovery,
  // indexing).  Without this, the client may time out, close the pipes, and
  // the server's subsequent stderr writes hit EPIPE.
  const transport = new StdioServerTransport();
  try {
    writeStatus(`starting\nversion: ${version}\nphase: connecting transport`);
    await server.connect(transport);
    writeStatus(`starting\nversion: ${version}\nphase: transport connected`);
  } catch (err) {
    writeStartupError(err);
    writeStatus(`error\nversion: ${version}\nphase: transport failed\n${err instanceof Error ? err.message : err}`);
    throw err;
  }

  // Preflight: verify DB can be created (catches missing Homebrew SQLite on macOS)
  let startupDb: ReturnType<typeof getDB>;
  try {
    startupDb = getDB(startupDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTransient = msg.includes("database is locked") || msg.includes("SQLITE_BUSY");
    const fix = msg.includes("brew install sqlite")
      ? `Fix: run "brew install sqlite" and restart your editor.`
      : msg.includes("EROFS") || msg.includes("EACCES")
        ? `Fix: set RAG_DB_DIR to a writable directory in your MCP config.`
        : `Check the local-rag README for setup instructions.`;

    if (isTransient) {
      // Transient lock — another process was briefly holding the DB.
      // Don't cache the error; the next tool call will retry getDB().
      log.warn(`Startup DB open failed (transient, will retry on next tool call): ${msg}`, "db");
    } else {
      // Permanent failure — cache so every tool call gets a clear message
      permanentError = `${msg}\n\n${fix}`;
      log.error(`FATAL: ${msg} — ${fix}`, "db");
    }

    // Write the error to status so it's visible to the user/IDE
    try {
      mkdirSync(ragDir, { recursive: true });
      writeFileSync(join(ragDir, "status"), [
        isTransient ? `starting` : `error`,
        `version: ${version}`,
        `failed: ${new Date().toISOString()}`,
        msg,
        ``,
        isTransient ? `Will retry on next tool call` : fix,
      ].join("\n"));
    } catch (statusErr) {
      log.warn(`Could not write status: ${statusErr instanceof Error ? statusErr.message : statusErr}`, "status");
    }

    // For permanent errors, tool calls hit the permanentError guard.
    // For transient errors, tool calls retry getDB() which may succeed.
    // Either way, skip startup indexing — it requires an open DB.
    return;
  }

  const startupConfig = await loadConfig(startupDir);

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
        // Update status file so IDE/client sees watcher activity
        const dbStatus = startupDb.getStatus();
        writeStatus([
          `done`,
          `version: ${version}`,
          `finished: ${new Date().toISOString()}`,
          `total files: ${dbStatus.totalFiles}, total chunks: ${dbStatus.totalChunks}`,
          `watcher: ${msg}`,
        ].join("\n"));
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

}
