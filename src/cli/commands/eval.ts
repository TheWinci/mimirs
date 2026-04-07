import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { loadEvalTasks, runEval, formatEvalReport, saveEvalTraces } from "../../search/eval";
import { cli } from "../../utils/log";

export async function evalCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const file = args[1];
  if (!file) {
    cli.error("Usage: local-rag eval <file> [--dir D] [--top N] [--out F]");
    process.exit(1);
  }

  const dir = resolve(getFlag("--dir") || ".");
  const outPath = getFlag("--out");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  const top = parseInt(getFlag("--top") || String(config.benchmarkTopK), 10);

  const tasks = await loadEvalTasks(resolve(file));
  cli.log(`Running A/B eval with ${tasks.length} tasks against ${dir}...\n`);

  const summary = await runEval(tasks, db, dir, top);
  cli.log(formatEvalReport(summary));

  if (outPath) {
    await saveEvalTraces(summary.traces, resolve(outPath));
    cli.log(`\nTraces saved to ${outPath}`);
  }

  db.close();
}
