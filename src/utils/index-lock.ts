import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { log } from "./log";

export interface IndexLock {
  release(): void;
}

/**
 * Per-directory refcount of held locks within this process. Lets the same
 * process acquire/release the lock multiple times (e.g. server startup
 * holds the lock for its lifetime, and `indexDirectory` also wraps each
 * run) without unlinking the file out from under itself.
 */
const heldLocks = new Map<string, number>();

/**
 * Process-level lock guarding indexing + watcher work for a project. When
 * multiple mimirs servers run against the same `.mimirs/index.db` (e.g. one
 * MCP server per IDE window), concurrent `indexDirectory` calls on the same
 * file race past each other and double-insert chunk rows. The lock funnels
 * indexing through one process; other processes serve queries only.
 *
 * Returns null when another live process holds the lock. Stale locks (PID
 * gone) are reclaimed automatically. Reentrant within the same process via
 * `heldLocks` refcount.
 */
export function tryAcquireIndexLock(directory: string): IndexLock | null {
  const dir = resolve(directory);
  const lockPath = join(dir, ".mimirs", "index.lock");

  // Fast path: we already hold this lock — bump refcount and return a token
  // that decrements on release.
  const heldCount = heldLocks.get(dir) ?? 0;
  if (heldCount > 0) {
    heldLocks.set(dir, heldCount + 1);
    return makeToken(dir, lockPath);
  }

  if (existsSync(lockPath)) {
    let staleContent: string | null = null;
    try {
      staleContent = readFileSync(lockPath, "utf-8");
      const pid = Number.parseInt(staleContent.trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid && isPidAlive(pid)) {
        return null;
      }
    } catch {
      // Unreadable lock — treat as stale.
    }
    // Reclaim only if the file still holds the stale content we examined — a
    // racing process may have already reclaimed and written its own live PID,
    // which we must not unlink (that was the double-acquire TOCTOU).
    try {
      if (staleContent === null || readFileSync(lockPath, "utf-8") === staleContent) {
        unlinkSync(lockPath);
      } else {
        return null;
      }
    } catch { /* already gone */ }
  }

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return null;
    log.warn(`Failed to acquire index lock: ${err instanceof Error ? err.message : err}`, "index-lock");
    return null;
  }

  // Close the stale-reclaim TOCTOU: two processes can both see a stale lock,
  // and the slower one then unlinks the faster one's fresh `wx` write and
  // re-creates the file — both believe they hold the lock. Re-read after the
  // write: whoever's PID actually landed in the file owns it.
  try {
    const owner = readFileSync(lockPath, "utf-8").trim();
    if (Number.parseInt(owner, 10) !== process.pid) return null;
  } catch {
    return null; // lock vanished under us — someone else is reclaiming
  }

  heldLocks.set(dir, 1);
  return makeToken(dir, lockPath);
}

function makeToken(dir: string, lockPath: string): IndexLock {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const count = heldLocks.get(dir) ?? 0;
      if (count <= 1) {
        heldLocks.delete(dir);
        try {
          const content = readFileSync(lockPath, "utf-8").trim();
          if (Number.parseInt(content, 10) === process.pid) {
            unlinkSync(lockPath);
          }
        } catch {
          // Already gone or unreadable — nothing to do.
        }
      } else {
        heldLocks.set(dir, count - 1);
      }
    },
  };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but is owned by another user (still alive)
    // — only ESRCH ("no such process") means it's gone. Treating EPERM as dead
    // would let a second instance reclaim a live cross-user lock and double-index.
    // (A narrow PID-reuse window after a crash remains; closing it fully needs
    // process start-time, which isn't portably available.)
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
