import { resolve } from "path";
import { RagDB } from "../../db";
import { generateProjectMap } from "../../graph/resolver";
import { cli } from "../../utils/log";

export async function mapCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const db = new RagDB(dir);
  const focus = getFlag("--focus");
  const zoom = (getFlag("--zoom") || "file") as "file" | "directory";

  const map = generateProjectMap(db, {
    projectDir: dir,
    focus: focus ?? undefined,
    zoom,
  });

  cli.log(map);
  db.close();
}
