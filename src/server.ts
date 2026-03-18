#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RagDB } from "./db";
import { loadConfig } from "./config";
import { indexDirectory } from "./indexer";
import { search, searchChunks } from "./search";
import { startWatcher, type Watcher } from "./watcher";
import { generateMermaid } from "./graph";
import { embed } from "./embed";
import { discoverSessions } from "./conversation";
import { indexConversation, startConversationTail } from "./conversation-index";
import { resolve } from "path";
import { homedir } from "os";

const server = new McpServer({
  name: "local-rag",
  version: "0.1.0",
});

// Lazy-init DB per project directory
let db: RagDB | null = null;
let currentProjectDir: string | null = null;

function getDB(projectDir: string): RagDB {
  const resolved = resolve(projectDir);
  if (db && currentProjectDir === resolved) return db;
  if (db) db.close();
  db = new RagDB(resolved);
  currentProjectDir = resolved;
  return db;
}

server.tool(
  "search",
  "Semantic search over indexed files. Returns ranked file paths with relevance scores and snippets.",
  {
    query: z.string().describe("The search query (natural language)"),
    directory: z
      .string()
      .optional()
      .describe(
        "Project directory to search. Defaults to RAG_PROJECT_DIR env or cwd"
      ),
    top: z
      .number()
      .optional()
      .describe("Number of results to return (default: from config or 5)"),
  },
  async ({ query, directory, top }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);
    const config = await loadConfig(projectDir);

    const results = await search(query, ragDb, top ?? config.searchTopK, 0, config.hybridWeight);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No results found. Has the directory been indexed? Try calling index_files first.",
          },
        ],
      };
    }

    const text = results
      .map(
        (r) =>
          `${r.score.toFixed(4)}  ${r.path}\n  ${r.snippets[0]?.slice(0, 400)}...`
      )
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

server.tool(
  "read_relevant",
  "Retrieve the most relevant semantic chunks for a query. Returns full chunk content — individual functions, classes, or sections — ranked by relevance. No file deduplication: multiple chunks from the same file can appear. Use this instead of search + Read when you need the actual content.",
  {
    query: z.string().describe("The search query (natural language)"),
    directory: z
      .string()
      .optional()
      .describe(
        "Project directory to search. Defaults to RAG_PROJECT_DIR env or cwd"
      ),
    top: z
      .number()
      .optional()
      .describe("Max chunks to return (default: 8)"),
    threshold: z
      .number()
      .optional()
      .describe("Min relevance score to include (default: 0.3)"),
  },
  async ({ query, directory, top, threshold }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);
    const config = await loadConfig(projectDir);

    const results = await searchChunks(
      query,
      ragDb,
      top ?? 8,
      threshold ?? 0.3,
      config.hybridWeight
    );

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No relevant chunks found. Has the directory been indexed? Try calling index_files first.",
          },
        ],
      };
    }

    const text = results
      .map((r) => {
        const lineRange = r.startLine != null && r.endLine != null ? `:${r.startLine}-${r.endLine}` : "";
        const entity = r.entityName ? `  •  ${r.entityName}` : "";
        return `[${r.score.toFixed(2)}] ${r.path}${lineRange}${entity}\n${r.content}`;
      })
      .join("\n\n---\n\n");

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

server.tool(
  "index_files",
  "Index files in a directory for semantic search. Skips unchanged files and prunes deleted ones.",
  {
    directory: z
      .string()
      .optional()
      .describe(
        "Directory to index. Defaults to RAG_PROJECT_DIR env or cwd"
      ),
    patterns: z
      .array(z.string())
      .optional()
      .describe(
        "Override include patterns (e.g. ['**/*.md', '**/*.ts']). Uses .rag/config.json if not provided"
      ),
  },
  async ({ directory, patterns }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);
    const config = await loadConfig(projectDir);

    if (patterns) {
      config.include = patterns;
    }

    const result = await indexDirectory(projectDir, ragDb, config);

    return {
      content: [
        {
          type: "text" as const,
          text: `Indexing complete:\n  Indexed: ${result.indexed}\n  Skipped (unchanged): ${result.skipped}\n  Pruned (deleted): ${result.pruned}${result.errors.length > 0 ? `\n  Errors: ${result.errors.join("; ")}` : ""}`,
        },
      ],
    };
  }
);

