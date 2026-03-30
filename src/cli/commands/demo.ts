import { resolve } from "path";
import { RagDB } from "../../db";
import { loadConfig } from "../../config";
import { indexDirectory } from "../../indexing/indexer";
import { search, searchChunks } from "../../search/hybrid";
import { cliProgress } from "../progress";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function header(text: string) {
  console.log(`\n${BOLD}${CYAN}--- ${text} ---${RESET}\n`);
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function demoCommand(args: string[]) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");

  console.log(`${BOLD}local-rag demo${RESET}`);
  console.log(`${DIM}Running against: ${dir}${RESET}`);

  // Step 1: Index
  header("1. Index your project");
  console.log("Indexing files with AST-aware chunking...\n");

  const db = new RagDB(dir);
  const config = await loadConfig(dir);
  const result = await indexDirectory(dir, db, config, cliProgress);
  console.log(
    `\n${GREEN}Done:${RESET} ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned`
  );
  await pause(500);

  // Step 2: Semantic search
  header("2. Semantic search");
  const demoQuery = "how does search work";
  console.log(`${DIM}> search "${demoQuery}"${RESET}\n`);

  const searchResults = await search(demoQuery, db, 3, 0, config.hybridWeight, config.generated);
  if (searchResults.length > 0) {
    for (const r of searchResults) {
      console.log(`  ${YELLOW}${r.score.toFixed(4)}${RESET}  ${r.path}`);
      const preview = r.snippets[0]?.slice(0, 100).replace(/\n/g, " ");
      console.log(`  ${DIM}${preview}...${RESET}\n`);
    }
  } else {
    console.log("  No results — try a query related to your project.");
  }
  await pause(500);

  // Step 3: Chunk-level retrieval
  header("3. Chunk-level retrieval (read_relevant)");
  console.log(`${DIM}> read_relevant "${demoQuery}"${RESET}\n`);

  const chunks = await searchChunks(demoQuery, db, 2, 0.3, config.hybridWeight, config.generated);
  if (chunks.length > 0) {
    for (const r of chunks) {
      const lineRange = r.startLine != null && r.endLine != null ? `:${r.startLine}-${r.endLine}` : "";
      const entity = r.entityName ? `  ${CYAN}${r.entityName}${RESET}` : "";
      console.log(`  ${YELLOW}[${r.score.toFixed(2)}]${RESET} ${r.path}${lineRange}${entity}`);
      // Show first 3 lines of content
      const lines = r.content.split("\n").slice(0, 3);
      for (const line of lines) {
        console.log(`  ${DIM}${line}${RESET}`);
      }
      console.log();
    }
  } else {
    console.log("  No chunks above threshold.");
  }
  await pause(500);

  // Step 4: Symbol search
  header("4. Symbol search (find_usages)");
  const symbols = db.searchSymbols("search", false, undefined, 3);
  if (symbols.length > 0) {
    console.log(`${DIM}> search_symbols "search"${RESET}\n`);
    for (const s of symbols) {
      console.log(`  ${s.path}  ${CYAN}${s.symbolName}${RESET} (${s.symbolType})`);
    }
  } else {
    console.log("  No exported symbols found matching 'search'.");
  }
  await pause(500);

  // Step 5: Project map
  header("5. Project map");
  console.log(
    `${DIM}The project_map tool generates a Mermaid dependency graph\n` +
    `showing how files import from each other. Run:${RESET}\n\n` +
    `  local-rag map ${dir}\n`
  );

  // Step 6: Unique features summary
  header("6. What no other tool does");
  console.log(`  ${GREEN}search_conversation${RESET}  Search past AI session history`);
  console.log(`  ${GREEN}create_checkpoint${RESET}    Mark decisions, milestones, blockers`);
  console.log(`  ${GREEN}annotate${RESET}             Attach notes to files/symbols (surface in search)`);
  console.log(`  ${GREEN}find_usages${RESET}          Find all call sites before refactoring`);
  console.log(`  ${GREEN}project_map${RESET}          Mermaid dependency graph`);
  console.log(`  ${GREEN}git_context${RESET}          Uncommitted changes + index status`);
  console.log(`  ${GREEN}search_analytics${RESET}     Find documentation gaps`);
  console.log(`  ${GREEN}write_relevant${RESET}       Find best insertion point for new code`);

  console.log(`\n${BOLD}Done.${RESET} Add to your editor with:\n`);
  console.log(`  ${DIM}# Start the MCP server${RESET}`);
  console.log(`  bunx @winci/local-rag serve\n`);
  console.log(`  ${DIM}# Then add to your editor's MCP config (Claude Code, Cursor, Windsurf, VS Code):${RESET}`);
  console.log(`  { "mcpServers": { "local-rag": { "command": "bunx", "args": ["@winci/local-rag", "serve"] } } }\n`);

  db.close();
}
