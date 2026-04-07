import { resolve, join } from "path";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { indexDirectory } from "../../indexing/indexer";
import { runSetup, confirm, parseIdeFlag, mcpConfigSnippet } from "../setup";
import { cliProgress } from "../progress";
import { cli } from "../../utils/log";

export async function initCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const autoYes = args.includes("--yes") || args.includes("-y");
  const ideFlag = getFlag("--ide");
  const ides = ideFlag ? parseIdeFlag(ideFlag) : undefined;
  const { actions, unknownIdes } = await runSetup(dir, ides);
  if (actions.length === 0 && unknownIdes.length === 0) {
    cli.log("Already set up — nothing to do.");
  } else {
    for (const action of actions) cli.log(action);
  }

  if (unknownIdes.length > 0) {
    cli.log(`\nAdd this to your agent's MCP config (${unknownIdes.join(", ")}):\n`);
    cli.log(mcpConfigSnippet(dir));
  }

  cli.log();
  const shouldIndex = autoYes || await confirm("Index project now? [Y/n] ");
  if (shouldIndex) {
    const db = new RagDB(dir);
    const config = await loadConfig(dir);
    cli.log(`Indexing ${dir}...`);

    const ragDir = join(dir, ".mimirs");
    const statusPath = join(ragDir, "status");
    const writeStatus = (status: string) => {
      try {
        mkdirSync(ragDir, { recursive: true });
        writeFileSync(statusPath, status);
      } catch { /* best-effort */ }
    };

    let totalFiles = 0;
    let processedFiles = 0;

    const result = await indexDirectory(dir, db, config, (msg, progressOpts) => {
      if (msg === "file:done") {
        processedFiles++;
        if (totalFiles > 0) {
          const pct = Math.round((processedFiles / totalFiles) * 100);
          writeStatus(`${processedFiles}/${totalFiles} files (${pct}%)`);
        }
      }

      const foundMatch = msg.match(/^Found (\d+) files to index$/);
      if (foundMatch) {
        totalFiles = parseInt(foundMatch[1], 10);
        writeStatus(`0/${totalFiles} files`);
      }

      if (msg.startsWith("scanning files")) {
        writeStatus(msg);
      }

      // Forward to CLI progress for terminal output
      cliProgress(msg, progressOpts);
    });

    // Clean up status file on completion
    try { unlinkSync(statusPath); } catch { /* already gone */ }

    cli.log(
      `\nDone: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`
    );
    db.close();
  }
}
