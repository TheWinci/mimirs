import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const temporary = await mkdtemp(join(tmpdir(), "mimirs-init-binary-"));
const binary = join(
  temporary,
  process.platform === "win32" ? "mimirs.exe" : "mimirs",
);
const project = join(temporary, "project");

async function run(
  command: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

try {
  const build = await run([
    "bun",
    "run",
    "scripts/build-binary.ts",
    binary,
  ], repository);
  if (build.exitCode !== 0) {
    throw new Error(`compiled init smoke build failed:\n${build.stderr}`);
  }

  await mkdir(project);
  const first = await run([binary, "init"], project);
  if (first.exitCode !== 0) {
    throw new Error(`compiled init failed:\n${first.stderr}`);
  }
  if (!first.stdout.includes("Initialized Mimirs for")) {
    throw new Error(`compiled init output was unexpected:\n${first.stdout}`);
  }

  const state = join(project, ".mimirs");
  const stateFiles = (await readdir(state)).sort();
  if (stateFiles.length !== 1 || stateFiles[0] !== "config.json") {
    throw new Error(
      `compiled init created unexpected state: ${stateFiles.join(", ")}`,
    );
  }
  if (await readFile(join(project, ".gitignore"), "utf8") !== ".mimirs/\n") {
    throw new Error("compiled init did not create the root .gitignore rule");
  }

  const second = await run([binary, "init"], project);
  if (second.exitCode !== 0) {
    throw new Error(`compiled init repeat failed:\n${second.stderr}`);
  }
  if (!second.stdout.includes("already initialized")) {
    throw new Error(`compiled init repeat output was unexpected:\n${second.stdout}`);
  }

  console.log("compiled init smoke passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
