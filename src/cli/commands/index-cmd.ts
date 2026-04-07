import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig, applyEmbeddingConfig } from "../../config";
import { indexDirectory } from "../../indexing/indexer";
import { cliProgress } from "../progress";
import { cli } from "../../utils/log";

export async function indexCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  applyEmbeddingConfig(config);

  const patternsStr = getFlag("--patterns");
  if (patternsStr) {
    config.include = patternsStr.split(",").map((p) => p.trim());
  }

  cli.log(`Indexing ${dir}...`);
  const result = await indexDirectory(dir, db, config, cliProgress);
  cli.log(
    `\nDone: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`
  );
  if (result.errors.length > 0) {
    cli.error(`Errors: ${result.errors.join("\n  ")}`);
  }
  db.close();
}
