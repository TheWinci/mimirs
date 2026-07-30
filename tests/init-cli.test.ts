import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INIT_USAGE,
  parseInitArguments,
  runInit,
  type InitCommandOutput,
} from "../src/cli/commands/init.ts";
import {
  defaultIndexConfig,
  IndexConfigError,
  loadIndexConfig,
} from "../src/internals/indexing/config.ts";
import { ProjectDirectoryNotFoundError } from
  "../src/internals/project/files.ts";
import {
  initializeProject,
  PROJECT_GITIGNORE_ENTRY,
  type ProjectInitialization,
} from "../src/internals/project/initialize.ts";

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

function output(): InitCommandOutput & { errors: string[]; logs: string[] } {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    logs,
    error: (message) => errors.push(message),
    log: (message) => logs.push(message),
  };
}

function initialization(
  overrides: Partial<ProjectInitialization> = {},
): ProjectInitialization {
  return {
    root: "/project",
    stateDirectory: "/project/.mimirs",
    configPath: "/project/.mimirs/config.json",
    created: true,
    ...overrides,
  };
}

describe("init CLI", () => {
  test("parses the current or explicitly selected project directory", () => {
    expect(parseInitArguments([])).toEqual({ directory: "." });
    expect(parseInitArguments(["-d", "repo"])).toEqual({ directory: "repo" });
    expect(parseInitArguments(["--directory", "repo"])).toEqual({
      directory: "repo",
    });
  });

  test("renders the local next command without repeating the project path", async () => {
    const calls: string[] = [];
    const io = output();
    const code = await runInit(["-d", "repo"], {
      initialize: async (directory) => {
        calls.push(directory);
        return initialization({ root: "/canonical/repo" });
      },
      confirmIndex: async () => null,
    }, io);

    expect(code).toBe(0);
    expect(calls).toEqual(["repo"]);
    expect(io.logs).toEqual([
      "Initialized Mimirs for /canonical/repo",
      "Config: /project/.mimirs/config.json",
      "Next: mimirs index",
    ]);
  });

  test("runs the normal index flow when the user accepts the prompt", async () => {
    const indexed: string[] = [];
    const io = output();
    const code = await runInit([], {
      initialize: async () => initialization({ root: "/canonical/project" }),
      confirmIndex: async () => true,
      index: async (directory, indexOutput) => {
        indexed.push(directory);
        indexOutput.log("Indexed generation 1");
        return 0;
      },
    }, io);

    expect(code).toBe(0);
    expect(indexed).toEqual(["/canonical/project"]);
    expect(io.logs).toEqual([
      "Initialized Mimirs for /canonical/project",
      "Config: /project/.mimirs/config.json",
      "Indexed generation 1",
    ]);
  });

  test("prints the next command when the user declines indexing", async () => {
    let indexed = false;
    const io = output();
    expect(await runInit([], {
      initialize: async () => initialization(),
      confirmIndex: async () => false,
      index: async () => {
        indexed = true;
        return 0;
      },
    }, io)).toBe(0);

    expect(indexed).toBe(false);
    expect(io.logs.at(-1)).toBe("Next: mimirs index");
  });

  test("rejects source arguments, external state, and duplicate options", async () => {
    for (const args of [
      ["repo"],
      ["-d"],
      ["-d", ""],
      ["--state-dir", "state"],
      ["-d", "one", "--directory", "two"],
      ["--unknown"],
    ]) {
      let initialized = false;
      const io = output();
      expect(await runInit(args, {
        initialize: async () => {
          initialized = true;
          return initialization();
        },
      }, io)).toBe(2);
      expect(initialized).toBe(false);
      expect(io.errors.at(-1)).toBe(INIT_USAGE);
    }
  });

  test("creates only project-local initialization state with an absolute source", async () => {
    const root = await temporary("mimirs-init-local-");
    const canonicalRoot = await realpath(root);
    const result = await initializeProject(root);
    const state = join(root, ".mimirs");

    expect(result).toEqual({
      root: canonicalRoot,
      stateDirectory: join(canonicalRoot, ".mimirs"),
      configPath: join(canonicalRoot, ".mimirs", "config.json"),
      created: true,
    });
    expect((await readdir(state)).sort()).toEqual(["config.json"]);
    expect(await loadIndexConfig(root)).toEqual(defaultIndexConfig(root));
    expect((await loadIndexConfig(root)).index?.source.directories)
      .toEqual([canonicalRoot]);
    expect(await readFile(join(root, ".gitignore"), "utf8"))
      .toBe(`${PROJECT_GITIGNORE_ENTRY}\n`);
    expect(await Bun.file(join(state, "project.json")).exists()).toBe(false);
    for (const name of ["index.sqlite", "index.lock", "status.json"]) {
      expect(await Bun.file(join(state, name)).exists()).toBe(false);
    }
    if (process.platform !== "win32") {
      expect((await stat(join(state, "config.json"))).mode & 0o777).toBe(0o600);
    }
  });

  test("canonicalizes a symlinked project in the generated config", async () => {
    const container = await temporary("mimirs-init-link-");
    const root = join(container, "project");
    const alias = join(container, "alias");
    await mkdir(root);
    await symlink(root, alias, "dir");

    const initialized = await initializeProject(alias);
    expect(initialized.root).toBe(await realpath(root));
    expect((await loadIndexConfig(root)).index?.source.directories)
      .toEqual([await realpath(root)]);
    expect(await Bun.file(join(alias, ".mimirs", "project.json")).exists())
      .toBe(false);
  });

  test("is idempotent and preserves existing config and ignore policy", async () => {
    const root = await temporary("mimirs-init-existing-");
    expect((await initializeProject(root)).created).toBe(true);
    const configPath = join(root, ".mimirs", "config.json");
    const configured = {
      ...defaultIndexConfig(root),
      include: ["src/**"],
    };
    const config = `${JSON.stringify(configured, null, 2)}\n`;
    const ignore = "# managed by the project\nnode_modules/\n";
    await writeFile(configPath, config);
    await writeFile(join(root, ".gitignore"), ignore);

    expect((await initializeProject(root)).created).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(config);
    expect(await readFile(join(root, ".gitignore"), "utf8"))
      .toBe(`${ignore}${PROJECT_GITIGNORE_ENTRY}\n`);
    await initializeProject(root);
    expect((await readFile(join(root, ".gitignore"), "utf8")).match(
      /^\.mimirs\/$/gm,
    )).toHaveLength(1);
  });

  test("handles root ignore syntax and a missing final newline", async () => {
    const withoutNewline = await temporary("mimirs-init-ignore-newline-");
    await writeFile(join(withoutNewline, ".gitignore"), "node_modules/");
    await initializeProject(withoutNewline);
    expect(await readFile(join(withoutNewline, ".gitignore"), "utf8"))
      .toBe("node_modules/\n.mimirs/\n");

    const rootedRule = await temporary("mimirs-init-ignore-rooted-");
    await writeFile(join(rootedRule, ".gitignore"), "/.mimirs/\n");
    await initializeProject(rootedRule);
    expect(await readFile(join(rootedRule, ".gitignore"), "utf8"))
      .toBe("/.mimirs/\n");
  });

  test("initializes safely under concurrent calls", async () => {
    const root = await temporary("mimirs-init-concurrent-");
    const results = await Promise.all([
      initializeProject(root),
      initializeProject(root),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([
      false,
      true,
    ]);
    expect((await readdir(join(root, ".mimirs"))).sort())
      .toEqual(["config.json"]);
    expect(await loadIndexConfig(root)).toEqual(defaultIndexConfig(root));
  });

  test("does not create state for a missing project or file path", async () => {
    const container = await temporary("mimirs-init-missing-");
    const missing = join(container, "missing");
    await expect(initializeProject(missing))
      .rejects.toBeInstanceOf(ProjectDirectoryNotFoundError);
    expect(await Bun.file(join(missing, ".mimirs")).exists()).toBe(false);

    const file = join(container, "project.txt");
    await writeFile(file, "not a directory\n");
    const io = output();
    expect(await runInit(["-d", file], undefined, io)).toBe(2);
    expect(io.errors[0]).toContain("no such project directory");
  });

  test("preserves and reports an invalid existing config", async () => {
    const root = await temporary("mimirs-init-invalid-config-");
    await mkdir(join(root, ".mimirs"));
    const configPath = join(root, ".mimirs", "config.json");
    await writeFile(configPath, "{ not-json }\n");

    await expect(initializeProject(root)).rejects.toBeInstanceOf(IndexConfigError);
    expect(await readFile(configPath, "utf8")).toBe("{ not-json }\n");
    const io = output();
    expect(await runInit(["-d", root], undefined, io)).toBe(1);
    expect(io.errors[0]).toContain("invalid index config");
  });

  test("makes the complete local state directory Git-ignored", async () => {
    const root = await temporary("mimirs-init-git-ignore-");
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0);
    await initializeProject(root);

    expect(Bun.spawnSync(
      ["git", "check-ignore", "-q", ".mimirs/config.json"],
      { cwd: root },
    ).exitCode).toBe(0);
  });

  test("is registered in the package script and top-level CLI", async () => {
    const root = await temporary("mimirs-init-process-");
    const repository = new URL("..", import.meta.url).pathname;
    const process = Bun.spawn([
      "bun",
      join(repository, "src", "cli", "index.ts"),
      "init",
      "-d",
      root,
    ], {
      cwd: repository,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`Initialized Mimirs for ${await realpath(root)}`);
    expect(stdout).toContain("Next: mimirs index\n");
    expect(stdout).not.toContain("Next: mimirs index -d");
    expect(await Bun.file(join(root, ".mimirs", "config.json")).exists())
      .toBe(true);
  });
});
