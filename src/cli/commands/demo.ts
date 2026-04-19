import { resolve, relative } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { indexDirectory } from "../../indexing/indexer";
import { search, searchChunks } from "../../search/hybrid";
import { cliProgress, createQuietProgress } from "../progress";
import { cli } from "../../utils/log";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function header(text: string) {
  cli.log(`\n${BOLD}${CYAN}--- ${text} ---${RESET}\n`);
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function renderBlock(text: string, indent: string, maxLines: number, wrap: number): string[] {
  const lines = text.split("\n");
  const shown = lines
    .slice(0, maxLines)
    .map((l) => indent + (l.length > wrap ? l.slice(0, wrap - 1) + "…" : l));
  if (lines.length > maxLines) {
    shown.push(`${indent}${DIM}… (+${lines.length - maxLines} more lines)${RESET}`);
  }
  return shown;
}

export async function demoCommand(args: string[]) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");

  cli.log(`${BOLD}mimirs demo${RESET}`);
  cli.log(`${DIM}Running against: ${dir}${RESET}`);

  header("1. Index your project");
  cli.log("Indexing files with AST-aware chunking...\n");

  const db = new RagDB(dir);
  const config = await loadConfig(dir);

  let quietProgress: ReturnType<typeof createQuietProgress> | null = null;
  const progress = (msg: string, opts?: { transient?: boolean }) => {
    const foundMatch = msg.match(/^Found (\d+) files to index$/);
    if (foundMatch) quietProgress = createQuietProgress(parseInt(foundMatch[1], 10));
    if (quietProgress) quietProgress(msg, opts);
    else cliProgress(msg, opts);
  };

  const result = await indexDirectory(dir, db, config, progress);
  cli.log(
    `\n${GREEN}Done:${RESET} ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`
  );
  await pause(500);

  const demoQuery = "AST-aware chunking with tree-sitter";

  header("2. search — ranked files for a query");
  cli.log(`${DIM}> search "${demoQuery}"${RESET}\n`);

  const searchResults = (await search(demoQuery, db, 3, 0, config.hybridWeight, config.generated)).slice(0, 3);
  if (searchResults.length > 0) {
    for (const r of searchResults) {
      cli.log(`  ${YELLOW}${r.score.toFixed(4)}${RESET}  ${relative(dir, r.path)}`);
      const snippet = r.snippets[0] ?? "";
      for (const line of renderBlock(snippet, "    ", 3, 96)) {
        cli.log(`${DIM}${line}${RESET}`);
      }
      cli.log();
    }
  } else {
    cli.log("  No results — try a query related to your project.");
  }
  await pause(500);

  header("3. read_relevant — ranked chunks with exact line ranges");
  cli.log(`${DIM}> read_relevant "${demoQuery}"${RESET}\n`);

  const chunks = await searchChunks(demoQuery, db, 2, 0.3, config.hybridWeight, config.generated);
  if (chunks.length > 0) {
    for (const r of chunks) {
      const lineRange = r.startLine != null && r.endLine != null ? `:${r.startLine}-${r.endLine}` : "";
      const entity = r.entityName ? `  ${CYAN}${r.entityName}${RESET}` : "";
      cli.log(`  ${YELLOW}[${r.score.toFixed(2)}]${RESET} ${relative(dir, r.path)}${lineRange}${entity}`);
      for (const line of renderBlock(r.content, "    ", 18, 96)) {
        cli.log(`${DIM}${line}${RESET}`);
      }
      cli.log();
    }
  } else {
    cli.log("  No chunks above threshold.");
  }
  await pause(500);

  header("4. search_symbols — most-referenced symbols in the codebase");
  const listing = db.searchSymbols(undefined, false, undefined, 200);
  const topSymbols = listing
    .filter((s) => !s.isReexport && s.referenceCount > 0)
    .sort((a, b) => b.referenceCount - a.referenceCount)
    .slice(0, 5);

  if (topSymbols.length > 0) {
    cli.log(`${DIM}> search_symbols   # listing mode, ranked by import count${RESET}\n`);
    for (const s of topSymbols) {
      const refs = `${MAGENTA}${s.referenceCount}${RESET} importers across ${s.referenceModuleCount} module${s.referenceModuleCount === 1 ? "" : "s"}`;
      cli.log(`  ${CYAN}${s.symbolName}${RESET} ${DIM}(${s.symbolType})${RESET}  ${refs}`);
      cli.log(`    ${DIM}${relative(dir, s.path)}${RESET}\n`);
    }
  } else {
    cli.log("  No exported symbols indexed yet.");
  }
  await pause(500);

  header("Done");
  cli.log(`${BOLD}Add mimirs to your editor:${RESET}`);
  cli.log(`  bunx mimirs init --ide claude   ${DIM}# or: cursor, windsurf, copilot, jetbrains, all${RESET}`);
  cli.log(`\n${DIM}Docs & more tools: https://github.com/TheWinci/mimirs${RESET}`);

  db.close();
}
