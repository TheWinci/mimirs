#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RagDB } from "./db";
import { loadConfig } from "./config";
import { indexDirectory } from "./indexer";
import { search } from "./search";
import { startWatcher } from "./watcher";
import { generateMermaid } from "./graph";
import { resolve } from "path";

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
          `${r.score.toFixed(4)}  ${r.path}\n  ${r.snippets[0]?.slice(0, 150)}...`
      )
      .join("\n\n");

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

// Auto-index on startup + start file watcher
const startupDir = process.env.RAG_PROJECT_DIR || process.cwd();
const startupDb = getDB(startupDir);
const startupConfig = await loadConfig(startupDir);

let watcher: import("fs").FSWatcher | null = null;

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

// Graceful shutdown
function cleanup() {
  process.stderr.write("[local-rag] Shutting down...\n");
  if (watcher) watcher.close();
  if (db) db.close();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
