import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve, join } from "path";
import { existsSync, realpathSync } from "fs";

// Canonicalize for identity comparison: resolve() doesn't follow symlinks, so
// "/tmp/x" vs "/private/tmp/x" (macOS) would spuriously fail the same-project
// check. Falls back to the resolved path when realpath fails (missing dir).
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
import { RagDB } from "../db";
import { loadConfig, applyEmbeddingConfigFromDisk, type RagConfig } from "../config";
import { registerSearchTools } from "./search";
import { registerIndexTools } from "./index-tools";
import { registerGraphTools } from "./graph-tools";
import { registerConversationTools } from "./conversation-tools";
import { registerCheckpointTools } from "./checkpoint-tools";
import { registerAnnotationTools } from "./annotation-tools";
import { registerAnalyticsTools } from "./analytics-tools";
import { registerGitTools } from "./git-tools";
import { registerGitHistoryTools } from "./git-history-tools";
import { registerServerInfoTools, type ConnectedDBInfo } from "./server-info-tools";
import { registerWikiTools } from "./wiki-tools";

export type GetDB = (dir: string, opts?: { writable?: boolean }) => RagDB;
export type WriteStatus = (status: string) => void;

/** Resolve the project directory, database, and config from an optional directory param. */
export async function resolveProject(
  directory: string | undefined,
  getDB: GetDB,
  opts?: { allowCreate?: boolean }
): Promise<{ projectDir: string; db: RagDB; config: RagConfig }> {
  const defaultDir = resolve(process.env.RAG_PROJECT_DIR || process.cwd());
  const projectDir = directory || defaultDir;

  // Resolve to an absolute path and confirm it exists. Note: this is not a
  // sandbox — mimirs is a local tool that already runs with the caller's full
  // filesystem access, so any existing directory is allowed.
  const resolved = resolve(projectDir);
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }

  // Read tools must not scaffold a database: a mistyped `directory` used to
  // silently create `.mimirs/` + config + an empty index wherever it pointed.
  // Only the configured project, an already-indexed directory, or an explicit
  // create (index_files) may open a fresh DB.
  //
  // RAG_DB_DIR setups keep ONE shared index elsewhere, so the per-directory
  // .mimirs check is meaningless there — but that makes a mistyped `directory`
  // WORSE (the query silently runs against the real project's index, and
  // loadConfig below still writes a config.json into the typo'd dir). In that
  // mode, only the configured project is accepted for read tools.
  if (!opts?.allowCreate && canonical(resolved) !== canonical(defaultDir)) {
    if (process.env.RAG_DB_DIR) {
      throw new Error(
        `RAG_DB_DIR is set (single shared index) — read tools only accept the configured project ` +
          `${defaultDir}; got ${resolved}. Omit 'directory', or call index_files to index a new project.`,
      );
    }
    if (!existsSync(join(resolved, ".mimirs"))) {
      throw new Error(
        `No mimirs index at ${resolved}. Read tools don't create one — ` +
          `call index_files with this directory first, or omit 'directory' to use the configured project.`,
      );
    }
  }

  const config = await loadConfig(resolved);
  // Configure the embedder from the SAME raw-disk read the RagDB constructor
  // uses — not from the validated config, which on any validation failure falls
  // back to defaults and would drop a custom embeddingDim. With a cached getDB
  // (constructor skipped), that left the query embedder at the default dim while
  // the index was built at the real one → wrong-dim embeds. The invariant: the
  // query embedder always matches what the index was built with.
  applyEmbeddingConfigFromDisk(resolved);
  // Foreign dirs open query-only unless the caller explicitly indexes them
  // (allowCreate) — getDB decides; primary is always writable.
  return { projectDir: resolved, db: getDB(resolved, { writable: opts?.allowCreate === true }), config };
}

// Actionable hints for failure shapes an agent can actually recover from.
// Matched against the error message; first hit wins.
const ERROR_HINTS: [RegExp, string][] = [
  [/no such table|No mimirs index/i, "The index may not exist yet — run index_files first."],
  [/database is locked|SQLITE_BUSY/i, "Another mimirs process holds the database — retry in a moment."],
  [/Directory does not exist/i, "Check the `directory` argument — it must be an existing absolute or relative path."],
  [/checksum mismatch/i, "The embedding model cache failed verification and was deleted — the next call re-downloads it."],
  [/dimension|dim mismatch/i, "The index was built with a different embedding model/dim — re-index or fix .mimirs/config.json."],
  [/readonly database|SQLITE_READONLY/i, "This repo is attached query-only (connect_repo) — writes (annotate, checkpoints, indexing) must run from that repo's own mimirs server or CLI."],
];

/**
 * Wrap every tool handler so a thrown error returns a readable, actionable
 * text response instead of the SDK's bare error wrap. One chokepoint —
 * individual tools don't need their own try/catch (wiki keeps its richer one).
 */
function withFriendlyErrors(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "tool") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        const handler = args[args.length - 1];
        if (typeof handler === "function") {
          const toolName = String(args[0]);
          args[args.length - 1] = async (...handlerArgs: unknown[]) => {
            try {
              return await (handler as (...a: unknown[]) => unknown)(...handlerArgs);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const hint = ERROR_HINTS.find(([re]) => re.test(msg))?.[1];
              return {
                isError: true,
                content: [{
                  type: "text" as const,
                  text: `${toolName} failed: ${msg}${hint ? `\n${hint}` : ""}`,
                }],
              };
            }
          };
        }
        return Reflect.apply(target.tool as (...a: unknown[]) => unknown, target, args);
      };
    },
  });
}

export function registerAllTools(
  server: McpServer,
  getDB: (dir: string) => RagDB,
  getConnectedDBs?: () => ConnectedDBInfo[],
  writeStatus?: WriteStatus,
) {
  server = withFriendlyErrors(server);
  registerSearchTools(server, getDB);
  registerIndexTools(server, getDB, writeStatus);
  registerGraphTools(server, getDB);
  registerConversationTools(server, getDB);
  registerCheckpointTools(server, getDB);
  registerAnnotationTools(server, getDB);
  registerAnalyticsTools(server, getDB);
  registerGitTools(server, getDB);
  registerGitHistoryTools(server, getDB);
  registerServerInfoTools(server, getDB, getConnectedDBs);
  registerWikiTools(server, getDB);
}
