import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
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
  DEFAULT_INDEX_CONFIG,
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
    stateHost: "/project",
    stateDirectory: "/project/.mimirs",
    configPath: "/project/.mimirs/config.json",
    externalState: false,
    created: true,
    ...overrides,
  };
}

describe("init CLI", () => {
  test("parses the current directory and explicit project state options", () => {
    expect(parseInitArguments([])).toEqual({ directory: "." });
    expect(parseInitArguments(["-d", "repo"])).toEqual({
      directory: "repo",
    });
    expect(parseInitArguments([
      "--state-dir",
      "state",
      "--directory",
      "repo",
    ])).toEqual({
      directory: "repo",
      stateDirectory: "state",
    });
  });

  test("forwards parsed paths and renders deterministic next steps", async () => {
    const calls: unknown[][] = [];
    const io = output();
    const code = await runInit(
      ["-d", "repo", "--state-dir", "state"],
      {
        initialize: async (...args) => {
          calls.push(args);
          return initialization({
            root: "/canonical/repo",
            stateHost: "/canonical/state",
            stateDirectory: "/canonical/state/.mimirs",
            configPath: "/canonical/state/.mimirs/config.json",
            externalState: true,
          });
        },
      },
      io,
    );

    expect(code).toBe(0);
    expect(calls).toEqual([["repo", "state"]]);
    expect(io.errors).toEqual([]);
    expect(io.logs).toEqual([
      "Initialized Mimirs for /canonical/repo",
      "Config: /canonical/state/.mimirs/config.json",
      "Next: mimirs index source enable -d \"/canonical/repo\" " +
        "--state-dir \"/canonical/state\"",
    ]);
  });

  test("reports an already initialized project without treating it as an error", async () => {
    const io = output();
    expect(await runInit([], {
      initialize: async () => initialization({ created: false }),
    }, io)).toBe(0);
    expect(io.logs[0]).toBe("Mimirs is already initialized for /project");
  });

  test("rejects ambiguous, empty, and unknown arguments before initialization", async () => {
    for (const args of [
      ["repo"],
      ["-d"],
      ["-d", ""],
      ["--state-dir"],
      ["--state-dir", "   "],
      ["-d", "one", "--directory", "two"],
      ["--state-dir", "one", "--state-dir", "two"],
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
      expect(io.logs).toEqual([]);
    }
  });

  test("creates only complete project-local initialization state", async () => {
    const root = await temporary("mimirs-init-local-");
    const canonicalRoot = await realpath(root);
    const result = await initializeProject(root);
    const state = join(root, ".mimirs");

    expect(result).toEqual({
      root: canonicalRoot,
      stateHost: canonicalRoot,
      stateDirectory: join(canonicalRoot, ".mimirs"),
      configPath: join(canonicalRoot, ".mimirs", "config.json"),
      externalState: false,
      created: true,
    });
    expect((await readdir(state)).sort()).toEqual([
      "config.json",
    ]);
    expect(await loadIndexConfig(root)).toEqual(DEFAULT_INDEX_CONFIG);
    expect(await readFile(join(root, ".gitignore"), "utf8"))
      .toBe(`${PROJECT_GITIGNORE_ENTRY}\n`);
    expect(await Bun.file(join(state, "project.json")).exists()).toBe(false);
    for (const name of [
      "index.sqlite",
      "index.lock",
      "status.json",
    ]) {
      expect(await Bun.file(join(state, name)).exists()).toBe(false);
    }

    if (process.platform !== "win32") {
      expect((await stat(join(state, "config.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, ".gitignore"))).mode & 0o777).toBe(0o644);
    }
  });

  test("is idempotent and preserves existing config and ignore policy", async () => {
    const root = await temporary("mimirs-init-existing-");
    expect((await initializeProject(root)).created).toBe(true);
    const state = join(root, ".mimirs");
    const config = "{\n  \"include\": [\"src/**\"]\n}\n";
    const ignore = "# managed by the project\nnode_modules/\n";
    await writeFile(join(state, "config.json"), config);
    await writeFile(join(root, ".gitignore"), ignore);

    expect((await initializeProject(root)).created).toBe(false);
    expect(await readFile(join(state, "config.json"), "utf8")).toBe(config);
    expect(await readFile(join(root, ".gitignore"), "utf8"))
      .toBe(`${ignore}${PROJECT_GITIGNORE_ENTRY}\n`);
    await initializeProject(root);
    expect((await readFile(join(root, ".gitignore"), "utf8")).match(
      /^\.mimirs\/$/gm,
    )).toHaveLength(1);
    expect((await loadIndexConfig(root)).include).toEqual(["src/**"]);
  });

  test("handles existing root ignore syntax and final-newline cases", async () => {
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

    const negatedRule = await temporary("mimirs-init-ignore-negated-");
    await writeFile(
      join(negatedRule, ".gitignore"),
      ".mimirs/\n!.mimirs/\n",
    );
    await initializeProject(negatedRule);
    expect(await readFile(join(negatedRule, ".gitignore"), "utf8"))
      .toBe(".mimirs/\n!.mimirs/\n.mimirs/\n");
  });

  test("initializes safely under concurrent calls", async () => {
    const root = await temporary("mimirs-init-concurrent-");
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    const results = await Promise.all([
      initializeProject(root),
      initializeProject(root),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([
      false,
      true,
    ]);
    expect((await readdir(join(root, ".mimirs"))).sort()).toEqual([
      "config.json",
    ]);
    expect(await readFile(join(root, ".gitignore"), "utf8"))
      .toBe(`node_modules/\n${PROJECT_GITIGNORE_ENTRY}\n`);
    expect(await loadIndexConfig(root)).toEqual(DEFAULT_INDEX_CONFIG);
  });

  test("uses external state without writing below the project", async () => {
    const root = await temporary("mimirs-init-external-project-");
    const stateHost = await temporary("mimirs-init-external-state-");
    const result = await initializeProject(root, stateHost);
    const canonicalStateHost = await realpath(stateHost);
    const state = join(canonicalStateHost, ".mimirs");

    expect(result).toMatchObject({
      root: await realpath(root),
      stateHost: canonicalStateHost,
      stateDirectory: state,
      configPath: join(state, "config.json"),
      externalState: true,
      created: true,
    });
    expect(await Bun.file(join(root, ".mimirs")).exists()).toBe(false);
    expect((await readdir(state)).sort()).toEqual([
      "config.json",
      "project.json",
    ]);
    expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false);
    expect((await initializeProject(root, stateHost)).created).toBe(false);
  });

  test("makes the entire local state directory Git-ignored", async () => {
    const root = await temporary("mimirs-init-git-ignore-");
    const git = Bun.spawnSync(["git", "init", "-q"], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(git.exitCode).toBe(0);

    await initializeProject(root);
    const ignored = Bun.spawnSync([
      "git",
      "check-ignore",
      "-q",
      ".mimirs/config.json",
    ], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(ignored.exitCode).toBe(0);
  });

  test("validates the project before creating external state", async () => {
    const container = await temporary("mimirs-init-missing-");
    const stateHost = await temporary("mimirs-init-unused-state-");
    const missing = join(container, "missing");

    await expect(initializeProject(missing, stateHost))
      .rejects.toBeInstanceOf(ProjectDirectoryNotFoundError);
    expect(await Bun.file(join(stateHost, ".mimirs")).exists()).toBe(false);

    const io = output();
    expect(await runInit(["-d", missing, "--state-dir", stateHost], undefined, io))
      .toBe(2);
    expect(io.errors[0]).toContain("no such project directory");
  });

  test("rejects a file path as the project before creating external state", async () => {
    const container = await temporary("mimirs-init-file-project-");
    const stateHost = await temporary("mimirs-init-file-state-");
    const file = join(container, "project.txt");
    await writeFile(file, "not a directory\n");
    const io = output();

    expect(await runInit([
      "-d",
      file,
      "--state-dir",
      stateHost,
    ], undefined, io)).toBe(2);
    expect(io.errors[0]).toContain("no such project directory");
    expect(await Bun.file(join(stateHost, ".mimirs")).exists()).toBe(false);
  });

  test("rejects nested external state before creating project state", async () => {
    const root = await temporary("mimirs-init-nested-state-");
    const io = output();

    expect(await runInit([
      "-d",
      root,
      "--state-dir",
      join(root, "cache"),
    ], undefined, io)).toBe(2);
    expect(io.errors[0]).toContain("must be outside");
    expect(await Bun.file(join(root, ".mimirs")).exists()).toBe(false);
  });

  test("rejects external state already bound to another project", async () => {
    const first = await temporary("mimirs-init-bound-first-");
    const second = await temporary("mimirs-init-bound-second-");
    const stateHost = await temporary("mimirs-init-bound-state-");
    await initializeProject(first, stateHost);
    const configPath = join(stateHost, ".mimirs", "config.json");
    const configBefore = await readFile(configPath, "utf8");
    const io = output();

    expect(await runInit([
      "-d",
      second,
      "--state-dir",
      stateHost,
    ], undefined, io)).toBe(1);
    expect(io.errors[0]).toContain("cannot be reused");
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await Bun.file(join(second, ".gitignore")).exists()).toBe(false);
  });

  test("preserves an invalid existing config and reports a runtime failure", async () => {
    const root = await temporary("mimirs-init-invalid-config-");
    const state = join(root, ".mimirs");
    await mkdir(state);
    await writeFile(join(state, "config.json"), "{ not-json }\n");

    await expect(initializeProject(root)).rejects.toBeInstanceOf(IndexConfigError);
    expect(await readFile(join(state, "config.json"), "utf8"))
      .toBe("{ not-json }\n");
    expect(await Bun.file(join(state, "index.sqlite")).exists()).toBe(false);

    const io = output();
    expect(await runInit(["-d", root], undefined, io)).toBe(1);
    expect(io.errors[0]).toContain("invalid index config");
  });

  test("fails without changing an unwritable project ignore file", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await temporary("mimirs-init-unwritable-ignore-");
    await initializeProject(root);
    const ignorePath = join(root, ".gitignore");
    const ignore = "node_modules/\n";
    await writeFile(ignorePath, ignore);
    await chmod(ignorePath, 0o444);
    await chmod(root, 0o555);
    const io = output();
    try {
      expect(await runInit(["-d", root], undefined, io)).toBe(1);
      expect(io.errors).toHaveLength(1);
      expect(await readFile(ignorePath, "utf8")).toBe(ignore);
      expect((await readdir(root)).some((entry) =>
        entry.startsWith(".gitignore.") && entry.endsWith(".tmp")
      )).toBe(false);
    } finally {
      await chmod(root, 0o755);
      await chmod(ignorePath, 0o644);
    }
  });

  test("initializes a read-only project through writable external state", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await temporary("mimirs-init-read-only-");
    const stateHost = await temporary("mimirs-init-writable-state-");
    await chmod(root, 0o555);
    try {
      expect((await initializeProject(root, stateHost)).created).toBe(true);
      expect(await Bun.file(join(root, ".mimirs")).exists()).toBe(false);
      expect(await Bun.file(join(stateHost, ".mimirs", "config.json")).exists())
        .toBe(true);
    } finally {
      await chmod(root, 0o755);
    }
  });

  test("is registered in the package script and top-level CLI", async () => {
    const root = await temporary("mimirs-init-process-");
    const repository = new URL("..", import.meta.url).pathname;
    const packageJson = await Bun.file(join(repository, "package.json")).json() as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.init).toBe("bun run src/cli/index.ts init");

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
    expect(await Bun.file(join(root, ".mimirs", "config.json")).exists())
      .toBe(true);
  });
});
