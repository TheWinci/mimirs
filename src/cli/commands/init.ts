import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { indexDirectory } from "../../indexing/indexer";
import { runSetup, confirm } from "../setup";
import { cliProgress } from "../progress";

export async function initCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const autoYes = args.includes("--yes") || args.includes("-y");
  const { actions } = await runSetup(dir);
  if (actions.length === 0) {
    console.log("Already set up — nothing to do.");
  } else {
    for (const action of actions) console.log(action);
  }

  console.log();
  const shouldIndex = autoYes || await confirm("Index project now? [Y/n] ");
  if (shouldIndex) {
    const db = new RagDB(dir);
    const config = await loadConfig(dir);
    console.log(`Indexing ${dir}...`);
    const result = await indexDirectory(dir, db, config, cliProgress);
    console.log(
      `\nDone: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`
    );
    db.close();
  }
}
