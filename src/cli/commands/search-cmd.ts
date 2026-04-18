import { resolve } from "path";
import { RagDB, type PathFilter } from "../../db";
import { loadConfig, applyEmbeddingConfig } from "../../config";
import { search, searchChunks } from "../../search/hybrid";
import { cli } from "../../utils/log";

function parseListFlag(getFlag: (flag: string) => string | undefined, ...names: string[]): string[] | undefined {
  for (const name of names) {
    const raw = getFlag(name);
    if (raw != null && raw.length > 0) {
      return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    }
  }
  return undefined;
}

function buildCliFilter(
  projectDir: string,
  getFlag: (flag: string) => string | undefined,
): PathFilter | undefined {
  const extensions = parseListFlag(getFlag, "--ext", "--extensions");
  const rawDirs = parseListFlag(getFlag, "--in", "--dirs");
  const rawExclude = parseListFlag(getFlag, "--exclude", "--exclude-dirs");
  if (!extensions && !rawDirs && !rawExclude) return undefined;
  return {
    extensions,
    dirs: rawDirs?.map((d) => resolve(projectDir, d)),
    excludeDirs: rawExclude?.map((d) => resolve(projectDir, d)),
  };
}

export async function searchCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const query = args[1];
  if (!query) {
    cli.error("Usage: mimirs search <query> [--top N] [--ext .ts,.tsx] [--in src,packages/core] [--exclude tests]");
    process.exit(1);
  }

  const dir = resolve(getFlag("--dir") || ".");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  applyEmbeddingConfig(config);
  const top = parseInt(getFlag("--top") || String(config.searchTopK), 10);
  const filter = buildCliFilter(dir, getFlag);

  const results = await search(query, db, top, 0, config.hybridWeight, config.generated, filter);

  if (results.length === 0) {
    cli.log("No results found. Has the directory been indexed?");
  } else {
    for (const r of results) {
      cli.log(`${r.score.toFixed(4)}  ${r.path}`);
      const preview = r.snippets[0]?.slice(0, 120).replace(/\n/g, " ");
      cli.log(`         ${preview}...`);
      cli.log();
    }
  }
  db.close();
}

export async function readCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const query = args[1];
  if (!query) {
    cli.error("Usage: mimirs read <query> [--top N] [--threshold T] [--dir D] [--ext ...] [--in ...] [--exclude ...]");
    process.exit(1);
  }

  const dir = resolve(getFlag("--dir") || ".");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  applyEmbeddingConfig(config);
  const top = parseInt(getFlag("--top") || "8", 10);
  const threshold = parseFloat(getFlag("--threshold") || "0.3");
  const filter = buildCliFilter(dir, getFlag);

  const results = await searchChunks(query, db, top, threshold, config.hybridWeight, config.generated, filter);

  if (results.length === 0) {
    cli.log("No relevant chunks found. Has the directory been indexed?");
  } else {
    for (const r of results) {
      const entity = r.entityName ? `  •  ${r.entityName}` : "";
      cli.log(`[${r.score.toFixed(2)}] ${r.path}${entity}`);
      cli.log(r.content);
      cli.log("\n---\n");
    }
  }
  db.close();
}
