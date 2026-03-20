import { resolve } from "path";
import { RagDB } from "../../db";
import { generateMermaid } from "../../graph/resolver";

export async function mapCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const db = new RagDB(dir);
  const focus = getFlag("--focus");
  const zoom = (getFlag("--zoom") || "file") as "file" | "directory";
  const max = parseInt(getFlag("--max") || "50", 10);

  const mermaid = generateMermaid(db, {
    projectDir: dir,
    focus: focus ?? undefined,
    zoom,
    maxNodes: max,
  });

  console.log(mermaid);
  db.close();
}
