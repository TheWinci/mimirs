import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { embed } from "../../embeddings/embed";
import { rrfFuse } from "../../search/hybrid";
import { discoverSessions } from "../../conversation/parser";
import { indexConversation } from "../../conversation/indexer";
import { intFlag } from "../flags";
import { cli } from "../../utils/log";

export async function conversationCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const subCommand = args[1];
  const dir = resolve(getFlag("--dir") || ".");
  const db = new RagDB(dir);

  if (subCommand === "search") {
    const query = args[2];
    // Reject a leading flag as the query — `conversation search --top N "q"`
    // would otherwise embed the literal "--top" and silently ignore "q".
    if (!query || query.startsWith("--")) {
      cli.error("Usage: mimirs conversation search <query> [--dir D] [--top N]");
      process.exit(1);
    }

    const config = await loadConfig(dir);
    const top = intFlag(getFlag("--top"), "--top", config.searchTopK, { min: 1 });

    // Ensure conversations are indexed
    const sessions = discoverSessions(dir);
    for (const session of sessions) {
      const existing = db.getSession(session.sessionId);
      if (!existing || existing.mtime < session.mtime) {
        await indexConversation(session.jsonlPath, session.sessionId, db, dir);
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
        const result = await indexConversation(session.jsonlPath, session.sessionId, db, dir);
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
