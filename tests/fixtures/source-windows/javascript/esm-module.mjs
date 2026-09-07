import { readFile } from "node:fs/promises";

export const reportPath = new URL("./report.md", import.meta.url);

/** Load and normalize one ESM report. */
export async function loadReport(path = reportPath) {
  const contents = await readFile(path, "utf8");
  return contents.trim();
}

export default loadReport;
