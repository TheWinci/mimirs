import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { createHash } from "crypto";
import { loadConfig } from "../config";

// Marker the pre-fence init wrote at the top of dedicated rule files.
const LEGACY_MARKER = "<!-- mimirs -->";

export const INSTRUCTIONS_BLOCK = `## Using mimirs tools

This project has a local RAG index (mimirs). Use these MCP tools:

- **\`search\`**: Discover which files are relevant to a topic. Returns file paths
  with snippet previews — use this when you need to know *where* something is.
  Supports optional \`extensions\`, \`dirs\`, and \`excludeDirs\` filters to scope
  results (e.g. restrict to \`.ts\` files, or under \`src/\`).
- **\`read_relevant\`**: Get the actual content of relevant semantic chunks —
  individual functions, classes, or markdown sections — ranked by relevance.
  Results include exact line ranges (\`src/db.ts:42-67\`) so you can navigate
  directly to the edit location. Use this instead of \`search\` + \`Read\` when
  you need the content itself. Two chunks from the same file can both appear
  (no file deduplication). Accepts the same \`extensions\`/\`dirs\`/\`excludeDirs\`
  filters as \`search\`.
- **\`project_map\`**: When you need to understand how files relate to each other,
  generate a dependency graph. Use \`focus\` to zoom into a specific file's
  neighborhood. This is faster than reading import statements across many files.
- **\`search_conversation\`**: Search past conversation history to recall previous
  decisions, discussions, and tool outputs. Use this before re-investigating
  something that may have been discussed in an earlier session. Returns short
  snippets — follow up with \`read_conversation\` to get the full text.
- **\`read_conversation\`**: Read the full verbatim text of past turns by
  \`sessionId\` + turn index (or a \`from\`/\`to\` range, or \`turn\` + \`context\`). The
  read counterpart to \`search_conversation\`: it locates the turn, this hydrates
  it. Pass \`includeToolOutput: true\` to also get tool results (re-parses the raw
  transcript; slower). Defaults to the most recent session's tail when given no
  selector.
- **\`create_checkpoint\`**: **Call this as your final step after completing any
  user-requested task**, before responding to the user. Also call when hitting
  a blocker or changing direction mid-task. Include what was done, which files
  changed, and why. This is the only way future sessions know what happened.
- **\`list_checkpoints\`** / **\`search_checkpoints\`**: Review or search past
  checkpoints to understand project history and prior decisions.
- **\`index_files\`**: If you've created or modified files and want them searchable,
  re-index the project directory.
- **\`search_analytics\`**: Check what queries return no results or low-relevance
  results — this reveals documentation gaps.
- **\`search_symbols\`**: When you know a symbol name (function, class, type, etc.),
  find it directly by name instead of using semantic search.
- **\`usages\`**: Before changing a function or type, find all its call sites.
  Use this to understand the blast radius of a rename or API change. Faster and
  more reliable than semantic search for finding usages.
- **\`git_context\`**: At the start of a session (or any time you need orientation),
  call this to see what files have already been modified, recent commits, and
  which changed files are in the index. Avoids redundant searches and conflicting
  edits on already-modified files.
- **\`search_commits\`**: Semantically search git commit history — find *why* code
  was changed, when decisions were made, or what an author worked on. Supports
  filters for author, date range, and file path. Requires git history to be
  indexed first (\`mimirs history index\` or \`mimirs index git\`).
- **\`file_history\`**: Get the commit history for a specific file. Returns commits
  that touched it, sorted by date. Use this to understand how a file evolved.
- **\`annotate\`**: Call this immediately when you encounter a known bug, race
  condition, fragile code, non-obvious constraint, or workaround while reading
  code. Notes persist across sessions and surface as \`[NOTE]\` blocks inline in
  \`read_relevant\` results automatically.
- **\`get_annotations\`**: Retrieve all notes for a file, or search semantically
  across all annotations to find relevant caveats before editing.
- **\`delete_annotation\`**: Remove an annotation that is no longer relevant — a
  fixed bug, a lifted constraint, or a note on deleted code. Use
  \`get_annotations\` first to find the ID.
- **\`depends_on\`**: List all files that a given file imports — its dependencies.
- **\`dependents\`**: List all files that import a given file — reverse
  dependencies. Use before modifying a shared module to see who depends on it.
- **\`impact\`**: Symbol-level blast radius — the transitive *callers* of a
  function or method as a pruned call tree, plus the test files to run. More
  precise than \`dependents\` (file-level). Use before changing a signature or
  behavior. Pass \`file\` to disambiguate a name defined in several places.
- **\`trace\`**: Show how one symbol reaches another — the reachable call
  sub-graph from \`from\` to \`to\`, shortest path highlighted ("how does X reach
  Y"). Resolution is static, so a dynamic-dispatch hop (callback, interface→impl,
  DI) can break the chain — it says so when it does.
- **Assessing blast radius / reviewing a diff**: for a single function or
  method, \`impact\` returns the transitive caller tree + tests to run in one call,
  and \`trace\` shows how two symbols connect. Widen with \`dependents\`
  (file-level importers) and \`get_annotations\` (known caveats) when a change
  spans a whole module. For diff or PR review, pair \`git_context\` (what changed)
  with \`impact\`/\`usages\` on the changed symbols and \`search_checkpoints\` for
  prior decisions.
- **\`write_relevant\`**: Before adding new code or docs, find the best insertion
  point — returns the most semantically appropriate file and anchor.
- **\`connect_repo\`**: Attach another repo's mimirs index for cross-repo
  queries (query-only — that repo's own server keeps it fresh). Then pass its
  path as \`directory\` to \`search\`/\`read_relevant\`/other read tools.
- **\`wiki\`**: Rebuild the project wiki. Start with \`wiki(command: "shape")\` and
  follow the prompts it returns — each step names the next.`;

