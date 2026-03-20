import { resolve } from "path";
import { RagDB } from "../../db";

export async function statusCommand(args: string[]) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const db = new RagDB(dir);
  const status = db.getStatus();
  console.log(`Index status for ${dir}:`);
  console.log(`  Files:        ${status.totalFiles}`);
  console.log(`  Chunks:       ${status.totalChunks}`);
  console.log(`  Last indexed: ${status.lastIndexed || "never"}`);
  db.close();
}
