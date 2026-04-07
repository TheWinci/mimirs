import { resolve } from "path";
import { RagDB } from "../../db";
import { cli } from "../../utils/log";

export async function removeCommand(args: string[]) {
  const file = args[1];
  if (!file) {
    cli.error("Usage: mimirs remove <file> [dir]");
    process.exit(1);
  }
  const dir = resolve(args[2] && !args[2].startsWith("--") ? args[2] : ".");
  const db = new RagDB(dir);
  const removed = db.removeFile(resolve(file));
  cli.log(removed ? `Removed ${file}` : `${file} was not in the index`);
  db.close();
}