// A short content hash of the instructions block, stamped into the managed
// region so a later `init` can tell a current block from an out-of-date one and
// replace just that region. It changes only when INSTRUCTIONS_BLOCK changes —
// not on every release — so an unchanged block is never flagged stale.
export const BLOCK_VERSION = createHash("sha256").update(INSTRUCTIONS_BLOCK).digest("hex").slice(0, 7);

const FENCE_END = "<!-- mimirs:end -->";
const fenceStart = (v: string) => `<!-- mimirs:start v=${v} -->`;
// Matches one managed region and captures its stamped version. No `g` flag, so
// `.test()` / `.match()` stay stateless. Exported so cleanup removes the same
// region init writes — the two must never drift on the block format again.
export const FENCE_RE = /<!-- mimirs:start v=([0-9a-z]+) -->[\s\S]*?<!-- mimirs:end -->/;
// The heading the block always opens with — used to find a pre-fence block.
export const LEGACY_HEADING = "## Using mimirs tools";

function fencedRegion(inner: string): string {
  return `${fenceStart(BLOCK_VERSION)}\n${inner}\n${FENCE_END}`;
}

const MDC_FRONTMATTER = `---
description: mimirs tool usage instructions
alwaysApply: true
---`;

const WINDSURF_FRONTMATTER = `---
trigger: always_on
description: mimirs tool usage instructions
---`;

export interface SetupResult {
  actions: string[];
  unknownIdes: string[];
}

export async function ensureConfig(projectDir: string): Promise<string | null> {
  const configPath = join(projectDir, ".mimirs", "config.json");
  if (existsSync(configPath)) return null;
  // loadConfig auto-creates the file with defaults if missing
  await loadConfig(projectDir);
  return "Created .mimirs/config.json";
}

export async function ensureGitignore(projectDir: string): Promise<string | null> {
  const gitignorePath = join(projectDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, "# mimirs index\n.mimirs/\n");
    return "Created .gitignore with .mimirs/";
  }
  const content = await readFile(gitignorePath, "utf-8");
  if (content.split("\n").some(line => line.trim() === ".mimirs/" || line.trim() === ".mimirs")) {
    return null;
  }
  await writeFile(gitignorePath, content.trimEnd() + "\n\n# mimirs index\n.mimirs/\n");
  return "Added .mimirs/ to .gitignore";
}

// Shared markdown files (CLAUDE.md, Junie guidelines, Copilot instructions): the
// user owns the file, mimirs owns one fenced region inside it. Re-running init
// refreshes that region in place when the block changed, and never touches the
// user's surrounding content.
async function injectMarkdown(filePath: string, inner: string): Promise<string | null> {
  const region = fencedRegion(inner);
  if (existsSync(filePath)) {
    const content = await readFile(filePath, "utf-8");

    const fence = content.match(FENCE_RE);
    if (fence) {
      if (fence[1] === BLOCK_VERSION) return null;            // already current
      await writeFile(filePath, content.replace(FENCE_RE, region));
      return `Updated mimirs block in ${filePath} (v=${BLOCK_VERSION})`;
    }

    // Pre-fence block from an older init. It was appended last at write time,
    // but the user may have added their own sections below it since — so claim
    // only up to the next h1/h2 heading, not to EOF.
    const idx = content.indexOf(LEGACY_HEADING);
    if (idx !== -1) {
      const before = content.slice(0, idx).trimEnd();
      const afterHeading = content.slice(idx + LEGACY_HEADING.length);
      const nextHeading = afterHeading.search(/^#{1,2} /m);
      const after = nextHeading === -1 ? "" : afterHeading.slice(nextHeading).trimEnd();
      await writeFile(
        filePath,
        (before ? before + "\n\n" : "") + region + "\n" + (after ? "\n" + after + "\n" : ""),
      );
      return `Updated mimirs block in ${filePath} (v=${BLOCK_VERSION})`;
    }

    // No managed region yet — append one.
    await writeFile(filePath, content.trimEnd() + "\n\n" + region + "\n");
    return `Updated ${filePath}`;
  }
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, region + "\n");
  return `Created ${filePath}`;
}

