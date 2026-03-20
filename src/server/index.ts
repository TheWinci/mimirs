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
import { registerAllTools } from "../tools";
import { runSetup, mcpConfigSnippet, detectAgentHints, confirm } from "../cli/setup";

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
    version: "0.1.0",
  });

  // Register all MCP tools
  registerAllTools(server, getDB);

  // init subcommand: bunx local-rag-mcp@latest init [dir]
  if (process.argv[2] === "init") {
    const dir = process.argv[3] ? resolve(process.argv[3]) : process.cwd();
    const { actions } = await runSetup(dir);
    if (actions.length === 0) {
      console.log("Already set up — nothing to do.");
    } else {
      for (const action of actions) console.log(action);
    }

    // Print MCP config snippet for the user to paste
    console.log("\nAdd this to your agent's MCP config (mcpServers):\n");
    console.log(mcpConfigSnippet(dir));
    const hints = detectAgentHints(dir);
    console.log();
    for (const hint of hints) console.log(`  ${hint}`);

    // Ask if user wants to index now
    console.log();
    const shouldIndex = await confirm("Index project now? [Y/n] ");
    if (shouldIndex) {
      const db = new RagDB(dir);
      const config = await loadConfig(dir);
      console.log(`Indexing ${dir}...`);
      const { cliProgress } = await import("../cli/progress");
      const result = await indexDirectory(dir, db, config, cliProgress);
      console.log(
        `\nDone: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`
      );
      db.close();
    }

    process.exit(0);
  }

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
        }).catch(() => {
          // Non-critical — skip broken transcripts
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
