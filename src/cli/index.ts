import { initCommand } from "./commands/init";
import { indexCommand } from "./commands/index-cmd";
import { searchCommand, readCommand } from "./commands/search-cmd";
import { statusCommand } from "./commands/status";
import { removeCommand } from "./commands/remove";
import { analyticsCommand } from "./commands/analytics";
import { mapCommand } from "./commands/map";
import { benchmarkCommand } from "./commands/benchmark";
import { benchmarkModelsCommand } from "./commands/benchmark-models";
import { evalCommand } from "./commands/eval";
import { conversationCommand } from "./commands/conversation";
import { checkpointCommand } from "./commands/checkpoint";
import { annotationsCommand } from "./commands/annotations";
import { sessionContextCommand } from "./commands/session-context";
// serve is imported dynamically below — its transitive deps include native
// modules (bun:sqlite, sqlite-vec) and top-level awaits that would crash the
// entire CLI if they fail at module load time, blocking even `doctor`.
import { demoCommand } from "./commands/demo";
import { doctorCommand } from "./commands/doctor";
import { cleanupCommand } from "./commands/cleanup";

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`local-rag — Local RAG for semantic file search

Usage:
  local-rag serve                      Start MCP server (stdio)
  local-rag init [dir] [--ide IDEs]    Create default .rag/config.json
              IDEs: claude,cursor,windsurf,copilot,all
  local-rag index [dir] [--patterns ...] Index files in directory
  local-rag search <query> [--top N]   Search indexed files
  local-rag read <query> [--top N]     Read relevant chunks (full content)
              [--threshold T] [--dir D]
  local-rag status [dir]               Show index stats
  local-rag remove <file> [dir]        Remove file from index
  local-rag analytics [dir] [--days N] Show search usage analytics
  local-rag benchmark <file> [--dir D] Run search quality benchmark
                       [--top N]
  local-rag eval <file> [--dir D]      Run A/B eval (with/without RAG)
                  [--top N] [--out F]
  local-rag map [dir] [--focus F]      Generate project dependency graph
                [--zoom file|directory]     (Mermaid format)
                [--max N]
  local-rag conversation search <query> Search conversation history
                [--dir D] [--top N]
  local-rag conversation sessions      List indexed sessions
                [--dir D]
  local-rag conversation index [--dir D] Index all sessions for a project
  local-rag checkpoint create <type>   Create a checkpoint
                <title> <summary>
                [--dir D] [--files f1,f2] [--tags t1,t2]
  local-rag checkpoint list [--dir D]  List checkpoints
                [--type T] [--top N]
  local-rag checkpoint search <query>  Search checkpoints
                [--dir D] [--type T] [--top N]
  local-rag annotations [dir]          List annotations
                [--path P] [--dir D]
  local-rag session-context [dir]      Session start context summary
                [--dir D]
  local-rag doctor [dir]               Diagnose MCP server startup issues
  local-rag cleanup [dir] [-y]          Remove all local-rag files
  local-rag demo [dir]                 Run interactive feature demo

Options:
  dir       Project directory (default: current directory)
  --top N   Number of results (default: 10)
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
    case "serve": {
      const { serveCommand } = await import("./commands/serve");
      await serveCommand();
      break;
    }
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
    case "benchmark-models":
      await benchmarkModelsCommand(args, getFlag);
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
    case "annotations":
      await annotationsCommand(args, getFlag);
      break;
    case "session-context":
      await sessionContextCommand(args, getFlag);
      break;
    case "doctor":
      await doctorCommand(args);
      break;
    case "cleanup":
      await cleanupCommand(args);
      break;
    case "demo":
      await demoCommand(args);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}