// Dedicated rule files (Cursor .mdc, Windsurf .md): mimirs owns the whole file —
// the editor's frontmatter first, then the fenced block. Rewritten wholesale
// when the stamped version differs.
async function injectDedicated(filePath: string, dir: string, frontmatter: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const full = `${frontmatter}\n\n${fencedRegion(INSTRUCTIONS_BLOCK)}\n`;
  if (existsSync(filePath)) {
    const content = await readFile(filePath, "utf-8");
    if (content.includes(fenceStart(BLOCK_VERSION))) return null;   // already current
    const hadBlock = FENCE_RE.test(content) || content.includes(LEGACY_MARKER) || content.includes(LEGACY_HEADING);
    await writeFile(filePath, full);
    return hadBlock ? `Updated ${filePath} (v=${BLOCK_VERSION})` : `Created ${filePath}`;
  }
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, full);
  return `Created ${filePath}`;
}

async function injectMdc(filePath: string, dir: string): Promise<string | null> {
  return injectDedicated(filePath, dir, MDC_FRONTMATTER);
}

async function injectWindsurfRule(filePath: string, dir: string): Promise<string | null> {
  return injectDedicated(filePath, dir, WINDSURF_FRONTMATTER);
}

export type KnownIDE = "claude" | "cursor" | "windsurf" | "copilot" | "jetbrains";
export const KNOWN_IDES: KnownIDE[] = ["claude", "cursor", "windsurf", "copilot", "jetbrains"];

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
  const claudeAction = await injectMarkdown(join(projectDir, "CLAUDE.md"), INSTRUCTIONS_BLOCK);
  if (claudeAction) actions.push(claudeAction);

  // Cursor — if .cursor/ exists or explicitly requested
  if (forced.has("cursor") && !existsSync(join(projectDir, ".cursor"))) {
    await mkdir(join(projectDir, ".cursor"), { recursive: true });
  }
  const cursorAction = await injectMdc(
    join(projectDir, ".cursor", "rules", "mimirs.mdc"),
    join(projectDir, ".cursor")
  );
  if (cursorAction) actions.push(cursorAction);

  // Windsurf — .windsurf/rules/mimirs.md (uses .md with trigger frontmatter, not .mdc)
  if (forced.has("windsurf") && !existsSync(join(projectDir, ".windsurf"))) {
    await mkdir(join(projectDir, ".windsurf"), { recursive: true });
  }
  const windsurfAction = await injectWindsurfRule(
    join(projectDir, ".windsurf", "rules", "mimirs.md"),
    join(projectDir, ".windsurf")
  );
  if (windsurfAction) actions.push(windsurfAction);

  // JetBrains (Junie) — .junie/guidelines/mimirs.md
  if (forced.has("jetbrains") && !existsSync(join(projectDir, ".junie"))) {
    await mkdir(join(projectDir, ".junie"), { recursive: true });
  }
  if (existsSync(join(projectDir, ".junie"))) {
    const junieAction = await injectMarkdown(
      join(projectDir, ".junie", "guidelines", "mimirs.md"),
      INSTRUCTIONS_BLOCK
    );
    if (junieAction) actions.push(junieAction);
  }

  // GitHub Copilot — if .github/ exists or explicitly requested
  if (forced.has("copilot") && !existsSync(join(projectDir, ".github"))) {
    await mkdir(join(projectDir, ".github"), { recursive: true });
  }
  if (existsSync(join(projectDir, ".github"))) {
    const copilotAction = await injectMarkdown(
      join(projectDir, ".github", "copilot-instructions.md"),
      INSTRUCTIONS_BLOCK
    );
    if (copilotAction) actions.push(copilotAction);
  }

  return actions;
}

export function mcpConfigSnippet(projectDir: string): string {
  const abs = resolve(projectDir);
  return JSON.stringify({
    "mimirs": {
      command: "bunx",
      args: ["mimirs@latest", "serve"],
      env: { RAG_PROJECT_DIR: abs },
    },
  }, null, 2);
}

