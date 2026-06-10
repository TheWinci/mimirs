import { positionalArg } from "../flags";
import { existsSync } from "fs";
import { readFile, writeFile, rm, unlink } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { confirm, FENCE_RE, LEGACY_HEADING } from "../setup";
import { cli } from "../../utils/log";

const MARKER = "<!-- mimirs -->";
const INSTRUCTIONS_HEADING = LEGACY_HEADING;

// Join the text around a removed region without reformatting the rest of the
// user's file (a global \n{3,} collapse used to touch unrelated content).
function spliceOut(content: string, start: number, end: number): string {
  const before = content.slice(0, start).replace(/\n+$/, "");
  const after = content.slice(end).replace(/^\n+/, "");
  if (!before) return after;
  if (!after) return before;
  return before + "\n\n" + after;
}

/**
 * Remove the mimirs instructions block from a markdown file — the current
 * fenced region (`<!-- mimirs:start -->…<!-- mimirs:end -->`) or a legacy
 * marker/heading block. If the file becomes empty after removal, delete it.
 */
async function removeInstructionsBlock(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  const content = await readFile(filePath, "utf-8");

  let cleaned: string | null = null;

  // Current format: remove the whole fenced region, fences included.
  const fence = content.match(FENCE_RE);
  if (fence && fence.index !== undefined) {
    cleaned = spliceOut(content, fence.index, fence.index + fence[0].length);
  } else if (content.includes(MARKER) || content.includes(INSTRUCTIONS_HEADING)) {
    // Legacy formats: block starts at the marker (or heading) and runs to the
    // next top-level heading or EOF.
    let start = content.indexOf(MARKER);
    if (start === -1) start = content.indexOf(INSTRUCTIONS_HEADING);

    const afterHeading = content.indexOf("\n", content.indexOf(INSTRUCTIONS_HEADING, start));
    let end = content.length;
    if (afterHeading !== -1) {
      const rest = content.slice(afterHeading + 1);
      const nextHeading = rest.search(/^#{1,2} /m);
      if (nextHeading !== -1) {
        end = afterHeading + 1 + nextHeading;
      }
    }
    cleaned = spliceOut(content, start, end);
  }

  if (cleaned === null) return null;
  if (!cleaned.trim()) {
    await unlink(filePath);
    return `Deleted ${filePath} (was only mimirs content)`;
  }
  await writeFile(filePath, cleaned.replace(/\n+$/, "") + "\n");
  return `Removed mimirs block from ${filePath}`;
}

/**
 * Remove the `mimirs` key from a `.vscode/mcp.json`-shaped config (top-level
 * `servers` map instead of `mcpServers`). Mirrors what setup's upsertVscodeMcp
 * writes. Deletes the file when nothing else remains.
 */
async function removeVscodeMcpEntry(mcpPath: string): Promise<string | null> {
  if (!existsSync(mcpPath)) return null;
  let raw: any;
  try {
    raw = JSON.parse(await readFile(mcpPath, "utf-8"));
  } catch {
    return null;
  }
  if (!raw.servers?.["mimirs"]) return null;

  delete raw.servers["mimirs"];

  if (Object.keys(raw.servers).length === 0) {
    const otherKeys = Object.keys(raw).filter(k => k !== "servers");
    if (otherKeys.length === 0) {
      await unlink(mcpPath);
      return `Deleted ${mcpPath} (no other servers)`;
    }
    delete raw.servers;
  }

  await writeFile(mcpPath, JSON.stringify(raw, null, 2) + "\n");
  return `Removed mimirs from ${mcpPath}`;
}

/**
 * Remove the `mimirs` key from a JSON MCP config file.
 * If the file has no other servers after removal, delete it.
 */
async function removeMcpEntry(mcpPath: string): Promise<string | null> {
  if (!existsSync(mcpPath)) return null;
  let raw: any;
  try {
    raw = JSON.parse(await readFile(mcpPath, "utf-8"));
  } catch {
    return null;
  }
  if (!raw.mcpServers?.["mimirs"]) return null;

  delete raw.mcpServers["mimirs"];

  if (Object.keys(raw.mcpServers).length === 0) {
    // If mcpServers was the only key, delete the file
    const otherKeys = Object.keys(raw).filter(k => k !== "mcpServers");
    if (otherKeys.length === 0) {
      await unlink(mcpPath);
      return `Deleted ${mcpPath} (no other servers)`;
    }
    delete raw.mcpServers;
  }

  await writeFile(mcpPath, JSON.stringify(raw, null, 2) + "\n");
  return `Removed mimirs from ${mcpPath}`;
}

/**
 * Remove a file if it exists and was created entirely by mimirs.
 * (e.g. .cursor/rules/mimirs.mdc)
 */
async function removeOwnedFile(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  await unlink(filePath);
  return `Deleted ${filePath}`;
}

/**
 * Remove the `.mimirs/` line from .gitignore.
 */
async function removeGitignoreEntry(projectDir: string): Promise<string | null> {
  const gitignorePath = join(projectDir, ".gitignore");
  if (!existsSync(gitignorePath)) return null;
  const content = await readFile(gitignorePath, "utf-8");
  const lines = content.split("\n");
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed === ".mimirs/" || trimmed === ".mimirs") return false;
    if (trimmed === "# mimirs index") return false;
    return true;
  });
  const cleaned = filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned === content.trim()) return null;
  if (!cleaned) {
    await unlink(gitignorePath);
    return "Deleted .gitignore (was only mimirs content)";
  }
  await writeFile(gitignorePath, cleaned + "\n");
  return "Removed .mimirs/ from .gitignore";
}