server.tool(
  "index_status",
  "Show the current state of the RAG index for a project directory.",
  {
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
  },
  async ({ directory }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);
    const status = ragDb.getStatus();

    return {
      content: [
        {
          type: "text" as const,
          text: `Index status:\n  Files: ${status.totalFiles}\n  Chunks: ${status.totalChunks}\n  Last indexed: ${status.lastIndexed || "never"}`,
        },
      ],
    };
  }
);

server.tool(
  "remove_file",
  "Remove a specific file from the RAG index.",
  {
    path: z.string().describe("Absolute path of the file to remove"),
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
  },
  async ({ path, directory }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);
    const removed = ragDb.removeFile(path);

    return {
      content: [
        {
          type: "text" as const,
          text: removed
            ? `Removed ${path} from index`
            : `${path} was not in the index`,
        },
      ],
    };
  }
);

server.tool(
  "search_analytics",
  "Show search usage analytics: query counts, zero-result queries, low-relevance queries, top searched terms.",
  {
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    days: z
      .number()
      .optional()
      .default(30)
      .describe("Number of days to look back (default: 30)"),
  },
  async ({ directory, days }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);
    const analytics = ragDb.getAnalytics(days);

    const lines: string[] = [
      `Search analytics (last ${days} days):`,
      `  Total queries:    ${analytics.totalQueries}`,
      `  Avg results:      ${analytics.avgResultCount.toFixed(1)}`,
      `  Avg top score:    ${analytics.avgTopScore?.toFixed(2) ?? "n/a"}`,
      `  Zero-result rate: ${analytics.totalQueries > 0 ? ((analytics.zeroResultQueries.reduce((s, q) => s + q.count, 0) / analytics.totalQueries) * 100).toFixed(0) : 0}%`,
    ];

    if (analytics.topSearchedTerms.length > 0) {
      lines.push("", "Top searches:");
      for (const t of analytics.topSearchedTerms) {
        lines.push(`  - "${t.query}" (${t.count}×)`);
      }
    }

    if (analytics.zeroResultQueries.length > 0) {
      lines.push("", "Zero-result queries (consider indexing these topics):");
      for (const q of analytics.zeroResultQueries) {
        lines.push(`  - "${q.query}" (${q.count}×)`);
      }
    }

    if (analytics.lowScoreQueries.length > 0) {
      lines.push("", "Low-relevance queries (top score < 0.3):");
      for (const q of analytics.lowScoreQueries) {
        lines.push(`  - "${q.query}" (score: ${q.topScore.toFixed(2)})`);
      }
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

server.tool(
  "project_map",
  "Generate a Mermaid dependency graph of the project. Shows file relationships, exports, and entry points.",
  {
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    focus: z
      .string()
      .optional()
      .describe("File path (relative to project) to focus on — shows only nearby files"),
    zoom: z
      .enum(["file", "directory"])
      .optional()
      .describe("Zoom level: 'file' (default) or 'directory' for large projects"),
    maxNodes: z
      .number()
      .optional()
      .describe("Max nodes in graph (default: 50, auto-switches to directory view if exceeded)"),
  },
  async ({ directory, focus, zoom, maxNodes }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);

    const mermaid = generateMermaid(ragDb, {
      projectDir,
      focus,
      zoom: zoom ?? "file",
      maxNodes: maxNodes ?? 50,
    });

    return {
      content: [{ type: "text" as const, text: mermaid }],
    };
  }
);

server.tool(
  "search_conversation",
  "Search through conversation history. Finds past decisions, discussions, and tool outputs from current or previous sessions.",
  {
    query: z.string().describe("What to search for in conversation history"),
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    sessionId: z
      .string()
      .optional()
      .describe("Limit search to a specific session ID. Omit to search all sessions."),
    top: z
      .number()
      .optional()
      .default(5)
      .describe("Number of results to return (default: 5)"),
  },
  async ({ query, directory, sessionId, top }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);
    const config = await loadConfig(projectDir);

    // Hybrid search: vector + BM25
    const queryEmb = await embed(query);
    const vecResults = ragDb.searchConversation(queryEmb, top, sessionId);

    let bm25Results: typeof vecResults = [];
    try {
      bm25Results = ragDb.textSearchConversation(query, top, sessionId);
    } catch {
      // FTS can fail on special characters
    }

    // Merge and deduplicate by turnId
    const merged = new Map<number, (typeof vecResults)[0]>();
    const hybridWeight = config.hybridWeight;

    for (const r of vecResults) {
      merged.set(r.turnId, { ...r, score: r.score * hybridWeight });
    }
    for (const r of bm25Results) {
      const existing = merged.get(r.turnId);
      if (existing) {
        existing.score += r.score * (1 - hybridWeight);
      } else {
        merged.set(r.turnId, { ...r, score: r.score * (1 - hybridWeight) });
      }
    }

    const results = [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, top);

    if (results.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No conversation results found. The conversation may not be indexed yet.",
        }],
      };
    }

    const text = results
      .map((r) => {
        const tools = r.toolsUsed.length > 0 ? ` [${r.toolsUsed.join(", ")}]` : "";
        const files = r.filesReferenced.length > 0
          ? `\n  Files: ${r.filesReferenced.slice(0, 5).join(", ")}`
          : "";
        return `Turn ${r.turnIndex} (${r.timestamp})${tools}\n  ${r.snippet.slice(0, 200)}...${files}`;
      })
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

