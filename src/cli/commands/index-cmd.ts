import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { indexDirectory } from "../../indexing/indexer";
import { cliProgress } from "../progress";

export async function indexCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);

  const patternsStr = getFlag("--patterns");
  if (patternsStr) {
    config.include = patternsStr.split(",").map((p) => p.trim());
  }

  console.log(`Indexing ${dir}...`);
  const result = await indexDirectory(dir, db, config, cliProgress);
  console.log(
    `\nDone: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`
  );
  if (result.errors.length > 0) {
    console.error(`Errors: ${result.errors.join("\n  ")}`);
  }
  db.close();
}