export async function cleanupCommand(args: string[]) {
  const dir = resolve(positionalArg(args[1], "."));
  const autoYes = args.includes("--yes") || args.includes("-y");

  // Collect what we'd remove
  const pending: (() => Promise<string | null>)[] = [];

  // .mimirs/ directory — honor RAG_DB_DIR (the documented workaround for
  // read-only project dirs); the index may live there instead of ./.mimirs.
  const ragDir = process.env.RAG_DB_DIR ? resolve(process.env.RAG_DB_DIR) : join(dir, ".mimirs");
  if (existsSync(ragDir)) {
    pending.push(async () => {
      await rm(ragDir, { recursive: true, force: true });
      return `Deleted index directory ${ragDir}`;
    });
  }

  // MCP configs — mirror every file setup can create (setup.ts ensureMcpJson)
  pending.push(() => removeMcpEntry(join(dir, ".mcp.json")));
  pending.push(() => removeMcpEntry(join(dir, ".cursor", "mcp.json")));
  pending.push(() => removeMcpEntry(join(dir, ".junie", "mcp.json")));
  pending.push(() => removeVscodeMcpEntry(join(dir, ".vscode", "mcp.json")));
  pending.push(() => removeMcpEntry(join(homedir(), ".codeium", "windsurf", "mcp_config.json")));
  pending.push(() => removeMcpEntry(join(homedir(), ".codeium", "mcp_config.json")));

  // Agent instruction files — mirror setup.ts ensureAgentInstructions
  pending.push(() => removeInstructionsBlock(join(dir, "CLAUDE.md")));
  pending.push(() => removeOwnedFile(join(dir, ".cursor", "rules", "mimirs.mdc")));
  pending.push(() => removeOwnedFile(join(dir, ".windsurf", "rules", "mimirs.md")));
  pending.push(() => removeInstructionsBlock(join(dir, ".junie", "guidelines", "mimirs.md")));
  pending.push(() => removeInstructionsBlock(join(dir, ".github", "copilot-instructions.md")));

  // .gitignore
  pending.push(() => removeGitignoreEntry(dir));

  if (!autoYes) {
    cli.log("This will remove all mimirs files from this project:\n");
    cli.log("  - .mimirs/ directory (index database & config)");
    cli.log("  - mimirs entries from MCP configs (.mcp.json, .cursor/mcp.json, windsurf)");
    cli.log("  - Agent instructions (CLAUDE.md block, .cursor/rules/mimirs.mdc, etc.)");
    cli.log("  - .mimirs/ entry from .gitignore");
    cli.log();
    const ok = await confirm("Proceed? [y/N] ");
    if (!ok) {
      cli.log("Aborted.");
      return;
    }
  }

  const actions: string[] = [];
  for (const fn of pending) {
    const result = await fn();
    if (result) actions.push(result);
  }

  if (actions.length === 0) {
    cli.log("Nothing to clean up — no mimirs files found.");
  } else {
    for (const action of actions) cli.log(`  ${action}`);
    cli.log(`\nCleaned up ${actions.length} item(s).`);
  }
}
