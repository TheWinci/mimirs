import { existsSync } from "fs";
import { readFile, writeFile, rm, unlink } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { confirm } from "../setup";
import { cli } from "../../utils/log";

const MARKER = "<!-- local-rag -->";
const INSTRUCTIONS_HEADING = "## Using local-rag tools";

/**
 * Remove the `<!-- local-rag -->` instructions block from a markdown file.
 * If the file becomes empty (or whitespace-only) after removal, delete it.
 */
async function removeInstructionsBlock(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  const content = await readFile(filePath, "utf-8");
  if (!content.includes(MARKER) && !content.includes(INSTRUCTIONS_HEADING)) return null;

  // The block starts at the marker (or heading if no marker) and runs to the
  // next top-level heading or EOF.
  let start = content.indexOf(MARKER);
  if (start === -1) start = content.indexOf(INSTRUCTIONS_HEADING);

  // Walk backwards to consume any blank lines before the block
  while (start > 0 && content[start - 1] === "\n") start--;

  // Find the end: next heading at same level or EOF
  const afterHeading = content.indexOf("\n", content.indexOf(INSTRUCTIONS_HEADING, start));
  let end = content.length;
  if (afterHeading !== -1) {
    // Look for next ## or # heading that isn't part of our block
    const rest = content.slice(afterHeading + 1);
    const nextHeading = rest.search(/^#{1,2} /m);
    if (nextHeading !== -1) {
      end = afterHeading + 1 + nextHeading;
    }
  }

  const cleaned = (content.slice(0, start) + content.slice(end)).replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) {
    await unlink(filePath);
    return `Deleted ${filePath} (was only local-rag content)`;
  }
  await writeFile(filePath, cleaned + "\n");
  return `Removed local-rag block from ${filePath}`;
}

/**
 * Remove the `local-rag` key from a JSON MCP config file.
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
  if (!raw.mcpServers?.["local-rag"]) return null;

  delete raw.mcpServers["local-rag"];

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
  return `Removed local-rag from ${mcpPath}`;
}

/**
 * Remove a file if it exists and was created entirely by local-rag.
 * (e.g. .cursor/rules/local-rag.mdc)
 */
async function removeOwnedFile(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  await unlink(filePath);
  return `Deleted ${filePath}`;
}

/**
 * Remove the `.rag/` line from .gitignore.
 */
async function removeGitignoreEntry(projectDir: string): Promise<string | null> {
  const gitignorePath = join(projectDir, ".gitignore");
  if (!existsSync(gitignorePath)) return null;
  const content = await readFile(gitignorePath, "utf-8");
  const lines = content.split("\n");
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed === ".rag/" || trimmed === ".rag") return false;
    if (trimmed === "# local-rag index") return false;
    return true;
  });
  const cleaned = filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned === content.trim()) return null;
  if (!cleaned) {
    await unlink(gitignorePath);
    return "Deleted .gitignore (was only local-rag content)";
  }
  await writeFile(gitignorePath, cleaned + "\n");
  return "Removed .rag/ from .gitignore";
}

export async function cleanupCommand(args: string[]) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const autoYes = args.includes("--yes") || args.includes("-y");

  // Collect what we'd remove
  const pending: (() => Promise<string | null>)[] = [];

  // .rag/ directory
  const ragDir = join(dir, ".rag");
  if (existsSync(ragDir)) {
    pending.push(async () => {
      await rm(ragDir, { recursive: true, force: true });
      return "Deleted .rag/ directory";
    });
  }

  // MCP configs
  pending.push(() => removeMcpEntry(join(dir, ".mcp.json")));
  pending.push(() => removeMcpEntry(join(dir, ".cursor", "mcp.json")));
  pending.push(() => removeMcpEntry(join(homedir(), ".codeium", "windsurf", "mcp_config.json")));
  pending.push(() => removeMcpEntry(join(homedir(), ".codeium", "mcp_config.json")));

  // Agent instruction files
  pending.push(() => removeInstructionsBlock(join(dir, "CLAUDE.md")));
  pending.push(() => removeOwnedFile(join(dir, ".cursor", "rules", "local-rag.mdc")));
  pending.push(() => removeOwnedFile(join(dir, ".windsurf", "rules", "local-rag.md")));
  pending.push(() => removeInstructionsBlock(join(dir, ".github", "copilot-instructions.md")));

  // .gitignore
  pending.push(() => removeGitignoreEntry(dir));

  if (!autoYes) {
    cli.log("This will remove all local-rag files from this project:\n");
    cli.log("  - .rag/ directory (index database & config)");
    cli.log("  - local-rag entries from MCP configs (.mcp.json, .cursor/mcp.json, windsurf)");
    cli.log("  - Agent instructions (CLAUDE.md block, .cursor/rules/local-rag.mdc, etc.)");
    cli.log("  - .rag/ entry from .gitignore");
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
    cli.log("Nothing to clean up — no local-rag files found.");
  } else {
    for (const action of actions) cli.log(`  ${action}`);
    cli.log(`\nCleaned up ${actions.length} item(s).`);
  }
}
