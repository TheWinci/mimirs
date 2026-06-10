import { positionalArg } from "../flags";
import { resolve } from "path";
import { RagDB } from "../../db";
import { cli } from "../../utils/log";

export async function statusCommand(args: string[]) {
  const dir = resolve(positionalArg(args[1], "."));
  const db = new RagDB(dir);
  const status = db.getStatus();
  cli.log(`Index status for ${dir}:`);
  cli.log(`  Files:        ${status.totalFiles}`);
  cli.log(`  Chunks:       ${status.totalChunks}`);
  cli.log(`  Last indexed: ${status.lastIndexed || "never"}`);
  db.close();
}
