import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig, applyEmbeddingConfig } from "../../config";
import { indexGitHistory } from "../../git/indexer";
import { embed } from "../../embeddings/embed";
import { cliProgress, createQuietProgress } from "../progress";
import { cli } from "../../utils/log";

export async function historyCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const subcommand = args[1];

  switch (subcommand) {
    case "index":
      await historyIndexCommand(args, getFlag);
      break;
    case "search":
      await historySearchCommand(args, getFlag);
      break;
    case "status":
      await historyStatusCommand(args);
      break;
    default:
      cli.log(`Usage:
  mimirs history index [dir]                  Index git commit history
              [--since REF] [-v|--verbose]
  mimirs history search <query> [--top N]     Search commit history
              [--author A] [--since S]
  mimirs history status [dir]                 Show git history index stats`);
      if (subcommand) {
        cli.error(`Unknown subcommand: ${subcommand}`);
        process.exit(1);
      }
  }
}

async function historyIndexCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[2] && !args[2].startsWith("--") ? args[2] : ".");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const since = getFlag("--since");
  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  applyEmbeddingConfig(config);

  const startTime = Date.now();

  const result = await indexGitHistory(dir, db, {
    since: since || undefined,
    threads: config.indexThreads,
    onProgress: verbose ? cliProgress : (msg, opts) => {
      // In quiet mode, only show summary messages
      if (opts?.transient) return;
      if (msg.startsWith("Scanning") || msg.startsWith("Found") ||
          msg.startsWith("Indexing") || msg.startsWith("No ") ||
          msg.startsWith("All ") || msg.startsWith("Warning")) {
        cli.log(msg);
      }
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  cli.log(`Done: ${result.indexed} indexed, ${result.skipped} skipped (${elapsed}s)`);
  db.close();
}

async function historySearchCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const query = args[2];
  if (!query || query.startsWith("--")) {
    cli.error("Usage: mimirs history search <query> [--top N] [--author A] [--since S]");
    process.exit(1);
  }

  const dir = resolve(getFlag("--dir") || ".");
  const top = parseInt(getFlag("--top") || "10", 10);
  const author = getFlag("--author");
  const since = getFlag("--since");
  const db = new RagDB(dir);

  const status = db.getGitHistoryStatus();
  if (status.totalCommits === 0) {
    cli.log("No git history indexed. Run: mimirs history index");
    db.close();
    return;
  }

  const queryEmbedding = await embed(query);

  // Hybrid search
  const vectorResults = db.searchGitCommits(queryEmbedding, top, author, since);
  const textResults = db.textSearchGitCommits(query, top, author, since);

  const seen = new Map<string, typeof vectorResults[0]>();
  for (const r of vectorResults) seen.set(r.hash, r);
  for (const r of textResults) {
    const existing = seen.get(r.hash);
    if (existing) {
      existing.score = 0.7 * existing.score + 0.3 * r.score;
    } else {
      seen.set(r.hash, { ...r, score: 0.3 * r.score });
    }
  }

  const results = [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  if (results.length === 0) {
    cli.log(`No commits found matching "${query}"`);
    db.close();
    return;
  }

  cli.log(`Results for "${query}" (${results.length} of ${status.totalCommits} indexed):\n`);
  for (const r of results) {
    const date = r.date.split("T")[0];
    const files = r.filesChanged.slice(0, 3).join(", ");
    const more = r.filesChanged.length > 3 ? ` +${r.filesChanged.length - 3} more` : "";
    cli.log(`  ${r.shortHash}  ${(r.score).toFixed(2)}  ${date}  @${r.authorName}`);
    cli.log(`    ${r.message.split("\n")[0]}`);
    cli.log(`    ${files}${more} (+${r.insertions} -${r.deletions})`);
    cli.log("");
  }

  db.close();
}

async function historyStatusCommand(args: string[]) {
  const dir = resolve(args[2] && !args[2].startsWith("--") ? args[2] : ".");
  const db = new RagDB(dir);

  const status = db.getGitHistoryStatus();

  if (status.totalCommits === 0) {
    cli.log("No git history indexed. Run: mimirs history index");
  } else {
    cli.log(`Git history: ${status.totalCommits} commits indexed`);
    cli.log(`Last commit: ${status.lastCommitHash?.slice(0, 8)} (${status.lastCommitDate?.split("T")[0]})`);
  }

  db.close();
}
