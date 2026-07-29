import { prepareCompiledRuntime } from "../internals/runtime/compiled.ts";

function printUsage(): void {
  console.log(`Usage: mimirs <command>

Commands:
  init     Initialize project state and configuration
  analyze  Analyze a multi-language project directory
  chunk    Analyze one source file (-f <file>, optionally --tree, --facts, or --windows)
  search   Search project source (-q <query> --max-results <n> [directory])
  inspect  Start the future inspection dashboard
  index    Configure and update searchable index domains
`);
}

async function main(): Promise<void> {
  const [command, ...args] = Bun.argv.slice(2);
  if (command !== "init") await prepareCompiledRuntime();

  switch (command) {
    case "init": {
      const { runInit } = await import("./commands/init.ts");
      process.exitCode = await runInit(args);
      return;
    }
    case "analyze": {
      const { runAnalyze } = await import("./commands/analyze.ts");
      process.exitCode = await runAnalyze(args);
      return;
    }
    case "chunk": {
      const { runChunk } = await import("./commands/chunk.ts");
      process.exitCode = await runChunk(args);
      return;
    }
    case "search": {
      const { runSearch } = await import("./commands/search.ts");
      process.exitCode = await runSearch(args);
      return;
    }
    case "index": {
      const { runIndex } = await import("./commands/index.ts");
      process.exitCode = await runIndex(args);
      return;
    }
    case "inspect": {
      const { inspect } = await import("./commands/inspect.ts");
      inspect();
      return;
    }
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
