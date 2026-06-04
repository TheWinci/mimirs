import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ensureAgentInstructions, ensureMcpJson, BLOCK_VERSION, INSTRUCTIONS_BLOCK } from "../../src/cli/setup";

const dirs: string[] = [];
async function projectDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mimirs-init-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const START = `<!-- mimirs:start v=${BLOCK_VERSION} -->`;
const END = "<!-- mimirs:end -->";

describe("init: fenced + version-stamped instruction region", () => {
  test("creates CLAUDE.md with a fenced, version-stamped block", async () => {
    const dir = await projectDir();
    const actions = await ensureAgentInstructions(dir);
    const claude = await readFile(join(dir, "CLAUDE.md"), "utf-8");

    expect(claude).toContain(START);
    expect(claude).toContain("## Using mimirs tools");
    expect(claude).toContain(END);
    expect(actions.some((a) => a.includes("CLAUDE.md"))).toBe(true);
  });

  test("re-running on a current block is a no-op (no write, no action)", async () => {
    const dir = await projectDir();
    await ensureAgentInstructions(dir);
    const claudePath = join(dir, "CLAUDE.md");
    const before = await readFile(claudePath, "utf-8");

    const actions = await ensureAgentInstructions(dir);
    const after = await readFile(claudePath, "utf-8");

    expect(after).toBe(before);
    expect(actions.find((a) => a.includes("CLAUDE.md"))).toBeUndefined();
  });

  test("replaces a stale fenced block in place, preserving user content", async () => {
    const dir = await projectDir();
    const claudePath = join(dir, "CLAUDE.md");
    const stale =
      "# My project\n\nproject notes here\n\n" +
      "<!-- mimirs:start v=0000000 -->\n## Using mimirs tools\nOLD CONTENT\n<!-- mimirs:end -->\n";
    await writeFile(claudePath, stale);

    const actions = await ensureAgentInstructions(dir);
    const out = await readFile(claudePath, "utf-8");

    expect(out).toContain("# My project"); // user content kept
    expect(out).toContain("project notes here");
    expect(out).toContain(`v=${BLOCK_VERSION}`);
    expect(out).not.toContain("v=0000000"); // stale stamp gone
    expect(out).not.toContain("OLD CONTENT");
    expect(out).toContain("`wiki`"); // current block content present
    expect(actions.some((a) => a.includes("Updated mimirs block"))).toBe(true);
  });

  test("migrates a pre-fence (legacy) block to the fenced form", async () => {
    const dir = await projectDir();
    const claudePath = join(dir, "CLAUDE.md");
    const legacy =
      "# My notes\n\nkeep me\n\n## Using mimirs tools\n\n- `find_usages`: old renamed tool\n- old bullet\n";
    await writeFile(claudePath, legacy);

    const actions = await ensureAgentInstructions(dir);
    const out = await readFile(claudePath, "utf-8");

    expect(out).toContain("# My notes"); // content before the block kept
    expect(out).toContain("keep me");
    expect(out).toContain(START);
    expect(out).not.toContain("old bullet");
    expect(out).not.toContain("find_usages"); // stale tool name gone
    // heading exists exactly once (inside the new fenced region)
    expect(out.split("## Using mimirs tools").length - 1).toBe(1);
    expect(actions.some((a) => a.includes("Updated mimirs block"))).toBe(true);
  });

  test("repo CLAUDE.md is the canonical block, fenced and in sync", async () => {
    // Single source of truth: the repo's own CLAUDE.md must be INSTRUCTIONS_BLOCK
    // wrapped in the current-version fence. If someone edits the block without
    // regenerating CLAUDE.md (or vice-versa), one of these fails.
    const claude = await readFile(join(import.meta.dir, "..", "..", "CLAUDE.md"), "utf-8");
    expect(claude).toContain(`<!-- mimirs:start v=${BLOCK_VERSION} -->`);
    expect(claude).toContain(INSTRUCTIONS_BLOCK);
  });

  test("dedicated Cursor .mdc: frontmatter first, fenced block, idempotent, updatable", async () => {
    const dir = await projectDir();
    const mdcPath = join(dir, ".cursor", "rules", "mimirs.mdc");

    await ensureAgentInstructions(dir, ["cursor"]);
    let mdc = await readFile(mdcPath, "utf-8");
    expect(mdc.startsWith("---")).toBe(true); // frontmatter at byte 0 (Cursor needs this)
    expect(mdc).toContain("alwaysApply: true");
    expect(mdc).toContain(START);

    // idempotent
    const again = await ensureAgentInstructions(dir, ["cursor"]);
    expect(again.find((a) => a.includes("mimirs.mdc"))).toBeUndefined();

    // stale → rewritten to current version
    await writeFile(
      mdcPath,
      "---\ndescription: x\n---\n\n<!-- mimirs:start v=0000000 -->\nold\n<!-- mimirs:end -->\n",
    );
    const updated = await ensureAgentInstructions(dir, ["cursor"]);
    mdc = await readFile(mdcPath, "utf-8");
    expect(mdc).toContain(`v=${BLOCK_VERSION}`);
    expect(mdc).not.toContain("v=0000000");
    expect(updated.some((a) => a.includes("Updated") && a.includes("mimirs.mdc"))).toBe(true);
  });

  test("Copilot: ensureMcpJson writes .vscode/mcp.json with the servers schema", async () => {
    const dir = await projectDir();
    await ensureMcpJson(dir, ["copilot"]);

    const vscode = JSON.parse(await readFile(join(dir, ".vscode", "mcp.json"), "utf-8"));
    expect(vscode.servers.mimirs.type).toBe("stdio");
    expect(vscode.servers.mimirs.command).toBe("bunx");
    expect(vscode.servers.mimirs.args).toEqual(["mimirs@latest", "serve"]);
    expect(vscode.mcpServers).toBeUndefined(); // VS Code uses `servers`, not the Claude schema

    // Claude's .mcp.json still uses the mcpServers schema
    const claude = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
    expect(claude.mcpServers.mimirs.command).toBe("bunx");
  });
});
