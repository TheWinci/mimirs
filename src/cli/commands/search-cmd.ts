import { resolve } from "path";
import { RagDB, type PathFilter } from "../../db";
import { loadConfig } from "../../config";
import { search, searchChunks } from "../../search/hybrid";
import { cli } from "../../utils/log";
import { intFlag, floatFlag } from "../flags";

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
  const config = await loadConfig(dir);
  // Validate flags before constructing RagDB so a bad flag reports its own
  // error rather than a later DB/embedding error masking it.
  const top = intFlag(getFlag("--top"), "--top", config.searchTopK, { min: 1 });
  const db = new RagDB(dir);
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
  // Validate flags before constructing RagDB (see searchCommand).
  const top = intFlag(getFlag("--top"), "--top", 8, { min: 1 });
  const threshold = floatFlag(getFlag("--threshold"), "--threshold", 0.3, { min: 0, max: 1 });
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  const filter = buildCliFilter(dir, getFlag);

  const results = await searchChunks(query, db, top, threshold, config.hybridWeight, config.generated, filter, config.parentGroupingMinCount);

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