server.tool(
  "create_checkpoint",
  "Create a named checkpoint marking an important moment. Call this liberally: after completing any feature or task, after adding or modifying tools, after key technical decisions, before and after large refactors, when hitting a blocker, or when changing direction. Checkpoints are the only way future sessions can know what was done and why — if in doubt, create one.",
  {
    type: z
      .enum(["decision", "milestone", "blocker", "direction_change", "handoff"])
      .describe("Type of checkpoint"),
    title: z.string().describe("Short label, e.g. 'Chose JWT over session cookies'"),
    summary: z
      .string()
      .describe("2-3 sentence description of what happened and why"),
    filesInvolved: z
      .array(z.string())
      .optional()
      .describe("Files relevant to this checkpoint"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Freeform tags for filtering"),
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
  },
  async ({ type, title, summary, filesInvolved, tags, directory }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);

    // Get current session's latest turn index
    const sessions = discoverSessions(projectDir);
    const sessionId = sessions.length > 0 ? sessions[0].sessionId : "unknown";

    // Determine turn index from DB
    const turnCount = ragDb.getTurnCount(sessionId);
    const turnIndex = Math.max(0, turnCount - 1);

    // Embed title + summary for semantic search
    const embText = `${title}. ${summary}`;
    const embedding = await embed(embText);

    const id = ragDb.createCheckpoint(
      sessionId,
      turnIndex,
      new Date().toISOString(),
      type,
      title,
      summary,
      filesInvolved ?? [],
      tags ?? [],
      embedding
    );

    return {
      content: [{
        type: "text" as const,
        text: `Checkpoint #${id} created: [${type}] ${title}`,
      }],
    };
  }
);

