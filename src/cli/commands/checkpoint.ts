import { resolve } from "path";
import { RagDB } from "../../db";
import { embed } from "../../embeddings/embed";
import { discoverSessions } from "../../conversation/parser";

export async function checkpointCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const subCommand = args[1];
  const dir = resolve(getFlag("--dir") || ".");
  const db = new RagDB(dir);

  if (subCommand === "create") {
    const type = args[2];
    const title = args[3];
    const summary = args[4];
    if (!type || !title || !summary) {
      console.error("Usage: local-rag-mcp checkpoint create <type> <title> <summary> [--dir D] [--files f1,f2] [--tags t1,t2]");
      process.exit(1);
    }

    const filesStr = getFlag("--files");
    const tagsStr = getFlag("--tags");
    const filesInvolved = filesStr ? filesStr.split(",").map((f) => f.trim()) : [];
    const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()) : [];

    const sessions = discoverSessions(dir);
    const sessionId = sessions.length > 0 ? sessions[0].sessionId : "unknown";
    const turnCount = db.getTurnCount(sessionId);
    const turnIndex = Math.max(0, turnCount - 1);

    const embedding = await embed(`${title}. ${summary}`);
    const id = db.createCheckpoint(
      sessionId, turnIndex, new Date().toISOString(),
      type, title, summary, filesInvolved, tags, embedding
    );
    console.log(`Checkpoint #${id} created: [${type}] ${title}`);
  } else if (subCommand === "list") {
    const type = getFlag("--type");
    const top = parseInt(getFlag("--top") || "20", 10);
    const checkpoints = db.listCheckpoints(undefined, type, top);

    if (checkpoints.length === 0) {
      console.log("No checkpoints found.");
    } else {
      for (const cp of checkpoints) {
        const tagStr = cp.tags.length > 0 ? ` [${cp.tags.join(", ")}]` : "";
        console.log(`#${cp.id} [${cp.type}] ${cp.title}${tagStr}`);
        console.log(`  ${cp.timestamp} (turn ${cp.turnIndex})`);
        console.log(`  ${cp.summary}`);
        if (cp.filesInvolved.length > 0) {
          console.log(`  Files: ${cp.filesInvolved.join(", ")}`);
        }
        console.log();
      }
    }
  } else if (subCommand === "search") {
    const query = args[2];
    if (!query) {
      console.error("Usage: local-rag-mcp checkpoint search <query> [--dir D] [--type T] [--top N]");
      process.exit(1);
    }

    const type = getFlag("--type");
    const top = parseInt(getFlag("--top") || "5", 10);
    const queryEmb = await embed(query);
    const results = db.searchCheckpoints(queryEmb, top, type);

    if (results.length === 0) {
      console.log("No matching checkpoints found.");
    } else {
      for (const cp of results) {
        console.log(`${cp.score.toFixed(4)}  #${cp.id} [${cp.type}] ${cp.title}`);
        console.log(`  ${cp.summary}`);
        if (cp.filesInvolved.length > 0) {
          console.log(`  Files: ${cp.filesInvolved.join(", ")}`);
        }
        console.log();
      }
    }
  } else {
    console.error("Usage: local-rag-mcp checkpoint <create|list|search>");
    process.exit(1);
  }

  db.close();
}
