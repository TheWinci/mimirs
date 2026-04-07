import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { loadBenchmarkQueries, runBenchmark, formatBenchmarkReport } from "../../search/benchmark";
import { cli } from "../../utils/log";

export async function benchmarkCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const file = args[1];
  if (!file) {
    cli.error("Usage: local-rag benchmark <file> [--dir D] [--top N]");
    process.exit(1);
  }

  const dir = resolve(getFlag("--dir") || ".");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  const top = parseInt(getFlag("--top") || String(config.benchmarkTopK), 10);

  const queries = await loadBenchmarkQueries(resolve(file));
  cli.log(`Running ${queries.length} benchmark queries against ${dir}...\n`);

  const summary = await runBenchmark(queries, db, dir, top);
  cli.log(formatBenchmarkReport(summary, top));

  db.close();

  // Exit with non-zero if below thresholds
  if (summary.recallAtK < config.benchmarkMinRecall || summary.mrr < config.benchmarkMinMrr) {
    process.exit(1);
  }
}