server.tool(
  "list_checkpoints",
  "List conversation checkpoints, most recent first. Cross-session by default.",
  {
    sessionId: z.string().optional().describe("Limit to a specific session ID"),
    type: z
      .enum(["decision", "milestone", "blocker", "direction_change", "handoff"])
      .optional()
      .describe("Filter by checkpoint type"),
    limit: z.number().optional().default(20).describe("Max results (default: 20)"),
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
  },
  async ({ sessionId, type, limit, directory }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);

    const checkpoints = ragDb.listCheckpoints(sessionId, type, limit);

    if (checkpoints.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No checkpoints found." }],
      };
    }

    const text = checkpoints
      .map((cp) => {
        const files = cp.filesInvolved.length > 0
          ? `\n  Files: ${cp.filesInvolved.join(", ")}`
          : "";
        const tagStr = cp.tags.length > 0 ? ` [${cp.tags.join(", ")}]` : "";
        return `#${cp.id} [${cp.type}] ${cp.title}${tagStr}\n  ${cp.timestamp} (turn ${cp.turnIndex})\n  ${cp.summary}${files}`;
      })
      .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "search_checkpoints",
  "Semantic search over checkpoint titles and summaries.",
  {
    query: z.string().describe("What to search for in checkpoints"),
    type: z
      .enum(["decision", "milestone", "blocker", "direction_change", "handoff"])
      .optional()
      .describe("Filter by checkpoint type"),
    limit: z.number().optional().default(5).describe("Max results (default: 5)"),
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
  },
  async ({ query, type, limit, directory }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);

    const queryEmb = await embed(query);
    const results = ragDb.searchCheckpoints(queryEmb, limit, type);

    if (results.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No matching checkpoints found." }],
      };
    }

    const text = results
      .map((cp) => {
        const files = cp.filesInvolved.length > 0
          ? `\n  Files: ${cp.filesInvolved.join(", ")}`
          : "";
        return `${cp.score.toFixed(4)}  #${cp.id} [${cp.type}] ${cp.title}\n  ${cp.summary}${files}`;
      })
      .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "search_symbols",
  "Search for exported symbols by name — functions, classes, types, interfaces, enums. Returns the files that export matching symbols with the defining code snippet. Faster than semantic search when you know the symbol name.",
  {
    symbol: z.string().describe("Symbol name to search for"),
    exact: z
      .boolean()
      .optional()
      .describe("Require exact match (case-insensitive). Default: false (substring match)"),
    type: z
      .enum(["function", "class", "interface", "type", "enum", "export"])
      .optional()
      .describe("Filter by symbol type"),
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    top: z.number().optional().describe("Max results (default: 20)"),
  },
  async ({ symbol, exact, type, directory, top }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);

    const results = ragDb.searchSymbols(symbol, exact ?? false, type, top ?? 20);

    if (results.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No exported symbols matching "${symbol}" found.` }],
      };
    }

    const text = results
      .map((r) => {
        const snippet = r.snippet ? `\n${r.snippet.slice(0, 300)}` : "";
        return `${r.path}  •  ${r.symbolName} (${r.symbolType})${snippet}`;
      })
      .join("\n\n---\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "write_relevant",
  "Find the best location to insert new content. Given code or documentation you want to add, returns the most semantically appropriate files and insertion points — the chunk after which your content belongs, with an anchor for precise placement.",
  {
    content: z.string().describe("The content you want to add — a function, class, doc section, etc."),
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    top: z
      .number()
      .optional()
      .describe("Number of candidate locations to return (default: 3)"),
    threshold: z
      .number()
      .optional()
      .describe("Min relevance score (default: 0.3)"),
  },
  async ({ content, directory, top, threshold }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);
    const config = await loadConfig(projectDir);

    const topN = top ?? 3;
    const chunks = await searchChunks(
      content,
      ragDb,
      topN * 3,
      threshold ?? 0.3,
      config.hybridWeight
    );

    if (chunks.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No relevant location found. The index may be empty — try index_files first." }],
      };
    }

    // Best-scoring chunk per file, up to topN
    const byFile = new Map<string, (typeof chunks)[0]>();
    for (const r of chunks) {
      const existing = byFile.get(r.path);
      if (!existing || r.score > existing.score) {
        byFile.set(r.path, r);
      }
    }

    const candidates = [...byFile.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);

    const text = candidates
      .map((r) => {
        const insertAfter = r.entityName
          ? `after \`${r.entityName}\` (chunk ${r.chunkIndex})`
          : `after chunk ${r.chunkIndex}`;
        const anchor = r.content.slice(-150).trim();
        return `[${r.score.toFixed(2)}] ${r.path}\n  Insert ${insertAfter}\n  Anchor: ...${anchor}`;
      })
      .join("\n\n---\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "find_usages",
  "Find every usage (call site or reference) of a symbol across the codebase. Returns file paths, line numbers, and the matching line. Excludes the file that defines the symbol. Use this before renaming or changing a function signature to understand the blast radius.",
  {
    symbol: z.string().describe("Symbol name to search for"),
    exact: z
      .boolean()
      .optional()
      .describe("Require exact word-boundary match (default: true). Set false for prefix/substring matching."),
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    top: z.number().optional().describe("Max results to return (default: 30)"),
  },
  async ({ symbol, exact, directory, top }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);

    const results = ragDb.findUsages(symbol, exact ?? true, top ?? 30);

    if (results.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No usages of "${symbol}" found. The symbol may only appear in its definition file, or the index may need re-running.` }],
      };
    }

    // Group by file
    const byFile = new Map<string, { line: number | null; snippet: string }[]>();
    for (const r of results) {
      if (!byFile.has(r.path)) byFile.set(r.path, []);
      byFile.get(r.path)!.push({ line: r.line, snippet: r.snippet });
    }

    const fileCount = byFile.size;
    const lines: string[] = [
      `Found ${results.length} usage${results.length !== 1 ? "s" : ""} of "${symbol}" across ${fileCount} file${fileCount !== 1 ? "s" : ""}:\n`,
    ];

    for (const [path, usages] of byFile) {
      lines.push(path);
      for (const u of usages) {
        const lineStr = u.line != null ? `:${u.line}` : "";
        lines.push(`  ${lineStr}  ${u.snippet}`);
      }
      lines.push("");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// Git helpers for git_context tool

async function runGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}

async function findGitRoot(dir: string): Promise<string | null> {
  return runGit(["rev-parse", "--show-toplevel"], dir);
}

server.tool(
  "git_context",
  "Show git context for the working tree: uncommitted changes annotated with index status, recent commits, and changed files. Use this at the start of a session to understand what has already been modified before searching or editing.",
  {
    since: z
      .string()
      .optional()
      .describe("Commit ref, branch, or ISO date to look back to (default: HEAD~5)"),
    include_diff: z
      .boolean()
      .optional()
      .describe("Include full unified diff of uncommitted changes, truncated to 200 lines (default: false)"),
    files_only: z
      .boolean()
      .optional()
      .describe("Return file paths only — omit commit messages and diff body (default: false)"),
    directory: z
      .string()
      .optional()
      .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
  },
  async ({ since, include_diff, files_only, directory }) => {
    const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
    const ragDb = getDB(projectDir);

    const gitRoot = await findGitRoot(resolve(projectDir));
    if (!gitRoot) {
      return { content: [{ type: "text" as const, text: "Not a git repository." }] };
    }

    const sinceRef = since ?? "HEAD~5";
    const sections: string[] = [];

    // 1. Uncommitted changes
    const statusOutput = await runGit(["status", "--short"], gitRoot);
    if (statusOutput) {
      const statusLines = statusOutput.split("\n").filter(Boolean);
      if (statusLines.length > 0) {
        const annotated = statusLines.map((line) => {
          // git status --short: XY <space> filepath (or -> for renames)
          const filePart = line.slice(3).trim();
          const filePath = filePart.includes(" -> ") ? filePart.split(" -> ")[1] : filePart;
          const absPath = resolve(gitRoot, filePath);
          const tag = ragDb.getFileByPath(absPath) != null ? "[indexed]" : "[not indexed]";
          return files_only ? `${filePath}  ${tag}` : `${line}  ${tag}`;
        });
        sections.push("## Uncommitted changes\n" + annotated.join("\n"));
      }
    }

    // 2. Recent commits (omit body when files_only)
    if (!files_only) {
      const logOutput = await runGit(["log", "--oneline", `${sinceRef}..HEAD`], gitRoot);
      if (logOutput) {
        sections.push(`## Recent commits (since ${sinceRef})\n` + logOutput);
      }
    }

    // 3. Changed files since sinceRef
    const diffFilesOutput = await runGit(["diff", "--name-only", `${sinceRef}..HEAD`], gitRoot);
    if (diffFilesOutput) {
      sections.push(`## Changed files (since ${sinceRef})\n` + diffFilesOutput);
    }

    // 4. Diff (opt-in, truncated to 200 lines)
    if (include_diff && !files_only) {
      const diffOutput = await runGit(["diff", "HEAD"], gitRoot);
      if (diffOutput) {
        const diffLines = diffOutput.split("\n");
        const truncated = diffLines.length > 200;
        const body = diffLines.slice(0, 200).join("\n");
        sections.push("## Diff\n" + body + (truncated ? "\n[truncated]" : ""));
      }
    }

    const text =
      sections.length > 0
        ? sections.join("\n\n")
        : "Nothing to report (clean working tree, no recent commits in range).";

    return { content: [{ type: "text" as const, text }] };
  }
);

