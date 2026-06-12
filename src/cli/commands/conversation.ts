import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { embed } from "../../embeddings/embed";
import { rrfFuse } from "../../search/hybrid";
import { discoverSessions } from "../../conversation/parser";
import { indexConversation } from "../../conversation/indexer";
import { tryAcquireIndexLock } from "../../utils/index-lock";
import { DropboxError, readLockHolderPid, withIndexAccess } from "../../control/producer";
import { intFlag } from "../flags";
import { cli } from "../../utils/log";

/** Index every discovered session in-process. Caller must hold the index
 * lock — overlapping `indexConversation` runs on one file corrupt
 * `turn_count`, which is why a live server routes this through its serial
 * conversation queue instead. */
async function runConversationIndexLocal(
  dir: string,
  rebuild: boolean,
): Promise<{ sessions: number; turns: number }> {
  const db = new RagDB(dir);
  try {
    const sessions = discoverSessions(dir);
    let totalTurns = 0;
    for (const session of sessions) {
      // --rebuild drops the stored turns first: indexes written before the
      // turn-cursor fix have split turns (lost tails) and drifted indices
      // that incremental upserts alone can't fully repair.
      if (rebuild) db.deleteSessionTurns(session.sessionId);
      const result = await indexConversation(session.jsonlPath, session.sessionId, db, dir);
      totalTurns += result.turnsIndexed;
      if (result.turnsIndexed > 0) {
        cli.log(`  ${session.sessionId.slice(0, 8)}...: ${result.turnsIndexed} turns`);
      }
    }
    return { sessions: sessions.length, turns: totalTurns };
  } finally {
    db.close();
  }
}

/**
 * `mimirs conversation index` / `mimirs index conversation` — three-step
 * fallback: run in-process when the lock is free or stale, otherwise hand
 * the job to the live server via the drop-box (which serializes it on the
 * conversation queue). This closes the old race where the CLI called
 * `indexConversation` beside a live server with no lock at all.
 */
export async function conversationIndexCommand(dir: string, rebuild: boolean): Promise<void> {
  if (rebuild) {
    // Rebuild deletes stored turns first — that needs exclusive access, not
    // a queue slot beside a watcher that may be re-indexing the same session.
    const lock = tryAcquireIndexLock(dir);
    if (!lock) {
      cli.error(
        `A live mimirs server (pid ${readLockHolderPid(dir) ?? "?"}) holds the index lock — ` +
        `stop it (close the IDE window or reconnect MCP) and retry --rebuild.`,
      );
      process.exit(1);
    }
    try {
      const r = await runConversationIndexLocal(dir, true);
      cli.log(`Done: ${r.turns} turns indexed across ${r.sessions} sessions`);
    } finally {
      lock.release();
    }
    return;
  }

  try {
    const access = await withIndexAccess(
      dir,
      () => runConversationIndexLocal(dir, false),
      { cmd: "index.conversation", args: {} },
      { onProgress: (msg) => cli.log(`  server: ${msg}`) },
    );
    if (access.mode === "local") {
      cli.log(`Done: ${access.value.turns} turns indexed across ${access.value.sessions} sessions`);
    } else if (access.result.status === "ok") {
      cli.log(`Done (via live server): ${access.result.stats?.turnsIndexed ?? 0} new turns indexed`);
    } else {
      cli.error(`Live server returned ${access.result.status}${access.result.detail ? `: ${access.result.detail}` : ""}`);
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof DropboxError) {
      cli.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

export async function conversationCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const subCommand = args[1];
  const dir = resolve(getFlag("--dir") || ".");

  if (subCommand === "search") {
    const query = args[2];
    // Reject a leading flag as the query — `conversation search --top N "q"`
    // would otherwise embed the literal "--top" and silently ignore "q".
    if (!query || query.startsWith("--")) {
      cli.error("Usage: mimirs conversation search <query> [--dir D] [--top N]");
      process.exit(1);
    }

    const db = new RagDB(dir);
    const config = await loadConfig(dir);
    const top = intFlag(getFlag("--top"), "--top", config.searchTopK, { min: 1 });

    // Freshen stale sessions only when no live server exists — a live
    // server's conversation folder watcher already keeps them current, and
    // indexing beside it would race its serial queue (turn_count corruption).
    const lock = tryAcquireIndexLock(dir);
    if (lock) {
      try {
        const sessions = discoverSessions(dir);
        for (const session of sessions) {
          const existing = db.getSession(session.sessionId);
          if (!existing || existing.mtime < session.mtime) {
            await indexConversation(session.jsonlPath, session.sessionId, db, dir);
          }
        }
      } finally {
        lock.release();
      }
    }

    // Hybrid search
    const queryEmb = await embed(query);
    const vecResults = db.searchConversation(queryEmb, top);
    let bm25Results: typeof vecResults = [];
    try {
      bm25Results = db.textSearchConversation(query, top);
    } catch { /* FTS can fail on special chars */ }

    // Shared rank fusion (same as chunk search) — raw cosine/BM25 scales don't blend.
    const results = rrfFuse(vecResults, bm25Results, config.hybridWeight, (r) => r.turnId)
      .sort((a, b) => b.score - a.score)
      .slice(0, top);

    if (results.length === 0) {
      cli.log("No conversation results found.");
    } else {
      for (const r of results) {
        const tools = r.toolsUsed.length > 0 ? ` [${r.toolsUsed.join(", ")}]` : "";
        cli.log(`Turn ${r.turnIndex} (${r.timestamp})${tools}`);
        cli.log(`  ${r.snippet.slice(0, 200)}`);
        if (r.filesReferenced.length > 0) {
          cli.log(`  Files: ${r.filesReferenced.slice(0, 5).join(", ")}`);
        }
        cli.log();
      }
    }
    db.close();
  } else if (subCommand === "sessions") {
    const db = new RagDB(dir);
    const sessions = discoverSessions(dir);
    if (sessions.length === 0) {
      cli.log("No conversation sessions found for this project.");
    } else {
      for (const s of sessions) {
        const indexed = db.getSession(s.sessionId);
        const status = indexed ? `${indexed.turnCount} turns indexed` : "not indexed";
        const date = new Date(s.mtime).toISOString().slice(0, 19);
        cli.log(`  ${s.sessionId.slice(0, 8)}...  ${date}  ${status}  (${(s.size / 1024).toFixed(0)}KB)`);
      }
    }
    db.close();
  } else if (subCommand === "index") {
    await conversationIndexCommand(dir, args.includes("--rebuild"));
  } else {
    cli.error("Usage: mimirs conversation <search|sessions|index [--rebuild]>");
    process.exit(1);
  }
}
