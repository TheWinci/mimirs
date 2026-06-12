import { resolve, join } from "path";
import { existsSync } from "fs";
import { RagDB } from "../../db";
import {
  addConnectedRepo,
  readConnectedReposSync,
  removeConnectedRepo,
} from "../../config";
import { readLockHolderPid } from "../../control/producer";
import { isPidAlive } from "../../utils/index-lock";
import { positionalArg, queryArg } from "../flags";
import { cli } from "../../utils/log";

/**
 * `mimirs connect` — persistent cross-repo connections in .mimirs/config.json.
 *
 *   mimirs connect                       list configured connections + status
 *   mimirs connect <repo> [--alias X]    validate + save a connection
 *   mimirs disconnect <repo|alias>       remove a connection
 *
 * The CLI is sessionless, so "connect" here means persist: the MCP server
 * warm-attaches every configured entry (query-only) at startup, and read
 * tools accept the alias as their `directory` argument.
 */
export async function connectCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const projectDir = resolve(getFlag("--dir") || ".");
  const target = positionalArg(args[1], "");

  if (!target) {
    const repos = readConnectedReposSync(projectDir);
    if (repos.length === 0) {
      cli.log("No connected repos configured. Add one: mimirs connect <repo> [--alias name]");
      return;
    }
    cli.log(`Connected repos (${repos.length}):`);
    for (const r of repos) {
      const dir = resolve(projectDir, r.path);
      const indexed = existsSync(join(dir, ".mimirs", "index.db"));
      const holder = indexed ? readLockHolderPid(dir) : null;
      const fresh = holder !== null && isPidAlive(holder)
        ? "live server"
        : indexed ? "frozen (no live server)" : "MISSING INDEX";
      cli.log(`  ${r.alias ? `${r.alias.padEnd(16)} ` : ""}${dir}  [${fresh}]`);
    }
    return;
  }

  const dir = resolve(projectDir, target);
  if (!existsSync(dir)) {
    cli.error(`Directory does not exist: ${dir}`);
    process.exit(1);
  }
  // Validate exactly like the server's attach: query-only open, must have an
  // index, embedding model/dim must be compatible.
  try {
    new RagDB(dir, undefined, { readonly: true }).close();
  } catch (err) {
    cli.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const alias = getFlag("--alias");
  const outcome = await addConnectedRepo(projectDir, { path: target, ...(alias ? { alias } : {}) });
  if (outcome === "exists") {
    cli.log(`Already connected: ${dir}`);
  } else {
    cli.log(`Connected ${dir}${alias ? ` as "${alias}"` : ""} (saved to .mimirs/config.json).`);
    cli.log("Live servers pick this up on restart; read tools then accept it as `directory`.");
  }
}

export async function disconnectCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const projectDir = resolve(getFlag("--dir") || ".");
  const ref = queryArg(args[1], "Usage: mimirs disconnect <repo|alias> [--dir D]");
  const removed = await removeConnectedRepo(projectDir, ref);
  if (removed) {
    cli.log(`Disconnected "${ref}" (removed from .mimirs/config.json).`);
  } else {
    cli.error(`No connected repo matches "${ref}".`);
    process.exit(1);
  }
}