// Auto-index on startup + start file watcher
const startupDir = process.env.RAG_PROJECT_DIR || process.cwd();

const isHomeDirTrap = resolve(startupDir) === homedir();
if (isHomeDirTrap) {
  process.stderr.write(
    `[local-rag] WARNING: project directory is your home folder (${startupDir}).\n` +
    `[local-rag] Skipping auto-index and file watcher. Set RAG_PROJECT_DIR to your project path.\n` +
    `[local-rag] Example: "env": { "RAG_PROJECT_DIR": "/path/to/your/project" }\n`
  );
}
const startupDb = getDB(startupDir);
const startupConfig = await loadConfig(startupDir);

let watcher: Watcher | null = null;
let convWatcher: Watcher | null = null;

if (!isHomeDirTrap) {
  // Index in background — don't block server startup
  indexDirectory(startupDir, startupDb, startupConfig, (msg) => {
    process.stderr.write(`[local-rag] ${msg}\n`);
  }).then((result) => {
    process.stderr.write(
      `[local-rag] Startup index: ${result.indexed} indexed, ${result.skipped} skipped, ${result.pruned} pruned\n`
    );

    // Start watching after initial index completes
    watcher = startWatcher(startupDir, startupDb, startupConfig, (msg) => {
      process.stderr.write(`[local-rag] ${msg}\n`);
    });
  });
}

