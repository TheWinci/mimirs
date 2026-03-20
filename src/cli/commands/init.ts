import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { indexDirectory } from "../../indexing/indexer";
import { runSetup, mcpConfigSnippet, detectAgentHints, confirm } from "../setup";

export async function initCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const { actions } = await runSetup(dir);
  if (actions.length === 0) {
    console.log("Already set up — nothing to do.");
  } else {
    for (const action of actions) console.log(action);
  }

  console.log("\nAdd this to your agent's MCP config (mcpServers):\n");
  console.log(mcpConfigSnippet(dir));
  const hints = detectAgentHints(dir);
  console.log();
  for (const hint of hints) console.log(`  ${hint}`);

  console.log();
  const shouldIndex = await confirm("Index project now? [Y/n] ");
  if (shouldIndex) {
    const db = new RagDB(dir);
    const config = await loadConfig(dir);
    console.log(`Indexing ${dir}...`);
    const result = await indexDirectory(dir, db, config, console.log);
    console.log(
      `\nDone: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`
    );
    db.close();
  }
}
