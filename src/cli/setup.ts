import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { loadConfig } from "../config";

const MARKER = "<!-- local-rag -->";

const INSTRUCTIONS_BLOCK = `## Using local-rag tools

This project has a local RAG index (local-rag). Use these MCP tools:

- **\`search\`**: Discover which files are relevant to a topic. Returns file paths
  with snippet previews — use this when you need to know *where* something is.
- **\`read_relevant\`**: Get the actual content of relevant semantic chunks —
  individual functions, classes, or markdown sections — ranked by relevance.
  Results include exact line ranges (\`src/db.ts:42-67\`) so you can navigate
  directly to the edit location. Use this instead of \`search\` + \`Read\` when
  you need the content itself. Two chunks from the same file can both appear
  (no file deduplication).
- **\`project_map\`**: When you need to understand how files relate to each other,
  generate a dependency graph. Use \`focus\` to zoom into a specific file's
  neighborhood. This is faster than reading import statements across many files.
- **\`search_conversation\`**: Search past conversation history to recall previous
  decisions, discussions, and tool outputs. Use this before re-investigating
  something that may have been discussed in an earlier session.
- **\`create_checkpoint\`**: Mark important moments — decisions, milestones,
  blockers, direction changes. Do this liberally: after completing any feature
  or task, after adding/modifying tools, after key technical decisions, before
  and after large refactors, or when changing direction. If in doubt, create one.
- **\`list_checkpoints\`** / **\`search_checkpoints\`**: Review or search past
  checkpoints to understand project history and prior decisions.
- **\`index_files\`**: If you've created or modified files and want them searchable,
  re-index the project directory.
- **\`search_analytics\`**: Check what queries return no results or low-relevance
  results — this reveals documentation gaps.
- **\`search_symbols\`**: When you know a symbol name (function, class, type, etc.),
  find it directly by name instead of using semantic search.
- **\`find_usages\`**: Before changing a function or type, find all its call sites.
  Use this to understand the blast radius of a rename or API change. Faster and
  more reliable than semantic search for finding usages.
- **\`git_context\`**: At the start of a session (or any time you need orientation),
  call this to see what files have already been modified, recent commits, and
  which changed files are in the index. Avoids redundant searches and conflicting
  edits on already-modified files.
- **\`annotate\`**: Attach a persistent note to a file or symbol — "known race
  condition", "don't refactor until auth rewrite lands", etc. Notes appear as
  \`[NOTE]\` blocks inline in \`read_relevant\` results automatically.
- **\`get_annotations\`**: Retrieve all notes for a file, or search semantically
  across all annotations to find relevant caveats before editing.
- **\`write_relevant\`**: Before adding new code or docs, find the best insertion
  point — returns the most semantically appropriate file and anchor.`;

const MDC_BLOCK = `${MARKER}
---
description: local-rag tool usage instructions
alwaysApply: true
---

${INSTRUCTIONS_BLOCK}`;

const MARKDOWN_BLOCK = `${MARKER}
${INSTRUCTIONS_BLOCK}`;

export interface SetupResult {
  actions: string[];
}

export async function ensureConfig(projectDir: string): Promise<string | null> {
  const configPath = join(projectDir, ".rag", "config.json");
  if (existsSync(configPath)) return null;
  // loadConfig auto-creates the file with defaults if missing
  await loadConfig(projectDir);
  return "Created .rag/config.json";
}

export async function ensureGitignore(projectDir: string): Promise<string | null> {
  const gitignorePath = join(projectDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, "# local-rag index\n.rag/\n");
    return "Created .gitignore with .rag/";
  }
  const content = await readFile(gitignorePath, "utf-8");
  if (content.split("\n").some(line => line.trim() === ".rag/" || line.trim() === ".rag")) {
    return null;
  }
  await writeFile(gitignorePath, content.trimEnd() + "\n\n# local-rag index\n.rag/\n");
  return "Added .rag/ to .gitignore";
}

async function injectMarkdown(filePath: string, block: string): Promise<string | null> {
  if (existsSync(filePath)) {
    const content = await readFile(filePath, "utf-8");
    if (content.includes(MARKER)) return null;
    await writeFile(filePath, content.trimEnd() + "\n\n" + block + "\n");
    return `Updated ${filePath}`;
  }
  await writeFile(filePath, block + "\n");
  return `Created ${filePath}`;
}

async function injectMdc(filePath: string, dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  if (existsSync(filePath)) {
    const content = await readFile(filePath, "utf-8");
    if (content.includes(MARKER)) return null;
  }
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, MDC_BLOCK + "\n");
  return `Created ${filePath}`;
}

export async function ensureAgentInstructions(projectDir: string): Promise<string[]> {
  const actions: string[] = [];

  // Claude Code — always create/update
  const claudeAction = await injectMarkdown(join(projectDir, "CLAUDE.md"), MARKDOWN_BLOCK);
  if (claudeAction) actions.push(claudeAction);

  // Cursor — only if .cursor/ exists
  const cursorAction = await injectMdc(
    join(projectDir, ".cursor", "rules", "local-rag.mdc"),
    join(projectDir, ".cursor")
  );
  if (cursorAction) actions.push(cursorAction);

  // Windsurf — only if .windsurf/ exists
  const windsurfAction = await injectMdc(
    join(projectDir, ".windsurf", "rules", "local-rag.mdc"),
    join(projectDir, ".windsurf")
  );
  if (windsurfAction) actions.push(windsurfAction);

  // GitHub Copilot — only if .github/ exists
  if (existsSync(join(projectDir, ".github"))) {
    const copilotAction = await injectMarkdown(
      join(projectDir, ".github", "copilot-instructions.md"),
      MARKDOWN_BLOCK
    );
    if (copilotAction) actions.push(copilotAction);
  }

  return actions;
}

export function mcpConfigSnippet(projectDir: string): string {
  const abs = resolve(projectDir);
  return JSON.stringify({
    "local-rag": {
      command: "bunx",
      args: ["@winci/local-rag@latest"],
      env: { RAG_PROJECT_DIR: abs },
    },
  }, null, 2);
}

export function detectAgentHints(projectDir: string): string[] {
  const hints: string[] = [];
  if (existsSync(join(projectDir, ".mcp.json")))
    hints.push("Claude Code:  add to .mcp.json → mcpServers");
  if (existsSync(join(projectDir, ".cursor")))
    hints.push("Cursor:       add to .cursor/mcp.json → mcpServers");
  if (existsSync(join(projectDir, ".windsurf")))
    hints.push("Windsurf:     add to .windsurf/mcp.json → mcpServers");
  if (hints.length === 0)
    hints.push("Add to your agent's MCP config under mcpServers:");
  return hints;
}

export function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim().toLowerCase() !== "n");
    });
  });
}

export async function runSetup(projectDir: string): Promise<SetupResult> {
  const actions: string[] = [];

  const configAction = await ensureConfig(projectDir);
  if (configAction) actions.push(configAction);

  const instructionActions = await ensureAgentInstructions(projectDir);
  actions.push(...instructionActions);

  const gitignoreAction = await ensureGitignore(projectDir);
  if (gitignoreAction) actions.push(gitignoreAction);

  return { actions };
}
