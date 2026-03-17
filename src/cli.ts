#!/usr/bin/env bun

import { resolve } from "path";
import { RagDB } from "./db";
import { loadConfig, writeDefaultConfig } from "./config";
import { indexDirectory } from "./indexer";
import { search } from "./search";
import { loadBenchmarkQueries, runBenchmark, formatBenchmarkReport } from "./benchmark";
import { loadEvalTasks, runEval, formatEvalReport, saveEvalTraces } from "./eval";

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`local-rag — Local RAG for semantic file search

Usage:
  local-rag init [dir]                    Create default .rag/config.json
  local-rag index [dir] [--patterns ...]  Index files in directory
  local-rag search <query> [--top N]      Search indexed files
  local-rag status [dir]                  Show index stats
  local-rag remove <file> [dir]           Remove file from index
  local-rag analytics [dir] [--days N]    Show search usage analytics
  local-rag benchmark <file> [--dir D]   Run search quality benchmark
                       [--top N]
  local-rag eval <file> [--dir D]       Run A/B eval (with/without RAG)
                  [--top N] [--out F]

Options:
  dir       Project directory (default: current directory)
  --top N   Number of results (default: 5)
  --patterns  Comma-separated glob patterns to include`);
}

function getDir(argIndex: number): string {
  const dir = args[argIndex];
  return resolve(dir && !dir.startsWith("--") ? dir : ".");
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }

  switch (command) {
    case "init": {
      const dir = getDir(1);
      const path = await writeDefaultConfig(dir);
      console.log(`Created config: ${path}`);
      break;
    }

    case "index": {
      const dir = getDir(1);
      const db = new RagDB(dir);
      const config = await loadConfig(dir);

      const patternsStr = getFlag("--patterns");
      if (patternsStr) {
        config.include = patternsStr.split(",").map((p) => p.trim());
      }

      console.log(`Indexing ${dir}...`);
      const result = await indexDirectory(dir, db, config, console.log);
      console.log(
        `\nDone: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`
      );
      if (result.errors.length > 0) {
        console.error(`Errors: ${result.errors.join("\n  ")}`);
      }
      db.close();
      break;
    }

    case "search": {
      const query = args[1];
      if (!query) {
        console.error("Usage: local-rag search <query> [--top N]");
        process.exit(1);
      }

      const dir = resolve(getFlag("--dir") || ".");
      const top = parseInt(getFlag("--top") || "5", 10);
      const db = new RagDB(dir);
      const config = await loadConfig(dir);

      const results = await search(query, db, top, 0, config.hybridWeight);

      if (results.length === 0) {
        console.log("No results found. Has the directory been indexed?");
      } else {
        for (const r of results) {
          console.log(`${r.score.toFixed(4)}  ${r.path}`);
          const preview = r.snippets[0]?.slice(0, 120).replace(/\n/g, " ");
          console.log(`         ${preview}...`);
          console.log();
        }
      }
      db.close();
      break;
    }

    case "status": {
      const dir = getDir(1);
      const db = new RagDB(dir);
      const status = db.getStatus();
      console.log(`Index status for ${dir}:`);
      console.log(`  Files:        ${status.totalFiles}`);
      console.log(`  Chunks:       ${status.totalChunks}`);
      console.log(`  Last indexed: ${status.lastIndexed || "never"}`);
      db.close();
      break;
    }

    case "remove": {
      const file = args[1];
      if (!file) {
        console.error("Usage: local-rag remove <file> [dir]");
        process.exit(1);
      }
      const dir = getDir(2);
      const db = new RagDB(dir);
      const removed = db.removeFile(resolve(file));
      console.log(removed ? `Removed ${file}` : `${file} was not in the index`);
      db.close();
      break;
    }

    case "analytics": {
      const dir = getDir(1);
      const days = parseInt(getFlag("--days") || "30", 10);
      const db = new RagDB(dir);
      const analytics = db.getAnalytics(days);

      const zeroCount = analytics.zeroResultQueries.reduce((s, q) => s + q.count, 0);
      const zeroRate = analytics.totalQueries > 0
        ? ((zeroCount / analytics.totalQueries) * 100).toFixed(0)
        : "0";

      console.log(`Search analytics (last ${days} days):`);
      console.log(`  Total queries:    ${analytics.totalQueries}`);
      console.log(`  Avg results:      ${analytics.avgResultCount.toFixed(1)}`);
      console.log(`  Avg top score:    ${analytics.avgTopScore?.toFixed(2) ?? "n/a"}`);
      console.log(`  Zero-result rate: ${zeroRate}% (${zeroCount} queries)`);

      if (analytics.topSearchedTerms.length > 0) {
        console.log("\nTop searches:");
        for (const t of analytics.topSearchedTerms) {
          console.log(`  ${t.count}× "${t.query}"`);
        }
      }

      if (analytics.zeroResultQueries.length > 0) {
        console.log("\nZero-result queries (consider indexing these topics):");
        for (const q of analytics.zeroResultQueries) {
          console.log(`  ${q.count}× "${q.query}"`);
        }
      }

      if (analytics.lowScoreQueries.length > 0) {
        console.log("\nLow-relevance queries (top score < 0.3):");
        for (const q of analytics.lowScoreQueries) {
          console.log(`  "${q.query}" (score: ${q.topScore.toFixed(2)})`);
        }
      }

      // Trend comparison vs prior period
      const trend = db.getAnalyticsTrend(days);
      if (trend.previous.totalQueries > 0 || trend.current.totalQueries > 0) {
        const arrow = (delta: number) => delta > 0 ? `+${delta}` : `${delta}`;
        const pctArrow = (delta: number) =>
          delta > 0 ? `+${(delta * 100).toFixed(1)}%` : `${(delta * 100).toFixed(1)}%`;

        console.log(`\nTrend (current ${days}d vs prior ${days}d):`);
        console.log(`  Queries:          ${trend.current.totalQueries} (${arrow(trend.delta.queries)})`);
        if (trend.delta.avgTopScore !== null) {
          console.log(`  Avg top score:    ${trend.current.avgTopScore?.toFixed(2)} (${trend.delta.avgTopScore >= 0 ? "+" : ""}${trend.delta.avgTopScore.toFixed(2)})`);
        }
        console.log(`  Zero-result rate: ${(trend.current.zeroResultRate * 100).toFixed(0)}% (${pctArrow(trend.delta.zeroResultRate)})`);
      }

      db.close();
      break;
    }

    case "eval": {
      const file = args[1];
      if (!file) {
        console.error("Usage: local-rag eval <file> [--dir D] [--top N] [--out F]");
        process.exit(1);
      }

      const dir = resolve(getFlag("--dir") || ".");
      const top = parseInt(getFlag("--top") || "5", 10);
      const outPath = getFlag("--out");
      const db = new RagDB(dir);

      const tasks = await loadEvalTasks(resolve(file));
      console.log(`Running A/B eval with ${tasks.length} tasks against ${dir}...\n`);

      const summary = await runEval(tasks, db, dir, top);
      console.log(formatEvalReport(summary));

      if (outPath) {
        await saveEvalTraces(summary.traces, resolve(outPath));
        console.log(`\nTraces saved to ${outPath}`);
      }

      db.close();
      break;
    }

    case "benchmark": {
      const file = args[1];
      if (!file) {
        console.error("Usage: local-rag benchmark <file> [--dir D] [--top N]");
        process.exit(1);
      }

      const dir = resolve(getFlag("--dir") || ".");
      const top = parseInt(getFlag("--top") || "5", 10);
      const db = new RagDB(dir);

      const queries = await loadBenchmarkQueries(resolve(file));
      console.log(`Running ${queries.length} benchmark queries against ${dir}...\n`);

      const summary = await runBenchmark(queries, db, dir, top);
      console.log(formatBenchmarkReport(summary, top));

      db.close();

      // Exit with non-zero if below thresholds
      if (summary.recallAtK < 0.8 || summary.mrr < 0.6) {
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
