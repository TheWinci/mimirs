import { positionalArg } from "../flags";
import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig, type RagConfig } from "../../config";
import { indexDirectory, type IndexResult } from "../../indexing/indexer";
import { DropboxError, withIndexAccess } from "../../control/producer";
import { historyIndexCommand } from "./history";
import { conversationIndexCommand } from "./conversation";
import { cliProgress, createQuietProgress } from "../progress";
import { cli } from "../../utils/log";

/**
 * `mimirs index [dir]` — and its subcommands:
 *
 *   mimirs index files [dir]        same as the bare form (explicit alias)
 *   mimirs index git [dir]          alias of `mimirs history index`
 *   mimirs index conversation       alias of `mimirs conversation index`
 *
 * File indexing uses the three-step fallback (in-process when the lock is
 * free or stale, drop-box to the live server otherwise). The bare form used
 * to run `indexDirectory` beside a live server, lose the lock race inside
 * it, and print "Done: 0 indexed" as if it had worked. A directory literally
 * named like a subcommand can be addressed as `./git`.
 */
export async function indexCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const sub = args[1];
  if (sub === "git") {
    await historyIndexCommand(args, getFlag); // args[2] is the dir, same shape as `history index`
    return;
  }
  if (sub === "conversation") {
    const dir = resolve(positionalArg(args[2], getFlag("--dir") ?? "."));
    await conversationIndexCommand(dir, args.includes("--rebuild"));
    return;
  }

  const dir = resolve(positionalArg(sub === "files" ? args[2] : args[1], "."));
  const verbose = args.includes("--verbose") || args.includes("-v");
  // RagDB (opened in the local path) applies the project's embedding config
  // before creating its schema, so no separate applyEmbeddingConfig call.
  const config = await loadConfig(dir);

  const patternsStr = getFlag("--patterns");
  const patterns = patternsStr ? patternsStr.split(",").map((p) => p.trim()) : undefined;
  if (patterns) config.include = patterns;

  cli.log(`Indexing ${dir}...`);
  const startTime = Date.now();

  try {
    const access = await withIndexAccess(
      dir,
      () => runLocalFilesIndex(dir, config, verbose),
      { cmd: "index.files", args: patterns ? { patterns } : {} },
      { onProgress: (msg) => cli.log(`  server: ${msg}`) },
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (access.mode === "local") {
      const result = access.value;
      cli.log(
        `\nDone: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned (${elapsed}s)`
      );
      if (result.errors.length > 0) {
        cli.error(`Errors: ${result.errors.join("\n  ")}`);
      }
    } else if (access.result.status === "ok") {
      const s = access.result.stats ?? {};
      cli.log(
        `\nDone (via live server): ${s.indexed ?? "?"} indexed, ${s.skipped ?? "?"} skipped, ${s.pruned ?? "?"} pruned (${elapsed}s)`
      );
    } else {
      cli.error(`Live server returned ${access.result.status}${access.result.detail ? `: ${access.result.detail}` : ""}`);
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof DropboxError) {
      cli.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function runLocalFilesIndex(dir: string, config: RagConfig, verbose: boolean): Promise<IndexResult> {
  const db = new RagDB(dir);
  try {
    let quietProgress: ReturnType<typeof createQuietProgress> | null = null;

    const progress = verbose ? cliProgress : (msg: string, opts?: { transient?: boolean }) => {
      const foundMatch = msg.match(/^Found (\d+) files to index$/);
      if (foundMatch) {
        quietProgress = createQuietProgress(parseInt(foundMatch[1], 10));
      }

      if (quietProgress) {
        quietProgress(msg, opts);
      } else {
        cliProgress(msg, opts);
      }
    };

    return await indexDirectory(dir, db, config, progress);
  } finally {
    db.close();
  }
}
