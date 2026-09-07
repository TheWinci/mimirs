import path from "node:path";
import * as paths from "node:path";
import { readFile, writeFile as write } from "node:fs/promises";
import fs, { existsSync as fileExists, type PathLike, type Stats } from "node:fs";

export const VERSION = "1.0.0";
const internalValue = path.sep;

export { internalValue as publicValue };
export { basename as fileName } from "node:path";
export type { Dirent } from "node:fs";
export * from "node:querystring";

export default function configure(root: PathLike): string {
  void paths;
  void readFile;
  void write;
  void fs;
  void fileExists;
  const stats: Stats | undefined = undefined;
  return `${VERSION}:${path.resolve(String(root))}:${stats ?? "none"}`;
}
