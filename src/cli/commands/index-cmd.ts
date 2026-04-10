import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig, applyEmbeddingConfig } from "../../config";
import { indexDirectory } from "../../indexing/indexer";
import { cliProgress, createQuietProgress } from "../progress";
import { cli } from "../../utils/log";

export async function indexCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  applyEmbeddingConfig(config);

  const patternsStr = getFlag("--patterns");
  if (patternsStr) {
    config.include = patternsStr.split(",").map((p) => p.trim());
  }

  cli.log(`Indexing ${dir}...`);
  const startTime = Date.now();

  let quietProgress: ReturnType<typeof createQuietProgress> | null = null;

  const progress = verbose ? cliProgress : (msg: string, opts?: { transient?: boolean }) => {
    const foundMatch = msg.match(/^Found (\d+) files to index$/);
    if (foundMatch) {
      quietProgress = createQuietProgress(parseInt(foundMatch[1], 10));
    }

    if (quietProgress) {
      quietProgress(msg, opts);
    } else {
      cliProgress(msg, opts);
    }
  };

  const result = await indexDirectory(dir, db, config, progress);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  cli.log(
    `\nDone: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned (${elapsed}s)`
  );
  if (result.errors.length > 0) {
    cli.error(`Errors: ${result.errors.join("\n  ")}`);
  }
  db.close();
}