function mcpServerEntry(projectDir: string) {
  return {
    command: "bunx",
    args: ["mimirs@latest", "serve"],
    env: { RAG_PROJECT_DIR: resolve(projectDir) },
  };
}

async function upsertMcpJson(mcpPath: string, entry: object): Promise<string | null> {
  if (existsSync(mcpPath)) {
    let raw: any;
    try {
      raw = JSON.parse(await readFile(mcpPath, "utf-8"));
    } catch {
      return `Skipped ${mcpPath} (invalid JSON — fix it manually or delete it)`;
    }
    if (raw.mcpServers?.["mimirs"]) return null;
    raw.mcpServers = raw.mcpServers || {};
    raw.mcpServers["mimirs"] = entry;
    await writeFile(mcpPath, JSON.stringify(raw, null, 2) + "\n");
    return `Added mimirs to ${mcpPath}`;
  }
  await mkdir(join(mcpPath, ".."), { recursive: true });
  await writeFile(
    mcpPath,
    JSON.stringify({ mcpServers: { "mimirs": entry } }, null, 2) + "\n"
  );
  return `Created ${mcpPath} with mimirs`;
}

// GitHub Copilot (VS Code) reads MCP servers from .vscode/mcp.json, which uses a
// different shape than the others: a top-level `servers` map and a `type` field.
async function upsertVscodeMcp(mcpPath: string, entry: object): Promise<string | null> {
  const vsEntry = { type: "stdio", ...entry };
  if (existsSync(mcpPath)) {
    let raw: any;
    try {
      raw = JSON.parse(await readFile(mcpPath, "utf-8"));
    } catch {
      return `Skipped ${mcpPath} (invalid JSON — fix it manually or delete it)`;
    }
    if (raw.servers?.["mimirs"]) return null;
    raw.servers = raw.servers || {};
    raw.servers["mimirs"] = vsEntry;
    await writeFile(mcpPath, JSON.stringify(raw, null, 2) + "\n");
    return `Added mimirs to ${mcpPath}`;
  }
  await mkdir(join(mcpPath, ".."), { recursive: true });
  await writeFile(mcpPath, JSON.stringify({ servers: { "mimirs": vsEntry } }, null, 2) + "\n");
  return `Created ${mcpPath} with mimirs`;
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

  // JetBrains (Junie) — .junie/mcp.json (project-level)
  if (forced.has("jetbrains") && !existsSync(join(projectDir, ".junie"))) {
    await mkdir(join(projectDir, ".junie"), { recursive: true });
  }
  if (existsSync(join(projectDir, ".junie"))) {
    const action = await upsertMcpJson(join(projectDir, ".junie", "mcp.json"), entry);
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

  // GitHub Copilot (VS Code) — .vscode/mcp.json (servers map, type stdio)
  if (forced.has("copilot") || existsSync(join(projectDir, ".github")) || existsSync(join(projectDir, ".vscode"))) {
    const action = await upsertVscodeMcp(join(projectDir, ".vscode", "mcp.json"), entry);
    if (action) actions.push(action);
  }

  return actions;
}

export function detectAgentHints(projectDir: string): string[] {
  const hints: string[] = [];
  if (existsSync(join(projectDir, ".mcp.json")))
    hints.push("Claude Code:  add to .mcp.json → mcpServers");
  if (existsSync(join(projectDir, ".cursor")))
    hints.push("Cursor:       add to .cursor/mcp.json → mcpServers");
  if (existsSync(join(projectDir, ".junie")))
    hints.push("JetBrains:    add to .junie/mcp.json → mcpServers");
  if (existsSync(join(projectDir, ".windsurf"))) {
    hints.push("Windsurf:     add to ~/.codeium/windsurf/mcp_config.json → mcpServers");
    hints.push("Windsurf (JB): add to ~/.codeium/mcp_config.json → mcpServers");
  }
  if (existsSync(join(projectDir, ".github")) || existsSync(join(projectDir, ".vscode")))
    hints.push("GitHub Copilot: add to .vscode/mcp.json → servers");
  if (hints.length === 0)
    hints.push("Add to your agent's MCP config under mcpServers:");
  return hints;
}

/**
 * Ask a yes/no question. `defaultYes` controls what Enter (or any unrecognized
 * answer) means — it must match the prompt's [Y/n]/[y/N] convention. Destructive
 * prompts MUST use defaultYes=false: only an explicit y/yes proceeds.
 */
export function confirm(question: string, defaultYes = false): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") return res(true);
      if (a === "n" || a === "no") return res(false);
      res(defaultYes);
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
