import { resolve } from "path";
import { RagDB } from "../../db";
import { affectedTests } from "../../graph/trace";
import { findGitRoot, runGit } from "../../tools/git-tools";
import { cli } from "../../utils/log";

/**
 * `mimirs affected [files...]` — the test files to run for a set of changed
 * files, by transitively walking importers. Built for CI / pre-commit hooks
 * (the interactive counterpart is the `impact` tool's "Tests to run" section).
 *
 * Input modes:
 *   - file arguments      `mimirs affected src/a.ts src/b.ts`
 *   - stdin               `git diff --name-only | mimirs affected --stdin`
 *   - git auto-detect     `mimirs affected`  → uses `git diff --name-only HEAD`
 *
 * `--quiet` prints bare paths (one per line) for piping into a test runner;
 * `--json` prints the full result.
 */
export async function affectedCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(getFlag("--dir") || ".");
  const useStdin = args.includes("--stdin");
  const json = args.includes("--json");
  const quiet = args.includes("--quiet");

  // Positional file args — skip flags and the --dir value.
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir") {
      i++; // skip the flag's value
      continue;
    }
    if (a.startsWith("--")) continue;
    positional.push(a);
  }

  let changedAbs: string[];
  if (useStdin) {
    const input = await Bun.stdin.text();
    const lines = splitLines(input);
    if (lines.length === 0) {
      cli.log(quiet ? "" : "No affected test files found.");
      return;
    }
    // Resolve against the project dir, not cwd — in CI the runner's cwd is
    // usually not the indexed project, which would silently match nothing.
    changedAbs = lines.map((f) => resolve(dir, f));
  } else if (positional.length > 0) {
    changedAbs = positional.map((f) => resolve(dir, f));
  } else {
    // No input given — fall back to git's working-tree diff against HEAD.
    const gitRoot = await findGitRoot(dir);
    if (!gitRoot) {
      cli.error(
        "No files given and not a git repository. Pass files as arguments, pipe with --stdin, or run inside a git repo.",
      );
      process.exit(1);
    }
    const out = await runGit(["diff", "--name-only", "HEAD"], gitRoot);
    const files = splitLines(out ?? "");
    if (files.length === 0) {
      if (json) cli.log(JSON.stringify({ changed: [], unknown: [], tests: [] }, null, 2));
      else if (!quiet) cli.log("No changed files (git diff against HEAD is empty).");
      return;
    }
    changedAbs = files.map((f) => resolve(gitRoot, f));
  }

  const db = new RagDB(dir);
  const res = affectedTests(db, changedAbs, dir);
  db.close();

  if (json) {
    cli.log(JSON.stringify(res, null, 2));
    return;
  }
  if (quiet) {
    for (const t of res.tests) cli.log(t);
    return;
  }
  if (res.unknown.length > 0) {
    cli.log(`Note: ${res.unknown.length} file(s) not in the index, skipped: ${res.unknown.join(", ")}`);
  }
  if (res.tests.length === 0) {
    cli.log("No affected test files found.");
    return;
  }
  cli.log(
    `${res.tests.length} test file${res.tests.length !== 1 ? "s" : ""} affected by ${res.changed.length} changed file${res.changed.length !== 1 ? "s" : ""}:`,
  );
  for (const t of res.tests) cli.log(`  ${t}`);
}

function splitLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
