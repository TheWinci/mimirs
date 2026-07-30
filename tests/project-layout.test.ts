import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureProjectState,
  projectLayout,
} from "../src/internals/project/layout.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("project state layout", () => {
  test("always places state below the canonical source directory", async () => {
    const root = await temporary("mimirs-layout-project-");
    const canonicalRoot = await realpath(root);

    expect(projectLayout(root)).toEqual({
      root: canonicalRoot,
      stateDirectory: join(canonicalRoot, ".mimirs"),
      configPath: join(canonicalRoot, ".mimirs", "config.json"),
      databasePath: join(canonicalRoot, ".mimirs", "index.sqlite"),
      lockPath: join(canonicalRoot, ".mimirs", "index.lock"),
      statusPath: join(canonicalRoot, ".mimirs", "status.json"),
    });
  });

  test("canonicalizes a symlinked source directory once", async () => {
    const container = await temporary("mimirs-layout-links-");
    const root = join(container, "project");
    const alias = join(container, "project-link");
    await mkdir(root);
    await symlink(root, alias, "dir");

    expect(projectLayout(alias)).toEqual(projectLayout(root));
    expect(projectLayout(alias).root).toBe(await realpath(root));
  });

  test("creates only the local state namespace and preserves its contents", async () => {
    const root = await temporary("mimirs-layout-existing-");
    const layout = projectLayout(root);
    await ensureProjectState(layout);
    await writeFile(join(layout.stateDirectory, "notes.txt"), "keep\n");
    await ensureProjectState(layout);

    expect(await Bun.file(join(layout.stateDirectory, "notes.txt")).text())
      .toBe("keep\n");
    expect(await Bun.file(join(layout.stateDirectory, "project.json")).exists())
      .toBe(false);
  });
});
