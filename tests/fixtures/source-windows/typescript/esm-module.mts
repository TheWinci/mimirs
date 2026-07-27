import { readFile } from "node:fs/promises";

export type ReportConfig = {
  path: string;
  encoding: BufferEncoding;
};

/** Read one report using native ESM. */
export async function readReport(config: ReportConfig): Promise<string> {
  const contents = await readFile(config.path, config.encoding);
  return contents.trim();
}

export const defaultConfig: ReportConfig = {
  path: "./report.md",
  encoding: "utf8",
};
