import { runAnalyze } from "./commands/analyze.ts";
import { runChunk } from "./commands/chunk.ts";
import { inspect } from "./commands/inspect.ts";
import { runIndex } from "./commands/index.ts";
import { runSearch } from "./commands/search.ts";

function printUsage(): void {
  console.log(`Usage: bun run src/cli/index.ts <command>

Commands:
  analyze  Analyze a multi-language project directory
  chunk    Analyze one source file (-f <file>, optionally --tree, --facts, or --windows)
  search   Search project source (-q <query> --max-results <n> [directory])
  inspect  Start the future inspection dashboard
  index    Configure and update searchable index domains
`);
}

async function main(): Promise<void> {
  const [command, ...args] = Bun.argv.slice(2);

  switch (command) {
    case "analyze":
      process.exitCode = await runAnalyze(args);
      return;
    case "chunk":
      process.exitCode = await runChunk(args);
      return;
    case "search":
      process.exitCode = await runSearch(args);
      return;
    case "index":
      process.exitCode = await runIndex(args);
      return;
    case "inspect":
      inspect();
      return;
    case undefined:
      printUsage();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exitCode = 1;
  }
}

await main();
