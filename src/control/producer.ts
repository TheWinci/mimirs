import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { isPidAlive, tryAcquireIndexLock } from "../utils/index-lock";
import {
  PROTOCOL_VERSION,
  commandsDir,
  requestPath,
  resultPath,
  writeAtomic,
  type CommandName,
  type CommandResult,
} from "./protocol";

const POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class DropboxError extends Error {
  constructor(
    public kind: "holder-died" | "timeout" | "no-channel",
    message: string,
  ) {
    super(message);
    this.name = "DropboxError";
  }
}

/** PID from `.mimirs/index.lock`, or null when no lock file exists. */
export function readLockHolderPid(projectDir: string): number | null {
  try {
    const pid = Number.parseInt(
      readFileSync(join(projectDir, ".mimirs", "index.lock"), "utf-8").trim(),
      10,
    );
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export interface SendOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Called with the first line of `.mimirs/status` whenever it changes —
   * long-running commands report progress there (writeStatus). */
  onProgress?: (msg: string) => void;
}

/**
 * Drop a command request for the live lock holder and wait for its result.
 *
 * Callers should already know a live holder exists (lock acquisition failed);
 * while polling we keep liveness-checking it so a holder that dies mid-job
 * surfaces as DropboxError("holder-died") instead of a silent timeout.
 */
export async function sendCommand(
  projectDir: string,
  cmd: CommandName,
  args: Record<string, unknown>,
  opts?: SendOptions,
): Promise<CommandResult> {
  const dir = commandsDir(projectDir);
  mkdirSync(dir, { recursive: true });

  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const reqPath = requestPath(dir, id);
  const resPath = resultPath(dir, id);
  const statusPath = join(projectDir, ".mimirs", "status");
  const pollMs = opts?.pollMs ?? POLL_MS;
  const deadline = Date.now() + (opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  writeAtomic(reqPath, { id, cmd, args, pid: process.pid, version: PROTOCOL_VERSION });

  let lastStatus = "";
  while (Date.now() < deadline) {
    if (existsSync(resPath)) {
      const result = JSON.parse(readFileSync(resPath, "utf-8")) as CommandResult;
      try { unlinkSync(resPath); } catch { /* fine, server cleans old results */ }
      return result;
    }

    const holder = readLockHolderPid(projectDir);
    if (holder === null || !isPidAlive(holder)) {
      // The result may have landed between the exists-check and the liveness
      // check — give it one more poll before declaring the holder dead.
      await Bun.sleep(pollMs);
      if (existsSync(resPath)) continue;
      try { unlinkSync(reqPath); } catch { /* already consumed */ }
      throw new DropboxError(
        "holder-died",
        "The mimirs server holding the index lock exited before finishing the command.",
      );
    }

    if (opts?.onProgress) {
      try {
        const line = readFileSync(statusPath, "utf-8").split("\n", 1)[0];
        if (line && line !== lastStatus) {
          lastStatus = line;
          opts.onProgress(line);
        }
      } catch { /* status not written yet */ }
    }

    await Bun.sleep(pollMs);
  }

  // Withdraw the request so a busy server doesn't fire it after we've given
  // up — best-effort, it may already be mid-run.
  try { unlinkSync(reqPath); } catch { /* already consumed */ }
  throw new DropboxError("timeout", `No result after ${Math.round((opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.`);
}

export type IndexAccess<T> =
  | { mode: "local"; value: T }
  | { mode: "remote"; result: CommandResult };

export interface IndexAccessOptions extends SendOptions {
  /** How long the pre-flight ping may take before the holder is declared
   * channel-less (default 5s). */
  probeTimeoutMs?: number;
}

/**
 * The CLI's three-step fallback for jobs that need the index lock:
 *
 * 1. Lock free → acquire, run in-process.
 * 2. Lock stale (holder PID dead) → tryAcquireIndexLock reclaims it; same.
 * 3. Live holder → hand the job to it via the drop-box and wait.
 *
 * Step 3 pings first: a holder running a pre-channel mimirs would never
 * answer, and the real command would poll out its full timeout. If the
 * holder dies mid-job we reclaim the lock and retry in-process once.
 */
export async function withIndexAccess<T>(
  projectDir: string,
  runLocal: () => Promise<T>,
  remote: { cmd: CommandName; args: Record<string, unknown> },
  opts?: IndexAccessOptions,
): Promise<IndexAccess<T>> {
  const runHoldingLock = async (): Promise<IndexAccess<T> | null> => {
    const lock = tryAcquireIndexLock(projectDir);
    if (!lock) return null;
    try {
      return { mode: "local", value: await runLocal() };
    } finally {
      lock.release();
    }
  };

  const local = await runHoldingLock();
  if (local) return local;

  try {
    try {
      await sendCommand(projectDir, "ping", {}, { timeoutMs: opts?.probeTimeoutMs ?? 5000, pollMs: opts?.pollMs });
    } catch (err) {
      if (err instanceof DropboxError && err.kind === "timeout") {
        throw new DropboxError(
          "no-channel",
          `A live mimirs server (pid ${readLockHolderPid(projectDir) ?? "?"}) holds the index lock but did not answer a ping — it likely predates the command channel. Restart it (reconnect MCP in the IDE) and retry.`,
        );
      }
      throw err;
    }

    const result = await sendCommand(projectDir, remote.cmd, remote.args, opts);
    return { mode: "remote", result };
  } catch (err) {
    if (err instanceof DropboxError && err.kind === "holder-died") {
      opts?.onProgress?.("Server exited mid-job — retrying in-process");
      const retry = await runHoldingLock();
      if (retry) return retry;
    }
    throw err;
  }
}
