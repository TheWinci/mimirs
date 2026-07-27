import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";

import {
  ensureProjectState,
  projectLayout,
} from "../project/layout.ts";

export interface ProjectIndexLockOwner {
  instanceId: string;
  pid: number;
  acquiredAt: string;
}

export interface ProjectIndexLock {
  readonly owner: ProjectIndexLockOwner;
  release(): Promise<void>;
}

interface LockRecord extends ProjectIndexLockOwner {
  version: 1;
}

const INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;

function parseLockRecord(value: string): LockRecord | null {
  try {
    const record = JSON.parse(value) as {
      version?: unknown;
      instanceId?: unknown;
      pid?: unknown;
      acquiredAt?: unknown;
    };
    return record.version === 1 &&
        typeof record.instanceId === "string" && INSTANCE_ID.test(record.instanceId) &&
        typeof record.pid === "number" && Number.isSafeInteger(record.pid) &&
        record.pid > 0 && typeof record.acquiredAt === "string"
      ? record as LockRecord
      : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readProjectIndexLock(
  directory: string,
  stateDirectory?: string,
): Promise<ProjectIndexLockOwner | null> {
  try {
    const path = projectLayout(directory, stateDirectory).lockPath;
    return parseLockRecord(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function removeStaleLock(
  path: string,
  observed: string,
  identity: string,
): Promise<boolean> {
  const claimPath = `${path}.reclaim-${identity.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
  try {
    await link(path, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    try {
      const [current, claim] = await Promise.all([stat(path), stat(claimPath)]);
      if (
        (current.dev !== claim.dev || current.ino !== claim.ino) ||
        Date.now() - claim.mtimeMs > 5_000
      ) {
        await unlink(claimPath);
      }
    } catch {
      // Another contender may have completed the reclamation.
    }
    return false;
  }
  try {
    if (await readFile(path, "utf8") !== observed) return false;
    await unlink(path);
    await unlink(`${path}.candidate-${identity}`).catch(() => undefined);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    await unlink(claimPath).catch(() => undefined);
  }
}

/** Try to become the sole one-shot indexing writer for one project. */
export async function tryAcquireProjectIndexLock(
  directory: string,
  instanceId: string,
  pid = process.pid,
  stateDirectory?: string,
): Promise<ProjectIndexLock | null> {
  if (!INSTANCE_ID.test(instanceId)) {
    throw new Error("project index lock instanceId must contain only letters, numbers, _ or -");
  }
  const layout = projectLayout(directory, stateDirectory);
  await ensureProjectState(layout);
  const path = layout.lockPath;
  await mkdir(layout.stateDirectory, { recursive: true });
  const owner: ProjectIndexLockOwner = {
    instanceId,
    pid,
    acquiredAt: new Date().toISOString(),
  };
  const contents = JSON.stringify({ version: 1, ...owner } satisfies LockRecord);
  const candidatePath = `${path}.candidate-${instanceId}`;

  const candidate = await open(candidatePath, "wx", 0o600);
  try {
    await candidate.writeFile(contents, "utf8");
    await candidate.sync();
  } finally {
    await candidate.close();
  }

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(candidatePath, path);
        await unlink(candidatePath);
        let released = false;
        return {
          owner,
          async release(): Promise<void> {
            if (released) return;
            released = true;
            try {
              const current = await readFile(path, "utf8");
              if (current === contents) await unlink(path);
            } catch {
              // A missing or replaced lock no longer belongs to this instance.
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let observed: string;
        try {
          observed = await readFile(path, "utf8");
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          return null;
        }
        const current = parseLockRecord(observed);
        if (current && isProcessAlive(current.pid)) return null;
        if (
          !(await removeStaleLock(
            path,
            observed,
            current?.instanceId ?? "malformed",
          ))
        ) {
          return null;
        }
      }
    }
    return null;
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}
