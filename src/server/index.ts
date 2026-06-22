import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve, join } from "path";
import { checkIndexDir } from "../utils/dir-guard";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { RagDB } from "../db";
import { loadConfig, applyEmbeddingConfigFromDisk } from "../config";
import { indexDirectory } from "../indexing/indexer";
import { startWatcher, type Watcher } from "../indexing/watcher";
import { getTranscriptsDir } from "../conversation/parser";
import { startConversationFolderWatch, type ConversationWatcher } from "../conversation/indexer";
import { indexGitHistory } from "../git/indexer";
import { startCommandDropbox } from "../control/consumer";
import { ensureGitignore } from "../cli/setup";
import { registerAllTools } from "../tools";
import { log } from "../utils/log";
import { tryAcquireIndexLock, type IndexLock } from "../utils/index-lock";

// Read version from package.json at module load time
const { version } = await import("../../package.json");

// Lazy-init DB per project directory — keep all open to avoid
// closing a DB that background tasks (auto-index, watcher) still use.
// Cleanup happens on process exit (signals + stdin EOF).
interface DBEntry {
  db: RagDB;
  readonly: boolean;
  openedAt: Date;
  lastAccessed: Date;
}
const dbMap = new Map<string, DBEntry>();
// Permanent (non-retryable) init errors — filesystem permission failures, missing
// native libs, etc. Transient errors like "database is locked" are NOT cached here
// so the next tool call can retry.
let permanentError: string | null = null;

// Cap on simultaneously open project DBs. Entries were never evicted, so every
// distinct `directory` a tool was called with kept a SQLite handle for the
// process lifetime. Eviction rules: never the primary project, and never an
// entry accessed within IDLE_MS — `lastAccessed` only updates on getDB() hits,
// so a long-running operation (a minutes-long index_files on a secondary dir)
// would otherwise look LRU and have its handle closed mid-use.
const DB_MAP_MAX = 8;
const DB_IDLE_MS = 10 * 60 * 1000;

function getDB(projectDir: string, opts?: { writable?: boolean }): RagDB {
  if (permanentError) {
    throw new Error(permanentError);
  }

  const resolved = resolve(projectDir);
  const primary = resolve(process.env.RAG_PROJECT_DIR || process.cwd());
  // Foreign repos attach QUERY-ONLY by default: their own server owns the
  // index file, and a writable open would create/migrate/stamp it under that
  // writer. Only an explicit index request (index_files via allowCreate)
  // opens a foreign dir writable. The primary project is always writable.
  const wantWritable = resolved === primary || opts?.writable === true;
  let entry = dbMap.get(resolved);

  if (entry) {
    if (wantWritable && entry.readonly) {
      // Explicit index request on a query-only attach — upgrade the handle.
      try { entry.db.close(); } catch { /* already closed */ }
      dbMap.delete(resolved);
    } else {
      entry.lastAccessed = new Date();
      return entry.db;
    }
  }

  if (dbMap.size >= DB_MAP_MAX) {
    const primary = resolve(process.env.RAG_PROJECT_DIR || process.cwd());
    const now = Date.now();
    let lruKey: string | null = null;
    let lruTime = Infinity;
    for (const [dir, e] of dbMap) {
      if (dir === primary) continue;
      const last = e.lastAccessed.getTime();
      if (now - last < DB_IDLE_MS) continue; // possibly mid-operation
      if (last < lruTime) {
        lruTime = last;
        lruKey = dir;
      }
    }
    if (lruKey) {
      try { dbMap.get(lruKey)!.db.close(); } catch { /* already closed */ }
      dbMap.delete(lruKey);
      log.debug(`Evicted idle DB handle for ${lruKey}`, "server");
    }
    // No evictable entry → exceed the soft cap rather than close a busy DB.
  }

  const db = new RagDB(resolved, undefined, wantWritable ? undefined : { readonly: true });
  dbMap.set(resolved, { db, readonly: !wantWritable, openedAt: new Date(), lastAccessed: new Date() });

  return db;
}

/** Returns info about all currently open database connections. */
export function getConnectedDBs(): Array<{ projectDir: string; readonly: boolean; openedAt: Date; lastAccessed: Date }> {
  return Array.from(dbMap.entries()).map(([dir, entry]) => ({
    projectDir: dir,
    readonly: entry.readonly,
    openedAt: entry.openedAt,
    lastAccessed: entry.lastAccessed,
  }));
}

