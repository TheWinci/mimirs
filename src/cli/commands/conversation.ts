import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { embed } from "../../embeddings/embed";
import { discoverSessions } from "../../conversation/parser";
import { indexConversation } from "../../conversation/indexer";
import { cli } from "../../utils/log";

export async function conversationCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const subCommand = args[1];
  const dir = resolve(getFlag("--dir") || ".");
  const db = new RagDB(dir);

  if (subCommand === "search") {
    const query = args[2];
    if (!query) {
      cli.error("Usage: mimirs conversation search <query> [--dir D] [--top N]");
      process.exit(1);
    }

    const config = await loadConfig(dir);
    const top = parseInt(getFlag("--top") || String(config.searchTopK), 10);

    // Ensure conversations are indexed
    const sessions = discoverSessions(dir);
    for (const session of sessions) {
      const existing = db.getSession(session.sessionId);
      if (!existing || existing.mtime < session.mtime) {
        await indexConversation(session.jsonlPath, session.sessionId, db);
      }
    }

    // Hybrid search
    const queryEmb = await embed(query);
    const vecResults = db.searchConversation(queryEmb, top);
    let bm25Results: typeof vecResults = [];
    try {
      bm25Results = db.textSearchConversation(query, top);
    } catch { /* FTS can fail on special chars */ }

    const merged = new Map<number, (typeof vecResults)[0]>();
    for (const r of vecResults) {
      merged.set(r.turnId, { ...r, score: r.score * config.hybridWeight });
    }
    for (const r of bm25Results) {
      const existing = merged.get(r.turnId);
      if (existing) {
        existing.score += r.score * (1 - config.hybridWeight);
      } else {
        merged.set(r.turnId, { ...r, score: r.score * (1 - config.hybridWeight) });
      }
    }

    const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, top);

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
  } else if (subCommand === "sessions") {
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
  } else if (subCommand === "index") {
    const sessions = discoverSessions(dir);
    if (sessions.length === 0) {
      cli.log("No conversation sessions found for this project.");
    } else {
      cli.log(`Found ${sessions.length} sessions, indexing...`);
      let totalTurns = 0;
      for (const session of sessions) {
        const result = await indexConversation(session.jsonlPath, session.sessionId, db);
        totalTurns += result.turnsIndexed;
        if (result.turnsIndexed > 0) {
          cli.log(`  ${session.sessionId.slice(0, 8)}...: ${result.turnsIndexed} turns`);
        }
      }
      cli.log(`Done: ${totalTurns} turns indexed across ${sessions.length} sessions`);
    }
  } else {
    cli.error("Usage: mimirs conversation <search|sessions|index>");
    process.exit(1);
  }

  db.close();
}
