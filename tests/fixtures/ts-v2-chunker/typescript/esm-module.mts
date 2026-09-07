import type { Stats } from "node:fs";
import { resolve } from "node:path";

export type { Stats };

export const config = resolve(".");

export default config;
