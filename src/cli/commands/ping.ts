import { resolve } from "path";
import { positionalArg } from "../flags";
import { DropboxError, readLockHolderPid, sendCommand } from "../../control/producer";
import { isPidAlive } from "../../utils/index-lock";
import { cli } from "../../utils/log";

/**
 * `mimirs ping [dir]` — health-check the live server through the drop-box
 * command channel. Proves the channel end-to-end: request rename-in, holder
 * consumption, result rename-out.
 */
export async function pingCommand(args: string[]) {
  const dir = resolve(positionalArg(args[1], "."));

  const holder = readLockHolderPid(dir);
  if (holder === null) {
    cli.log("No mimirs server is running here (index lock free).");
    return;
  }
  if (!isPidAlive(holder)) {
    cli.log(`Index lock is stale (pid ${holder} is gone) — the next server or indexing CLI run reclaims it.`);
    return;
  }

  const start = Date.now();
  try {
    const result = await sendCommand(dir, "ping", {}, { timeoutMs: 5000 });
    if (result.status === "ok") {
      cli.log(`Server alive: pid ${result.stats?.pid}, version ${result.stats?.version} (${Date.now() - start}ms)`);
    } else {
      cli.log(`Server answered with ${result.status}${result.detail ? `: ${result.detail}` : ""}`);
    }
  } catch (err) {
    if (err instanceof DropboxError) {
      cli.error(
        `Server pid ${holder} holds the index lock but did not answer within 5s — ` +
        `likely a mimirs version without the command channel. Restart it (reconnect MCP in the IDE).`,
      );
      process.exit(1);
    }
    throw err;
  }
}
