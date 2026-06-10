import { positionalArg, CliFlagError } from "../flags";
import { resolve } from "path";
import { RagDB } from "../../db";
import { generateProjectMap } from "../../graph/resolver";
import { cli } from "../../utils/log";

export async function mapCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(positionalArg(args[1], "."));
  const focus = getFlag("--focus");
  const zoomRaw = getFlag("--zoom") || "file";
  if (zoomRaw !== "file" && zoomRaw !== "directory") {
    throw new CliFlagError(`Invalid value for --zoom: "${zoomRaw}" — expected "file" or "directory".`);
  }
  const zoom: "file" | "directory" = zoomRaw;
  const db = new RagDB(dir);

  const map = generateProjectMap(db, {
    projectDir: dir,
    focus: focus ?? undefined,
    zoom,
  });

  cli.log(map);
  db.close();
}
