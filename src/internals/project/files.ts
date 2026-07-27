import { lstat, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  loadIndexConfig,
  type IndexConfig,
} from "../indexing/config.ts";

export class ProjectDirectoryNotFoundError extends Error {
  constructor(readonly directory: string) {
    super(`no such project directory: ${directory}`);
    this.name = "ProjectDirectoryNotFoundError";
  }
}

export interface ProjectFileSet {
  root: string;
  config: IndexConfig;
  /** Git-visible or filesystem-discovered paths after exclusions. */
  projectPaths: string[];
  /** Project paths that additionally match at least one include pattern. */
  includedPaths: string[];
}

function normalized(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function matcher(patterns: readonly string[]): (path: string) => boolean {
  const globs = patterns.map((pattern) =>
    new Bun.Glob(pattern.replaceAll("\\", "/"))
  );
  return (path) => globs.some((glob) => glob.match(normalized(path)));
}

/** Compile the configured exclusions once for discovery or watcher events. */
export function projectPathExclusion(
  config: IndexConfig,
): (path: string) => boolean {
  const excluded = matcher(config.exclude);
  return (path) => {
    const relative = normalized(path);
    return excluded(relative) ||
      excluded(`${relative}/__mimirs_directory_probe__`);
  };
}

async function assertProjectDirectory(
  directory: string,
  root: string,
): Promise<void> {
  try {
    if (!(await stat(root)).isDirectory()) {
      throw new ProjectDirectoryNotFoundError(directory);
    }
  } catch (error) {
    if (error instanceof ProjectDirectoryNotFoundError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectDirectoryNotFoundError(directory);
    }
    throw error;
  }
}

async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const process = Bun.spawn(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(process.stdout).text();
    if (await process.exited !== 0) return null;
    return output.split("\0").filter(Boolean).map(normalized);
  } catch {
    return null;
  }
}

async function filesystemFiles(
  root: string,
  excluded: (path: string) => boolean,
): Promise<string[]> {
  const paths: string[] = [];
  async function visit(relativeDirectory: string): Promise<void> {
    const entries = await readdir(join(root, relativeDirectory), {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = normalized(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      if (entry.isDirectory()) {
        if (!excluded(relativePath)) {
          await visit(relativePath);
        }
      } else if (entry.isFile()) {
        paths.push(relativePath);
      }
    }
  }
  await visit("");
  return paths;
}

async function existingFiles(root: string, paths: string[]): Promise<string[]> {
  const values = await Promise.all(paths.map(async (path) => {
    try {
      return (await lstat(join(root, path))).isFile() ? path : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
  return values.filter((path): path is string => path !== null);
}

/** Collect one configured project view without reading source contents. */
export async function collectProjectFiles(
  directory: string,
  config?: IndexConfig,
): Promise<ProjectFileSet> {
  const root = resolve(directory);
  await assertProjectDirectory(directory, root);
  const resolvedConfig = config ?? await loadIndexConfig(root);
  const isExcluded = projectPathExclusion(resolvedConfig);
  const isIncluded = matcher(resolvedConfig.include);
  const discovered = await gitFiles(root) ??
    await filesystemFiles(root, isExcluded);
  const existing = await existingFiles(root, discovered);
  const projectPaths = [...new Set(existing)]
    .filter((path) => !isExcluded(path))
    .sort((left, right) => left.localeCompare(right));
  return {
    root,
    config: resolvedConfig,
    projectPaths,
    includedPaths: projectPaths.filter(isIncluded),
  };
}
