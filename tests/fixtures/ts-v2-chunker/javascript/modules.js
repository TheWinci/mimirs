import path from "node:path";
import * as paths from "node:path";
import { readFile, writeFile as write } from "node:fs/promises";
import "./setup.js";

export const VERSION = "1.0.0";
const internalValue = 1;

export { internalValue as publicValue };
export { basename as fileName } from "node:path";
export * from "node:querystring";

export default function configure(root) {
  return path.resolve(root, paths.join("config", String(internalValue)));
}