/** Write crash details to .mimirs/server-error.log so they're visible outside stderr */
function writeStartupError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : "(no stack)";
  const projectDir = process.env.RAG_PROJECT_DIR || process.cwd();
  try {
    const ragDir = join(projectDir, ".mimirs");
    mkdirSync(ragDir, { recursive: true });
    writeFileSync(
      join(ragDir, "server-error.log"),
      [
        `mimirs server failed at ${new Date().toISOString()}`,
        ``,
        `Error: ${msg}`,
        ``,
        stack,
        ``,
        `To diagnose: bunx mimirs doctor`,
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
  // resolve(): an unresolved RAG_PROJECT_DIR (trailing slash, relative,
  // symlink alias) flowed into belongsToProject's exact-string cwd comparison
  // and silently classified every transcript "foreign".
  const startupDir = resolve(process.env.RAG_PROJECT_DIR || process.cwd());
  const dirCheck = checkIndexDir(startupDir);
  const isHomeDirTrap = !dirCheck.safe;
  const ragDir = join(startupDir, ".mimirs");
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

  // Extra lines appended to every "done" status block so the status file
  // reflects the two background indexes besides the file index:
  //   - git: auto-index on/off (config.autoIndexGit) plus the newest indexed
  //     commit (short hash + title), or "not indexed". When off, git history is
  //     indexed only on demand (CLI `history index` / drop-box `index.git`).
  //   - conversations: the transcripts folder the server live-watches.
  // Reads startupConfig, which is assigned before this helper is ever called.
  const indexStatusLines = (db: ReturnType<typeof getDB>): string[] => {
    const lines: string[] = [];
    const mode = startupConfig.autoIndexGit ? "auto-index on" : "auto-index off";
    try {
      const git = db.getGitHistoryStatus();
      if (git.totalCommits > 0 && git.lastCommitHash) {
        const short = git.lastCommitHash.slice(0, 7);
        const title = (git.lastCommitMessage ?? "").split("\n")[0].slice(0, 72);
        lines.push(`git: ${mode}, ${git.totalCommits} commits, last indexed ${short} ${title}`.trimEnd());
      } else {
        lines.push(`git: ${mode}, not indexed`);
      }
    } catch {
      // git_commits table may not exist on a fresh DB — skip the git line.
    }
    lines.push(`conversations: watching ${getTranscriptsDir(startupDir)}`);
    return lines;
  };

  writeStatus(`starting\nversion: ${version}\nstarted: ${new Date().toISOString()}`);

  // Register shutdown handlers early so any crash during startup is recorded.
  // The cleanup targets (watcher, convWatcher) start as null and get assigned
  // later — this is safe because cleanup just skips null values.
  let watcher: Watcher | null = null;
  let convWatcher: ConversationWatcher | null = null;
  let cmdWatcher: Watcher | null = null;
  let indexLock: IndexLock | null = null;
  let lockRetryTimer: ReturnType<typeof setInterval> | null = null;
  let ppidWatchdog: ReturnType<typeof setInterval> | null = null;

  function writeExitStatus(reason: string) {
    if (!statusPath) return;
    try {
      const current = readFileSync(statusPath, "utf8");
      // Only overwrite if this instance owns the status file (exact line
      // match — a substring test let "pid:123" claim "pid:1234"'s file).
      // Another instance may have started and written its own status —
      // clobbering it with "interrupted" would be incorrect.
      if (!current.split("\n").some((l) => l.trim() === instanceId)) return;
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

  function cleanup(reason: string = "shutdown", exitCode = 0) {
    shuttingDown = true;
    if (lockRetryTimer) clearInterval(lockRetryTimer);
    if (ppidWatchdog) clearInterval(ppidWatchdog);
    writeExitStatus(reason);
    log.debug("Shutting down...", "shutdown");
    if (watcher) watcher.close();
    if (convWatcher) convWatcher.close();
    if (cmdWatcher) cmdWatcher.close();
    if (indexLock) indexLock.release();
    for (const entry of dbMap.values()) entry.db.close();
    dbMap.clear();
    process.exit(exitCode);
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
  // Crashes exit non-zero so the supervising MCP client sees a failure, not a
  // clean shutdown (exit 0 here masked every crash from process monitors).
  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}`, "uncaught");
    cleanup(`uncaught exception: ${err.message}\n${err.stack ?? "(no stack)"}`, 1);
  });
  process.on("unhandledRejection", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "(no stack)";
    log.error(`Unhandled rejection: ${msg}`, "uncaught");
    cleanup(`unhandled rejection: ${msg}\n${stack}`, 1);
  });

  // Parent-death watchdog. The IDE/MCP client that spawned us normally closes
  // our stdin on shutdown, firing the "end" handler above. But a hard IDE
  // restart can reparent us to init (ppid -> 1) WITHOUT closing stdin, leaving
  // an orphaned server that keeps holding the index lock — which then blocks
  // the freshly-spawned server from ever indexing. Detect the reparent (our
  // original parent's PID changed) and exit so the lock is released.
  const initialPpid = process.ppid;
  ppidWatchdog = setInterval(() => {
    if (shuttingDown) return;
    if (process.ppid !== initialPpid) {
      log.debug(`Parent exited (ppid ${initialPpid} -> ${process.ppid}) — shutting down orphan`, "shutdown");
      cleanup("parent exited");
    }
  }, 5_000);
  if (typeof ppidWatchdog.unref === "function") ppidWatchdog.unref();

  if (isHomeDirTrap) {
    log.warn(`${dirCheck.reason} — skipping auto-index and file watcher`, "dir-guard");
  }

  writeStatus(`starting\nversion: ${version}\nphase: creating server`);

  let server: McpServer;
  try {
    server = new McpServer({
      name: "mimirs",
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
        : `Check the mimirs README for setup instructions.`;

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

  // Eagerly warm-attach configured external repos (query-only). Best-effort:
  // a moved repo or incompatible index warns and is skipped — never fails
  // startup. Every instance attaches (read handles need no lock), so the
  // config problem surfaces at startup instead of on the first cross-repo query.
  for (const repo of startupConfig.connectedRepos) {
    const repoDir = resolve(startupDir, repo.path);
    try {
      getDB(repoDir);
      log.debug(`Connected repo ${repo.alias ?? repo.path} (query-only): ${repoDir}`, "connect");
    } catch (err) {
      log.warn(
        `connectedRepos: could not attach "${repo.alias ?? repo.path}" (${repoDir}): ${err instanceof Error ? err.message : err}`,
        "connect",
      );
    }
  }
  if (startupConfig.connectedRepos.length > 0) {
    // Each attach configured the GLOBAL query embedder for that repo's model
    // (needed for its compat asserts). Restore the primary's before startup
    // indexing embeds anything, or it would index with the last repo's model.
    applyEmbeddingConfigFromDisk(startupDir);
  }

  if (!isHomeDirTrap) {
    // All indexing/watching work, gated behind the lock. Extracted so the
    // query-only retry path can invoke it the moment it wins the lock.
    const startIndexingWork = () => {

    // Ensure .mimirs/ is gitignored — only the lock holder writes it, so two
    // instances starting together don't both append (duplicate .gitignore lines).
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
        ...indexStatusLines(startupDb),
      ].join("\n");
      writeStatus(doneStatus);
      log.debug(`Startup index: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`, "indexer");
    }).catch((err) => {
      writeStatus(`error\nversion: ${version}\nfailed: ${new Date().toISOString()}\n${err instanceof Error ? err.message : err}`);
      log.warn(`Startup indexing failed: ${err instanceof Error ? err.message : err}`, "indexer");
    }).finally(() => {
      // Start the watcher whether or not the initial index succeeded — a
      // transient startup failure (model download, SQLITE_BUSY) used to leave
      // the server watch-less for its whole lifetime, silently dropping every
      // subsequent edit until restart.
      watcher = startWatcher(startupDir, startupDb, startupConfig, (msg) => {
        log.debug(msg, "watcher");
        // Update status file so IDE/client sees watcher activity
        const dbStatus = startupDb.getStatus();
        writeStatus([
          `done`,
          `version: ${version}`,
          `finished: ${new Date().toISOString()}`,
          `total files: ${dbStatus.totalFiles}, total chunks: ${dbStatus.totalChunks}`,
          ...indexStatusLines(startupDb),
          `watcher: ${msg}`,
        ].join("\n"));
      });

      // Opt-in (config.autoIndexGit): index git commit history once the file
      // index has settled. Fired here — after the file index resolves — so its
      // status writes don't race the file index's per-file progress. Incremental
      // via the resume cursor, so only new commits embed after the first run.
      if (startupConfig.autoIndexGit) {
        indexGitHistory(startupDir, startupDb, {
          threads: startupConfig.indexThreads,
          onProgress: (msg, opts) => {
            if (!opts?.transient) writeStatus(msg);
          },
        }).then((r) => {
          log.debug(`Startup git index: ${r.indexed} indexed, ${r.skipped} skipped`, "git-index");
          const dbStatus = startupDb.getStatus();
          writeStatus([
            `done`,
            `version: ${version}`,
            `finished: ${new Date().toISOString()}`,
            `total files: ${dbStatus.totalFiles}, total chunks: ${dbStatus.totalChunks}`,
            ...indexStatusLines(startupDb),
          ].join("\n"));
        }).catch((err) => {
          log.warn(`Startup git index failed: ${err instanceof Error ? err.message : err}`, "git-index");
        });
      }
    });
    // Watch the whole conversations folder and index every transcript from its
    // stored offset — the live session plus any other session that changes or
    // starts later. Backfills all existing sessions on startup, then keeps them
    // current, so one agent's findings become searchable to another in near
    // real time. Idempotent (insertTurn dedups; offsets advance by bytes read)
    // and gated by the index lock so only one server instance writes.
    const convW = startConversationFolderWatch(
      getTranscriptsDir(startupDir),
      startupDb,
      startupDir,
      (msg) => log.debug(msg, "conversation"),
    );
    convWatcher = convW;

    // Drop-box command channel: a CLI beside this server directs the lock
    // holder through .mimirs/commands/ (plans/command-dropbox.md). Started
    // here so only the holder ever consumes; the lock-retry takeover picks
    // it up with the rest of the indexing work.
    cmdWatcher = startCommandDropbox(startupDir, {
      "ping": async () => ({ pid: process.pid, version }),
      "index.git": async (args) => {
        const result = await indexGitHistory(startupDir, startupDb, {
          since: args.since,
          threads: startupConfig.indexThreads,
          onProgress: (msg, opts) => {
            if (!opts?.transient) writeStatus(msg);
          },
        });
        return { indexed: result.indexed, skipped: result.skipped };
      },
      "index.conversation": async () => {
        // Rides the conversation watcher's serial queue — the only thing
        // preventing overlapping indexConversation runs from corrupting
        // turn_count.
        return { turnsIndexed: await convW.backfillAll() };
      },
      "index.files": async (args) => {
        const config = args.patterns ? { ...startupConfig, include: args.patterns } : startupConfig;
        let total = 0;
        let processed = 0;
        const result = await indexDirectory(startupDir, startupDb, config, (msg) => {
          if (msg === "file:done") {
            processed++;
            if (total > 0) writeStatus(`${processed}/${total} files (${Math.round((processed / total) * 100)}%)`);
            return;
          }
          const found = msg.match(/^Found (\d+) files to index$/);
          if (found) {
            total = parseInt(found[1], 10);
            writeStatus(`0/${total} files`);
          }
        }, undefined, { prune: !args.patterns });
        const dbStatus = startupDb.getStatus();
        writeStatus([
          `done`,
          `version: ${version}`,
          `indexed: ${result.indexed}, skipped: ${result.skipped}, pruned: ${result.pruned}`,
          `total files: ${dbStatus.totalFiles}, total chunks: ${dbStatus.totalChunks}`,
          ...indexStatusLines(startupDb),
        ].join("\n"));
        return { indexed: result.indexed, skipped: result.skipped, pruned: result.pruned };
      },
    }, (msg) => log.debug(msg, "dropbox"));
    }; // end startIndexingWork

    // Process-level lock: only one mimirs server per project directory
    // performs indexing/watching. Other instances (e.g. extra IDE windows)
    // share the DB read-only — concurrent indexers double-insert chunks.
    indexLock = tryAcquireIndexLock(startupDir);
    if (indexLock) {
      startIndexingWork();
    } else {
      log.debug("Another mimirs process owns the index lock — query-only, will retry", "index-lock");
      const dbStatus = startupDb.getStatus();
      writeStatus([
        `done`,
        `version: ${version}`,
        `total files: ${dbStatus.totalFiles}, total chunks: ${dbStatus.totalChunks}`,
        ...indexStatusLines(startupDb),
      ].join("\n"));
      // Don't give up permanently. The lock owner may be an orphaned server
      // that exits shortly (the ppid watchdog kills such orphans), or any
      // process that dies later. Retry so we take over indexing instead of
      // serving stale results forever.
      lockRetryTimer = setInterval(() => {
        if (shuttingDown) return;
        indexLock = tryAcquireIndexLock(startupDir);
        if (indexLock) {
          if (lockRetryTimer) clearInterval(lockRetryTimer);
          lockRetryTimer = null;
          log.debug("Acquired index lock on retry — taking over indexing", "index-lock");
          startIndexingWork();
        }
      }, 30_000);
      if (typeof lockRetryTimer.unref === "function") lockRetryTimer.unref();
    }
  }

}
