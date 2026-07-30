import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectLayout {
  /** Canonical absolute source directory. */
  root: string;
  /** Mimirs-owned state directory below the source directory. */
  stateDirectory: string;
  configPath: string;
  databasePath: string;
  lockPath: string;
  statusPath: string;
}

/**
 * Resolve symlinks for the existing portion of a path while still allowing
 * callers to describe state files that have not been created yet.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return absolute;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Return the fixed project-local state layout for one source directory. */
export function projectLayout(directory: string): ProjectLayout {
  const root = canonicalPath(directory);
  const stateDirectory = join(root, ".mimirs");
  return {
    root,
    stateDirectory,
    configPath: join(stateDirectory, "config.json"),
    databasePath: join(stateDirectory, "index.sqlite"),
    lockPath: join(stateDirectory, "index.lock"),
    statusPath: join(stateDirectory, "status.json"),
  };
}

/** Ensure the project-local state namespace exists. */
export async function ensureProjectState(layout: ProjectLayout): Promise<void> {
  await mkdir(layout.stateDirectory, { recursive: true });
}
