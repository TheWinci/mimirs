import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
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
- **\`depends_on\`**: List all files that a given file imports — its dependencies.
- **\`depended_on_by\`**: List all files that import a given file — reverse
  dependencies. Use before modifying a shared module to see who depends on it.
- **\`write_relevant\`**: Before adding new code or docs, find the best insertion
  point — returns the most semantically appropriate file and anchor.
- **\`generate_wiki\`**: Generate or update a structured markdown wiki for the
  codebase. Call with \`run: true\` to immediately execute all phases. Follow
  the returned instructions step by step using the other local-rag tools to
  build wiki pages in \`wiki/\`.`;

const MDC_BLOCK = `${MARKER}
---
description: local-rag tool usage instructions
alwaysApply: true
---

${INSTRUCTIONS_BLOCK}`;

const WINDSURF_BLOCK = `${MARKER}
---
trigger: always_on
description: local-rag tool usage instructions
---

${INSTRUCTIONS_BLOCK}`;

const MARKDOWN_BLOCK = INSTRUCTIONS_BLOCK;

export interface SetupResult {
  actions: string[];
  unknownIdes: string[];
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
    if (content.includes(MARKER) || content.includes("## Using local-rag tools")) return null;
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
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, MDC_BLOCK + "\n");
  return `Created ${filePath}`;
}

async function injectWindsurfRule(filePath: string, dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  if (existsSync(filePath)) {
    const content = await readFile(filePath, "utf-8");
    if (content.includes(MARKER)) return null;
  }
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, WINDSURF_BLOCK + "\n");
  return `Created ${filePath}`;
}

export type KnownIDE = "claude" | "cursor" | "windsurf" | "copilot";
export const KNOWN_IDES: KnownIDE[] = ["claude", "cursor", "windsurf", "copilot"];

export function unknownIdes(ides?: string[]): string[] {
  if (!ides) return [];
  const known = new Set<string>(KNOWN_IDES);
  return ides.filter(ide => !known.has(ide));
}

export function parseIdeFlag(value: string): string[] {
  if (value === "all") return [...KNOWN_IDES];
  return value.split(",").map(s => s.trim().toLowerCase());
}

export async function ensureAgentInstructions(projectDir: string, ides?: string[]): Promise<string[]> {
  const actions: string[] = [];
  const forced = new Set(ides);

  // Claude Code — always create/update
  const claudeAction = await injectMarkdown(join(projectDir, "CLAUDE.md"), MARKDOWN_BLOCK);
  if (claudeAction) actions.push(claudeAction);

  // Cursor — if .cursor/ exists or explicitly requested
  if (forced.has("cursor") && !existsSync(join(projectDir, ".cursor"))) {
    await mkdir(join(projectDir, ".cursor"), { recursive: true });
  }
  const cursorAction = await injectMdc(
    join(projectDir, ".cursor", "rules", "local-rag.mdc"),
    join(projectDir, ".cursor")
  );
  if (cursorAction) actions.push(cursorAction);

  // Windsurf — .windsurf/rules/local-rag.md (uses .md with trigger frontmatter, not .mdc)
  if (forced.has("windsurf") && !existsSync(join(projectDir, ".windsurf"))) {
    await mkdir(join(projectDir, ".windsurf"), { recursive: true });
  }
  const windsurfAction = await injectWindsurfRule(
    join(projectDir, ".windsurf", "rules", "local-rag.md"),
    join(projectDir, ".windsurf")
  );
  if (windsurfAction) actions.push(windsurfAction);

  // GitHub Copilot — if .github/ exists or explicitly requested
  if (forced.has("copilot") && !existsSync(join(projectDir, ".github"))) {
    await mkdir(join(projectDir, ".github"), { recursive: true });
  }
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
      args: ["@winci/local-rag@latest", "serve"],
      env: { RAG_PROJECT_DIR: abs },
    },
  }, null, 2);
}

function mcpServerEntry(projectDir: string) {
  return {
    command: "bunx",
    args: ["@winci/local-rag@latest", "serve"],
    env: { RAG_PROJECT_DIR: resolve(projectDir) },
  };
}

async function upsertMcpJson(mcpPath: string, entry: object): Promise<string | null> {
  if (existsSync(mcpPath)) {
    const raw = JSON.parse(await readFile(mcpPath, "utf-8"));
    if (raw.mcpServers?.["local-rag"]) return null;
    raw.mcpServers = raw.mcpServers || {};
    raw.mcpServers["local-rag"] = entry;
    await writeFile(mcpPath, JSON.stringify(raw, null, 2) + "\n");
    return `Added local-rag to ${mcpPath}`;
  }
  await mkdir(join(mcpPath, ".."), { recursive: true });
  await writeFile(
    mcpPath,
    JSON.stringify({ mcpServers: { "local-rag": entry } }, null, 2) + "\n"
  );
  return `Created ${mcpPath} with local-rag`;
}

export async function ensureMcpJson(projectDir: string, ides?: string[]): Promise<string[]> {
  const actions: string[] = [];
  const entry = mcpServerEntry(projectDir);
  const forced = new Set(ides);

  // Claude Code — .mcp.json (always)
  const claudeAction = await upsertMcpJson(join(projectDir, ".mcp.json"), entry);
  if (claudeAction) actions.push(claudeAction);

  // Cursor — .cursor/mcp.json
  if (forced.has("cursor") || existsSync(join(projectDir, ".cursor"))) {
    const action = await upsertMcpJson(join(projectDir, ".cursor", "mcp.json"), entry);
    if (action) actions.push(action);
  }

  // Windsurf — global configs:
  //   Standalone Windsurf:       ~/.codeium/windsurf/mcp_config.json
  //   Windsurf plugin (JetBrains): ~/.codeium/mcp_config.json
  if (forced.has("windsurf") || existsSync(join(projectDir, ".windsurf"))) {
    const windsurfStandalone = join(homedir(), ".codeium", "windsurf", "mcp_config.json");
    const windsurfPlugin = join(homedir(), ".codeium", "mcp_config.json");
    const standaloneAction = await upsertMcpJson(windsurfStandalone, entry);
    if (standaloneAction) actions.push(standaloneAction);
    const pluginAction = await upsertMcpJson(windsurfPlugin, entry);
    if (pluginAction) actions.push(pluginAction);
  }

  return actions;
}

export function detectAgentHints(projectDir: string): string[] {
  const hints: string[] = [];
  if (existsSync(join(projectDir, ".mcp.json")))
    hints.push("Claude Code:  add to .mcp.json → mcpServers");
  if (existsSync(join(projectDir, ".cursor")))
    hints.push("Cursor:       add to .cursor/mcp.json → mcpServers");
  if (existsSync(join(projectDir, ".windsurf"))) {
    hints.push("Windsurf:     add to ~/.codeium/windsurf/mcp_config.json → mcpServers");
    hints.push("Windsurf (JB): add to ~/.codeium/mcp_config.json → mcpServers");
  }
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

export async function runSetup(projectDir: string, ides?: string[]): Promise<SetupResult> {
  const actions: string[] = [];

  const configAction = await ensureConfig(projectDir);
  if (configAction) actions.push(configAction);

  const instructionActions = await ensureAgentInstructions(projectDir, ides);
  actions.push(...instructionActions);

  const mcpActions = await ensureMcpJson(projectDir, ides);
  actions.push(...mcpActions);

  const gitignoreAction = await ensureGitignore(projectDir);
  if (gitignoreAction) actions.push(gitignoreAction);

  return { actions, unknownIdes: unknownIdes(ides) };
}