// Start conversation tailing — find and tail the current session's JSONL
const sessions = discoverSessions(startupDir);
if (sessions.length > 0) {
  // Tail the most recent session (likely the current one)
  const currentSession = sessions[0];
  process.stderr.write(`[local-rag] Indexing conversation: ${currentSession.sessionId.slice(0, 8)}...\n`);

  convWatcher = startConversationTail(
    currentSession.jsonlPath,
    currentSession.sessionId,
    startupDb,
    (msg) => process.stderr.write(`[local-rag] ${msg}\n`)
  );

  // Also index any older sessions that haven't been indexed yet
  for (const session of sessions.slice(1)) {
    const existing = startupDb.getSession(session.sessionId);
    if (!existing || existing.mtime < session.mtime) {
      indexConversation(
        session.jsonlPath,
        session.sessionId,
        startupDb
      ).then((result) => {
        if (result.turnsIndexed > 0) {
          process.stderr.write(
            `[local-rag] Indexed past session ${session.sessionId.slice(0, 8)}...: ${result.turnsIndexed} turns\n`
          );
        }
      }).catch(() => {
        // Non-critical — skip broken transcripts
      });
    }
  }
}

// Graceful shutdown
function cleanup() {
  process.stderr.write("[local-rag] Shutting down...\n");
  if (watcher) watcher.close();
  if (convWatcher) convWatcher.close();
  if (db) db.close();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGHUP", cleanup);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
