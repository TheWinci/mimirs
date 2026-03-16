import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig, applyEmbeddingConfig } from "../../config";
import { search, searchChunks } from "../../search/hybrid";

export async function searchCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const query = args[1];
  if (!query) {
    console.error("Usage: local-rag search <query> [--top N]");
    process.exit(1);
  }

  const dir = resolve(getFlag("--dir") || ".");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  applyEmbeddingConfig(config);
  const top = parseInt(getFlag("--top") || String(config.searchTopK), 10);

  const results = await search(query, db, top, 0, config.hybridWeight);

  if (results.length === 0) {
    console.log("No results found. Has the directory been indexed?");
  } else {
    for (const r of results) {
      console.log(`${r.score.toFixed(4)}  ${r.path}`);
      const preview = r.snippets[0]?.slice(0, 120).replace(/\n/g, " ");
      console.log(`         ${preview}...`);
      console.log();
    }
  }
  db.close();
}

export async function readCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const query = args[1];
  if (!query) {
    console.error("Usage: local-rag read <query> [--top N] [--threshold T] [--dir D]");
    process.exit(1);
  }

  const dir = resolve(getFlag("--dir") || ".");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  applyEmbeddingConfig(config);
  const top = parseInt(getFlag("--top") || "8", 10);
  const threshold = parseFloat(getFlag("--threshold") || "0.3");

  const results = await searchChunks(query, db, top, threshold, config.hybridWeight);

  if (results.length === 0) {
    console.log("No relevant chunks found. Has the directory been indexed?");
  } else {
    for (const r of results) {
      const entity = r.entityName ? `  •  ${r.entityName}` : "";
      console.log(`[${r.score.toFixed(2)}] ${r.path}${entity}`);
      console.log(r.content);
      console.log("\n---\n");
    }
  }
  db.close();
}
