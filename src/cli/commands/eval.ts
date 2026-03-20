import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { loadEvalTasks, runEval, formatEvalReport, saveEvalTraces } from "../../search/eval";

export async function evalCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const file = args[1];
  if (!file) {
    console.error("Usage: local-rag-mcp eval <file> [--dir D] [--top N] [--out F]");
    process.exit(1);
  }

  const dir = resolve(getFlag("--dir") || ".");
  const outPath = getFlag("--out");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  const top = parseInt(getFlag("--top") || String(config.benchmarkTopK), 10);

  const tasks = await loadEvalTasks(resolve(file));
  console.log(`Running A/B eval with ${tasks.length} tasks against ${dir}...\n`);

  const summary = await runEval(tasks, db, dir, top);
  console.log(formatEvalReport(summary));

  if (outPath) {
    await saveEvalTraces(summary.traces, resolve(outPath));
    console.log(`\nTraces saved to ${outPath}`);
  }

  db.close();
}
