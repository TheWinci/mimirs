#!/usr/bin/env bun

import { resolve } from "path";
import { RagDB } from "./db";
import { loadConfig, writeDefaultConfig } from "./config";
import { indexDirectory } from "./indexer";
import { search } from "./search";
import { loadBenchmarkQueries, runBenchmark, formatBenchmarkReport } from "./benchmark";
import { loadEvalTasks, runEval, formatEvalReport, saveEvalTraces } from "./eval";
import { generateMermaid } from "./graph";
import { embed } from "./embed";
import { discoverSessions } from "./conversation";
import { indexConversation } from "./conversation-index";

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
  local-rag map [dir] [--focus F]       Generate project dependency graph
                [--zoom file|directory]  (Mermaid format)
                [--max N]
  local-rag conversation search <query> Search conversation history
                [--dir D] [--top N]
  local-rag conversation sessions       List indexed sessions
                [--dir D]
  local-rag conversation index [--dir D] Index all sessions for a project
  local-rag checkpoint create <type>    Create a checkpoint
                <title> <summary>
                [--dir D] [--files f1,f2] [--tags t1,t2]
  local-rag checkpoint list [--dir D]   List checkpoints
                [--type T] [--top N]
  local-rag checkpoint search <query>   Search checkpoints
                [--dir D] [--type T] [--top N]

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
      const db = new RagDB(dir);
      const config = await loadConfig(dir);
      const top = parseInt(getFlag("--top") || String(config.searchTopK), 10);

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

    case "map": {
      const dir = getDir(1);
      const db = new RagDB(dir);
      const focus = getFlag("--focus");
      const zoom = (getFlag("--zoom") || "file") as "file" | "directory";
      const max = parseInt(getFlag("--max") || "50", 10);

      const mermaid = generateMermaid(db, {
        projectDir: dir,
        focus: focus ?? undefined,
        zoom,
        maxNodes: max,
      });

      console.log(mermaid);
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
      break;
    }

    case "benchmark": {
      const file = args[1];
      if (!file) {
        console.error("Usage: local-rag benchmark <file> [--dir D] [--top N]");
        process.exit(1);
      }

      const dir = resolve(getFlag("--dir") || ".");
      const db = new RagDB(dir);
      const config = await loadConfig(dir);
      const top = parseInt(getFlag("--top") || String(config.benchmarkTopK), 10);

      const queries = await loadBenchmarkQueries(resolve(file));
      console.log(`Running ${queries.length} benchmark queries against ${dir}...\n`);

      const summary = await runBenchmark(queries, db, dir, top);
      console.log(formatBenchmarkReport(summary, top));

      db.close();

      // Exit with non-zero if below thresholds
      if (summary.recallAtK < config.benchmarkMinRecall || summary.mrr < config.benchmarkMinMrr) {
        process.exit(1);
      }
      break;
    }

    case "conversation": {
      const subCommand = args[1];
      const dir = resolve(getFlag("--dir") || ".");
      const db = new RagDB(dir);

      if (subCommand === "search") {
        const query = args[2];
        if (!query) {
          console.error("Usage: local-rag conversation search <query> [--dir D] [--top N]");
          process.exit(1);
        }

        const config = await loadConfig(dir);
        const top = parseInt(getFlag("--top") || String(config.searchTopK), 10);

        // Ensure conversations are indexed
        const sessions = discoverSessions(dir);
        for (const session of sessions) {
          const existing = db.getSession(session.sessionId);
          if (!existing || existing.mtime < session.mtime) {
            await indexConversation(session.jsonlPath, session.sessionId, db);
          }
        }

        // Hybrid search
        const queryEmb = await embed(query);
        const vecResults = db.searchConversation(queryEmb, top);
        let bm25Results: typeof vecResults = [];
        try {
          bm25Results = db.textSearchConversation(query, top);
        } catch { /* FTS can fail on special chars */ }

        const merged = new Map<number, (typeof vecResults)[0]>();
        for (const r of vecResults) {
          merged.set(r.turnId, { ...r, score: r.score * config.hybridWeight });
        }
        for (const r of bm25Results) {
          const existing = merged.get(r.turnId);
          if (existing) {
            existing.score += r.score * (1 - config.hybridWeight);
          } else {
            merged.set(r.turnId, { ...r, score: r.score * (1 - config.hybridWeight) });
          }
        }

        const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, top);

        if (results.length === 0) {
          console.log("No conversation results found.");
        } else {
          for (const r of results) {
            const tools = r.toolsUsed.length > 0 ? ` [${r.toolsUsed.join(", ")}]` : "";
            console.log(`Turn ${r.turnIndex} (${r.timestamp})${tools}`);
            console.log(`  ${r.snippet.slice(0, 200)}`);
            if (r.filesReferenced.length > 0) {
              console.log(`  Files: ${r.filesReferenced.slice(0, 5).join(", ")}`);
            }
            console.log();
          }
        }
      } else if (subCommand === "sessions") {
        const sessions = discoverSessions(dir);
        if (sessions.length === 0) {
          console.log("No conversation sessions found for this project.");
        } else {
          for (const s of sessions) {
            const indexed = db.getSession(s.sessionId);
            const status = indexed ? `${indexed.turnCount} turns indexed` : "not indexed";
            const date = new Date(s.mtime).toISOString().slice(0, 19);
            console.log(`  ${s.sessionId.slice(0, 8)}...  ${date}  ${status}  (${(s.size / 1024).toFixed(0)}KB)`);
          }
        }
      } else if (subCommand === "index") {
        const sessions = discoverSessions(dir);
        if (sessions.length === 0) {
          console.log("No conversation sessions found for this project.");
        } else {
          console.log(`Found ${sessions.length} sessions, indexing...`);
          let totalTurns = 0;
          for (const session of sessions) {
            const result = await indexConversation(session.jsonlPath, session.sessionId, db);
            totalTurns += result.turnsIndexed;
            if (result.turnsIndexed > 0) {
              console.log(`  ${session.sessionId.slice(0, 8)}...: ${result.turnsIndexed} turns`);
            }
          }
          console.log(`Done: ${totalTurns} turns indexed across ${sessions.length} sessions`);
        }
      } else {
        console.error("Usage: local-rag conversation <search|sessions|index>");
        process.exit(1);
      }

      db.close();
      break;
    }

    case "checkpoint": {
      const subCommand = args[1];
      const dir = resolve(getFlag("--dir") || ".");
      const db = new RagDB(dir);

      if (subCommand === "create") {
        const type = args[2];
        const title = args[3];
        const summary = args[4];
        if (!type || !title || !summary) {
          console.error("Usage: local-rag checkpoint create <type> <title> <summary> [--dir D] [--files f1,f2] [--tags t1,t2]");
          process.exit(1);
        }

        const filesStr = getFlag("--files");
        const tagsStr = getFlag("--tags");
        const filesInvolved = filesStr ? filesStr.split(",").map((f) => f.trim()) : [];
        const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()) : [];

        const sessions = discoverSessions(dir);
        const sessionId = sessions.length > 0 ? sessions[0].sessionId : "unknown";
        const turnCount = db.getTurnCount(sessionId);
        const turnIndex = Math.max(0, turnCount - 1);

        const embedding = await embed(`${title}. ${summary}`);
        const id = db.createCheckpoint(
          sessionId, turnIndex, new Date().toISOString(),
          type, title, summary, filesInvolved, tags, embedding
        );
        console.log(`Checkpoint #${id} created: [${type}] ${title}`);
      } else if (subCommand === "list") {
        const type = getFlag("--type");
        const top = parseInt(getFlag("--top") || "20", 10);
        const checkpoints = db.listCheckpoints(undefined, type, top);

        if (checkpoints.length === 0) {
          console.log("No checkpoints found.");
        } else {
          for (const cp of checkpoints) {
            const tagStr = cp.tags.length > 0 ? ` [${cp.tags.join(", ")}]` : "";
            console.log(`#${cp.id} [${cp.type}] ${cp.title}${tagStr}`);
            console.log(`  ${cp.timestamp} (turn ${cp.turnIndex})`);
            console.log(`  ${cp.summary}`);
            if (cp.filesInvolved.length > 0) {
              console.log(`  Files: ${cp.filesInvolved.join(", ")}`);
            }
            console.log();
          }
        }
      } else if (subCommand === "search") {
        const query = args[2];
        if (!query) {
          console.error("Usage: local-rag checkpoint search <query> [--dir D] [--type T] [--top N]");
          process.exit(1);
        }

        const type = getFlag("--type");
        const top = parseInt(getFlag("--top") || "5", 10);
        const queryEmb = await embed(query);
        const results = db.searchCheckpoints(queryEmb, top, type);

        if (results.length === 0) {
          console.log("No matching checkpoints found.");
        } else {
          for (const cp of results) {
            console.log(`${cp.score.toFixed(4)}  #${cp.id} [${cp.type}] ${cp.title}`);
            console.log(`  ${cp.summary}`);
            if (cp.filesInvolved.length > 0) {
              console.log(`  Files: ${cp.filesInvolved.join(", ")}`);
            }
            console.log();
          }
        }
      } else {
        console.error("Usage: local-rag checkpoint <create|list|search>");
        process.exit(1);
      }

      db.close();
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
