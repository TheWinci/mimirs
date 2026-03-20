import { initCommand } from "./commands/init";
import { indexCommand } from "./commands/index-cmd";
import { searchCommand, readCommand } from "./commands/search-cmd";
import { statusCommand } from "./commands/status";
import { removeCommand } from "./commands/remove";
import { analyticsCommand } from "./commands/analytics";
import { mapCommand } from "./commands/map";
import { benchmarkCommand } from "./commands/benchmark";
import { evalCommand } from "./commands/eval";
import { conversationCommand } from "./commands/conversation";
import { checkpointCommand } from "./commands/checkpoint";
import { serveCommand } from "./commands/serve";

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`local-rag-mcp — Local RAG for semantic file search

Usage:
  local-rag-mcp serve                      Start MCP server (stdio)
  local-rag-mcp init [dir]                 Create default .rag/config.json
  local-rag-mcp index [dir] [--patterns ...] Index files in directory
  local-rag-mcp search <query> [--top N]   Search indexed files
  local-rag-mcp read <query> [--top N]     Read relevant chunks (full content)
              [--threshold T] [--dir D]
  local-rag-mcp status [dir]               Show index stats
  local-rag-mcp remove <file> [dir]        Remove file from index
  local-rag-mcp analytics [dir] [--days N] Show search usage analytics
  local-rag-mcp benchmark <file> [--dir D] Run search quality benchmark
                       [--top N]
  local-rag-mcp eval <file> [--dir D]      Run A/B eval (with/without RAG)
                  [--top N] [--out F]
  local-rag-mcp map [dir] [--focus F]      Generate project dependency graph
                [--zoom file|directory]     (Mermaid format)
                [--max N]
  local-rag-mcp conversation search <query> Search conversation history
                [--dir D] [--top N]
  local-rag-mcp conversation sessions      List indexed sessions
                [--dir D]
  local-rag-mcp conversation index [--dir D] Index all sessions for a project
  local-rag-mcp checkpoint create <type>   Create a checkpoint
                <title> <summary>
                [--dir D] [--files f1,f2] [--tags t1,t2]
  local-rag-mcp checkpoint list [--dir D]  List checkpoints
                [--type T] [--top N]
  local-rag-mcp checkpoint search <query>  Search checkpoints
                [--dir D] [--type T] [--top N]

Options:
  dir       Project directory (default: current directory)
  --top N   Number of results (default: 5)
  --patterns  Comma-separated glob patterns to include`);
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

export async function main() {
  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }

  switch (command) {
    case "serve":
      await serveCommand();
      break;
    case "init":
      await initCommand(args, getFlag);
      break;
    case "index":
      await indexCommand(args, getFlag);
      break;
    case "search":
      await searchCommand(args, getFlag);
      break;
    case "read":
      await readCommand(args, getFlag);
      break;
    case "status":
      await statusCommand(args);
      break;
    case "remove":
      await removeCommand(args);
      break;
    case "analytics":
      await analyticsCommand(args, getFlag);
      break;
    case "map":
      await mapCommand(args, getFlag);
      break;
    case "benchmark":
      await benchmarkCommand(args, getFlag);
      break;
    case "eval":
      await evalCommand(args, getFlag);
      break;
    case "conversation":
      await conversationCommand(args, getFlag);
      break;
    case "checkpoint":
      await checkpointCommand(args, getFlag);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}
