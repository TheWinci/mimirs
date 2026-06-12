import { positionalArg } from "../flags";
import { resolve, join } from "path";
import { readFileSync } from "fs";
import { RagDB } from "../../db";
import { readLockHolderPid } from "../../control/producer";
import { isPidAlive } from "../../utils/index-lock";
import { cli } from "../../utils/log";

export async function statusCommand(args: string[]) {
  const dir = resolve(positionalArg(args[1], "."));
  const db = new RagDB(dir);
  const status = db.getStatus();
  cli.log(`Index status for ${dir}:`);
  cli.log(`  Files:        ${status.totalFiles}`);
  cli.log(`  Chunks:       ${status.totalChunks}`);
  cli.log(`  Last indexed: ${status.lastIndexed || "never"}`);

  // Who holds the index lock — the process a drop-box command would reach.
  const holder = readLockHolderPid(dir);
  if (holder === null) {
    cli.log(`  Server:       none (index lock free)`);
  } else {
    cli.log(`  Server:       pid ${holder} (${isPidAlive(holder) ? "alive, holds index lock" : "dead — stale lock, reclaimed on next run"})`);
  }
  try {
    const line = readFileSync(join(dir, ".mimirs", "status"), "utf-8").split("\n", 1)[0];
    if (line) cli.log(`  Server state: ${line}`);
  } catch { /* no status file yet */ }

  db.close();
}
