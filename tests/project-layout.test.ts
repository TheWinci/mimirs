import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
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
  ProjectStateIdentityError,
  ProjectStateLocationError,
  ProjectStateMismatchError,
  UnboundProjectStateError,
  validateProjectState,
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
  test("always owns a .mimirs directory below the selected state host", async () => {
    const root = await temporary("mimirs-layout-project-");
    const stateHost = await temporary("mimirs-layout-state-");
    const canonicalRoot = await realpath(root);
    const canonicalHost = await realpath(stateHost);

    expect(projectLayout(root)).toEqual({
      root: canonicalRoot,
      stateHost: canonicalRoot,
      stateDirectory: join(canonicalRoot, ".mimirs"),
      configPath: join(canonicalRoot, ".mimirs", "config.json"),
      databasePath: join(canonicalRoot, ".mimirs", "index.sqlite"),
      lockPath: join(canonicalRoot, ".mimirs", "index.lock"),
      statusPath: join(canonicalRoot, ".mimirs", "status.json"),
      identityPath: join(canonicalRoot, ".mimirs", "project.json"),
      externalState: false,
    });

    expect(projectLayout(root, stateHost)).toMatchObject({
      root: canonicalRoot,
      stateHost: canonicalHost,
      stateDirectory: join(canonicalHost, ".mimirs"),
      configPath: join(canonicalHost, ".mimirs", "config.json"),
      databasePath: join(canonicalHost, ".mimirs", "index.sqlite"),
      lockPath: join(canonicalHost, ".mimirs", "index.lock"),
      statusPath: join(canonicalHost, ".mimirs", "status.json"),
      identityPath: join(canonicalHost, ".mimirs", "project.json"),
      externalState: true,
    });
    expect(projectLayout(root, root)).toEqual(projectLayout(root));
  });

  test("binds one state directory to exactly one project under contention", async () => {
    const first = await temporary("mimirs-layout-first-");
    const second = await temporary("mimirs-layout-second-");
    const stateHost = await temporary("mimirs-layout-shared-");

    await Promise.all([
      ensureProjectState(projectLayout(first, stateHost)),
      ensureProjectState(projectLayout(first, stateHost)),
    ]);
    await validateProjectState(projectLayout(first, stateHost));
    await expect(ensureProjectState(projectLayout(second, stateHost)))
      .rejects.toBeInstanceOf(ProjectStateMismatchError);
    await expect(validateProjectState(projectLayout(second, stateHost)))
      .rejects.toBeInstanceOf(ProjectStateMismatchError);
  });

  test("requires an initialized identity before externally stored state is read", async () => {
    const root = await temporary("mimirs-layout-uninitialized-");
    const stateHost = await temporary("mimirs-layout-empty-");
    await expect(validateProjectState(projectLayout(root, stateHost)))
      .rejects.toBeInstanceOf(ProjectStateIdentityError);
    await validateProjectState(projectLayout(root), false);
  });

  test("canonicalizes project and state-host symlinks", async () => {
    const container = await temporary("mimirs-layout-links-");
    const root = join(container, "project");
    const stateHost = join(container, "state");
    const rootAlias = join(container, "project-link");
    const stateAlias = join(container, "state-link");
    await Promise.all([mkdir(root), mkdir(stateHost)]);
    await Promise.all([
      symlink(root, rootAlias, "dir"),
      symlink(stateHost, stateAlias, "dir"),
    ]);

    const aliased = projectLayout(rootAlias, stateAlias);
    expect(aliased.root).toBe(await realpath(root));
    expect(aliased.stateHost).toBe(await realpath(stateHost));
    await ensureProjectState(aliased);
    await validateProjectState(projectLayout(root, stateHost));
  });

  test("rejects lexical and symlinked state locations inside the source tree", async () => {
    const root = await temporary("mimirs-layout-nested-");
    expect(() => projectLayout(root, join(root, "cache")))
      .toThrow(ProjectStateLocationError);
    expect(() => projectLayout(root, root)).not.toThrow();

    const stateHost = await temporary("mimirs-layout-link-host-");
    const target = join(root, "state-target");
    await mkdir(target);
    await symlink(target, join(stateHost, ".mimirs"), "dir");
    expect(() => projectLayout(root, stateHost))
      .toThrow(ProjectStateLocationError);
  });

  test("preserves unrelated host contents while claiming its .mimirs namespace", async () => {
    const root = await temporary("mimirs-layout-nonempty-project-");
    const stateHost = await temporary("mimirs-layout-nonempty-state-");
    await writeFile(join(stateHost, "notes.txt"), "keep me\n");

    const layout = projectLayout(root, stateHost);
    await ensureProjectState(layout);
    expect(await readFile(join(stateHost, "notes.txt"), "utf8")).toBe("keep me\n");
    expect(await Bun.file(layout.identityPath).exists()).toBe(true);
  });

  test("preserves local state but rejects unbound external Mimirs files", async () => {
    const root = await temporary("mimirs-layout-existing-local-");
    await mkdir(join(root, ".mimirs"));
    await writeFile(join(root, ".mimirs", "config.json"), "{}\n");
    await ensureProjectState(projectLayout(root));
    expect(await readFile(join(root, ".mimirs", "config.json"), "utf8"))
      .toBe("{}\n");
    expect(await Bun.file(join(root, ".mimirs", "project.json")).exists())
      .toBe(false);

    const externalRoot = await temporary("mimirs-layout-unbound-project-");
    const stateHost = await temporary("mimirs-layout-unbound-state-");
    await mkdir(join(stateHost, ".mimirs"));
    await writeFile(join(stateHost, ".mimirs", "index.sqlite"), "not sqlite");
    await expect(ensureProjectState(projectLayout(externalRoot, stateHost)))
      .rejects.toBeInstanceOf(UnboundProjectStateError);
    expect(await Bun.file(join(stateHost, ".mimirs", "project.json")).exists())
      .toBe(false);
  });

  test("rejects malformed identities without replacing them", async () => {
    const root = await temporary("mimirs-layout-malformed-project-");
    const stateHost = await temporary("mimirs-layout-malformed-state-");
    const state = join(stateHost, ".mimirs");
    await mkdir(state);
    await writeFile(join(state, "project.json"), "{oops\n");
    await expect(ensureProjectState(projectLayout(root, stateHost)))
      .rejects.toBeInstanceOf(ProjectStateIdentityError);
    expect(await readFile(join(state, "project.json"), "utf8")).toBe("{oops\n");
  });

  test("does not create identity markers for local state", async () => {
    const root = await temporary("mimirs-layout-local-identity-");
    const layout = projectLayout(root);
    await ensureProjectState(layout);
    await validateProjectState(layout);
    expect(await Bun.file(layout.identityPath).exists()).toBe(false);
  });
});
