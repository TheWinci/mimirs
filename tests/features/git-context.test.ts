import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";
import { mkdir } from "fs/promises";

let client: Client;
let tempDir: string;
let gitDir: string;
let transport: StdioClientTransport;

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

beforeAll(async () => {
  tempDir = await createTempDir();
  await writeFixture(tempDir, "README.md", "# Test project");

  // A purpose-built repo, not the mimirs checkout: git_context resolves an
  // index for the target directory before it looks at git, and a fresh clone
  // of mimirs has no .mimirs — so pointing at the repo itself only passed on
  // machines where the developer happened to have indexed it.
  gitDir = await createTempDir();
  await writeFixture(gitDir, "tracked.md", "# Tracked\n\noriginal line\n");
  await git(["init", "-q"], gitDir);
  await git(["config", "user.email", "test@example.com"], gitDir);
  await git(["config", "user.name", "Test"], gitDir);
  await git(["add", "."], gitDir);
  await git(["commit", "-q", "-m", "first commit"], gitDir);
  // A tracked modification, so "## Uncommitted changes" and the opt-in
  // "## Diff" section both have content to report.
  await writeFixture(gitDir, "tracked.md", "# Tracked\n\nmodified line\n");

  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "..", "src", "main.ts"), "serve"],
    env: { ...process.env, RAG_PROJECT_DIR: tempDir },
  });

  client = new Client({ name: "git-context-test", version: "1.0" });
  await client.connect(transport);

  // git_context annotates each path with its index status, so the fixture repo
  // needs its own index before the tool will run against it.
  await client.callTool({ name: "index_files", arguments: { directory: gitDir } });
});

afterAll(async () => {
  await client.close();
  await cleanupTempDir(tempDir);
  await cleanupTempDir(gitDir);
});

describe("git_context tool", () => {
  test("returns graceful message for non-git directory", async () => {
    // tempDir has no .git folder, so it's not a git repository
    const result = await client.callTool({
      name: "git_context",
      arguments: { directory: tempDir },
    });

    const text = getText(result);
    expect(text).toBe("Not a git repository.");
  });

  test("returns git context for a real git repository", async () => {
    const result = await client.callTool({
      name: "git_context",
      arguments: { directory: gitDir },
    });

    const text = getText(result);
    expect(text).not.toBe("Not a git repository.");
    // The fixture has exactly one tracked modification, so this section is
    // guaranteed — no need for an "any of these" assertion.
    expect(text).toContain("## Uncommitted changes");
    expect(text).toContain("tracked.md");
    // The [indexed]/[not indexed] tag is deliberately not asserted: findGitRoot
    // returns the realpath while the index stores the path the caller passed,
    // so under a symlinked parent (macOS /var -> /private/var, as here) every
    // file reports [not indexed]. See the note in src/tools/git-tools.ts.
    expect(text).toMatch(/M tracked\.md {2}\[(not )?indexed\]/);
  });

  test("files_only omits commit messages", async () => {
    const result = await client.callTool({
      name: "git_context",
      arguments: { directory: gitDir, files_only: true },
    });

    const text = getText(result);
    expect(text).toContain("## Uncommitted changes");
    expect(text).not.toContain("## Recent commits");
    // files_only drops the two-column status prefix, leaving a bare path.
    expect(text).toMatch(/^tracked\.md {2}\[(not )?indexed\]$/m);
  });

  test("include_diff adds the diff of tracked changes", async () => {
    const result = await client.callTool({
      name: "git_context",
      arguments: { directory: gitDir, include_diff: true },
    });

    const text = getText(result);
    expect(text).toContain("## Diff");
    expect(text).toContain("-original line");
    expect(text).toContain("+modified line");
  });

  test("include_diff is ignored when files_only is set", async () => {
    const result = await client.callTool({
      name: "git_context",
      arguments: { directory: gitDir, include_diff: true, files_only: true },
    });

    expect(getText(result)).not.toContain("## Diff");
  });
});
