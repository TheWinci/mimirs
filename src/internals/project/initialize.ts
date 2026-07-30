import { randomUUID } from "node:crypto";
import {
  link,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
  createDefaultIndexConfigIfMissing,
  loadIndexConfig,
} from "../indexing/config.ts";
import { ProjectDirectoryNotFoundError } from "./files.ts";
import {
  ensureProjectState,
  projectLayout,
  type ProjectLayout,
} from "./layout.ts";

export const PROJECT_GITIGNORE_ENTRY = ".mimirs/";

export interface ProjectInitialization {
  root: string;
  stateDirectory: string;
  configPath: string;
  /** True only for the contender that materialized the initial config. */
  created: boolean;
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

async function createFileIfMissing(
  path: string,
  contents: string,
): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const candidate = await open(temporary, "wx", 0o644);
  try {
    await candidate.writeFile(contents, "utf8");
    await candidate.sync();
  } finally {
    await candidate.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function hasEffectiveProjectIgnore(contents: string): boolean {
  const positive = new Set([
    ".mimirs",
    ".mimirs/",
    "/.mimirs",
    "/.mimirs/",
  ]);
  let ignored = false;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (positive.has(line)) ignored = true;
    if (line.startsWith("!") && positive.has(line.slice(1))) ignored = false;
  }
  return ignored;
}

async function ensureProjectGitIgnore(layout: ProjectLayout): Promise<void> {
  const path = join(layout.root, ".gitignore");
  if (await createFileIfMissing(path, `${PROJECT_GITIGNORE_ENTRY}\n`)) return;

  for (let attempt = 0; attempt < 4; attempt++) {
    const contents = await readFile(path, "utf8");
    if (hasEffectiveProjectIgnore(contents)) return;
    const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    const next = `${contents}${prefix}${PROJECT_GITIGNORE_ENTRY}\n`;
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const candidate = await open(
      temporary,
      "wx",
      (await stat(path)).mode & 0o777,
    );
    try {
      await candidate.writeFile(next, "utf8");
      await candidate.sync();
    } finally {
      await candidate.close();
    }
    try {
      if (await readFile(path, "utf8") !== contents) continue;
      await rename(temporary, path);
      return;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  throw new Error(`project ignore file kept changing during init: ${path}`);
}

/** Initialize explicit project state without opening or creating an index. */
export async function initializeProject(
  directory: string,
): Promise<ProjectInitialization> {
  const layout = projectLayout(directory);
  await assertProjectDirectory(directory, layout.root);

  await ensureProjectState(layout);
  const configCreated = await createDefaultIndexConfigIfMissing(layout.root);
  await loadIndexConfig(layout.root);
  await ensureProjectGitIgnore(layout);

  return {
    root: layout.root,
    stateDirectory: layout.stateDirectory,
    configPath: layout.configPath,
    created: configCreated,
  };
}
