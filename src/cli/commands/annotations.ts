import { resolve } from "path";
import { RagDB } from "../../db";
import { cli } from "../../utils/log";

export async function annotationsCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : getFlag("--dir") || ".");
  const filterPath = getFlag("--path");
  const db = new RagDB(dir);
  const annotations = db.getAnnotations(filterPath);

  if (annotations.length === 0) {
    cli.log(filterPath ? `No annotations for ${filterPath}.` : "No annotations found.");
    db.close();
    return;
  }

  for (const a of annotations) {
    const target = a.symbolName ? `${a.path}  •  ${a.symbolName}` : a.path;
    const authorStr = a.author ? ` [${a.author}]` : "";
    cli.log(`#${a.id}  ${target}${authorStr}`);
    cli.log(`  ${a.note}`);
    cli.log(`  (${a.updatedAt})`);
    cli.log();
  }

  db.close();
}
