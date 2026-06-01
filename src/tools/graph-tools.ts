import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve, relative } from "path";
import { generateProjectMap } from "../graph/resolver";
import type { CallableCandidate } from "../db/graph";
import {
  resolveSymbol,
  impactWalk,
  tracePath,
  collectTests,
  renderImpact,
  renderTrace,
  impactToJson,
  traceToJson,
  type SymbolResolution,
} from "../graph/trace";
import { type GetDB, resolveProject } from "./index";

function textResult(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function formatAmbiguous(symbol: string, cands: CallableCandidate[], projectDir: string): string {
  const lines = [`"${symbol}" is defined in ${cands.length} places — pass a file to pick one:`];
  for (const c of cands.slice(0, 15)) {
    const ln = c.startLine != null ? `:${c.startLine}` : "";
    lines.push(`  ${relative(projectDir, c.filePath)}${ln}  (${c.isExport ? "exported" : "local"})`);
  }
  if (cands.length > 15) lines.push(`  … +${cands.length - 15} more`);
  return lines.join("\n");
}

function resolveError(
  role: string,
  name: string,
  file: string | undefined,
  res: SymbolResolution,
  projectDir: string,
): string {
  if (res.status === "ambiguous") return formatAmbiguous(name, res.candidates!, projectDir);
  return `No callable named "${name}"${file ? ` in ${file}` : ""} found for \`${role}\`. impact/trace track functions and methods, not classes/constants/types.`;
}

export function registerGraphTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "project_map",
    "Visualize how files relate to each other — imports, exports, and fan-in/fan-out. Faster than reading import statements across many files. Use 'focus' to zoom into a specific file's neighborhood. Use format 'json' for structured data with fan-in/fan-out metrics. Use search or read_relevant next to explore specific areas of the map.",
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
      format: z
        .enum(["text", "json"])
        .optional()
        .describe("Output format: 'text' (default) for readable output, 'json' for structured data with fan-in/fan-out metrics and all exports."),
    },
    async ({ directory, focus, zoom, format }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const map = generateProjectMap(ragDb, {
        projectDir,
        focus,
        zoom: zoom ?? "file",
        format: format ?? "text",
      });

      if (format === "json") {
        return {
          content: [{ type: "text" as const, text: map }],
        };
      }

      const footer = `\n── Tip: call search("<topic>") to find files related to a specific area, or depends_on/depended_on_by for a single file's connections. ──`;

      return {
        content: [{ type: "text" as const, text: `${map}${footer}` }],
      };
    }
  );

  server.tool(
    "find_usages",
    "Find every call site or reference to a symbol across all indexed files — with file paths, line numbers, and matching lines. More reliable than grep for usage analysis: searches the chunk index so it won't miss aliased imports or re-exports. Use this before renaming or changing a function signature.",
    {
      symbol: z.string().min(1).max(200).describe("Symbol name to search for"),
      exact: z
        .boolean()
        .optional()
        .describe("Require exact word-boundary match (default: true). Set false for prefix/substring matching."),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      top: z.number().int().min(1).optional().describe("Max results to return (default: 30)"),
    },
    async ({ symbol, exact, directory, top }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

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

      const footer = `── Tip: call depended_on_by("<file>") on any file above to see its full importer tree. ──`;
      lines.push(footer);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  server.tool(
    "depends_on",
    "List all files that a given file imports (its dependencies). Shows the resolved import graph — what this file actually depends on. Use depended_on_by for the reverse direction.",
    {
      file: z.string().describe("File path (relative to project) to query"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ file, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const absPath = resolve(projectDir, file);
      const fileRecord = ragDb.getFileByPath(absPath);
      if (!fileRecord) {
        return { content: [{ type: "text" as const, text: `File "${file}" not found in index.` }] };
      }

      const deps = ragDb.getDependsOn(fileRecord.id);
      if (deps.length === 0) {
        return { content: [{ type: "text" as const, text: `${file} has no indexed dependencies.` }] };
      }

      const lines = [`${file} depends on ${deps.length} file${deps.length !== 1 ? "s" : ""}:\n`];
      for (const dep of deps) {
        lines.push(`  ${relative(projectDir, dep.path)}  (import: ${dep.source})`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "depended_on_by",
    "List all files that import a given file (reverse dependencies). Shows the blast radius before modifying a file — every file that would be affected by a change. Use find_usages for symbol-level granularity.",
    {
      file: z.string().describe("File path (relative to project) to query"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ file, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const absPath = resolve(projectDir, file);
      const fileRecord = ragDb.getFileByPath(absPath);
      if (!fileRecord) {
        return { content: [{ type: "text" as const, text: `File "${file}" not found in index.` }] };
      }

      const importers = ragDb.getDependedOnBy(fileRecord.id);
      if (importers.length === 0) {
        return { content: [{ type: "text" as const, text: `No files import ${file}.` }] };
      }

      const lines = [`${file} is imported by ${importers.length} file${importers.length !== 1 ? "s" : ""}:\n`];
      for (const imp of importers) {
        lines.push(`  ${relative(projectDir, imp.path)}  (import: ${imp.source})`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "impact",
    "Symbol-level blast radius: the transitive callers of a function or method as a pruned call tree, plus the test files to run for the change. More precise than depended_on_by (which is file-level). Use before changing a signature or behavior. Pass 'file' to disambiguate a name defined in several places. Tracks functions and methods (not classes/constants).",
    {
      symbol: z.string().min(1).max(200).describe("Function or method name to analyze"),
      file: z
        .string()
        .optional()
        .describe("File path (relative) to disambiguate when the name is defined in multiple places"),
      depth: z.number().int().min(1).max(6).optional().describe("Caller levels to walk (default 3)"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      format: z.enum(["text", "json"]).optional().describe("Output format: 'text' (default) or 'json'"),
    },
    async ({ symbol, file, depth, directory, format }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const resolution = resolveSymbol(ragDb, symbol, file);
      if (resolution.status === "not_found") {
        return textResult(
          `No callable named "${symbol}"${file ? ` in ${file}` : ""} found in the index. It may be a class/constant/type (impact tracks functions and methods), live in an excluded path, or not be indexed yet.`,
        );
      }
      if (resolution.status === "ambiguous") {
        return textResult(formatAmbiguous(symbol, resolution.candidates!, projectDir));
      }

      const root = resolution.node!;
      const res = impactWalk(ragDb, root, { maxDepth: depth ?? 3 });
      const tests = collectTests(ragDb, root, projectDir);

      if (format === "json") {
        return textResult(JSON.stringify(impactToJson(res, tests, projectDir), null, 2));
      }
      return textResult(renderImpact(res, projectDir, tests));
    }
  );

  server.tool(
    "trace",
    "Show how one symbol reaches another: the reachable call sub-graph from 'from' to 'to', with the shortest path highlighted. Answers 'how does X reach Y'. Branches that don't reach 'to' are pruned. Static resolution — a dynamic-dispatch hop (callback, interface→impl, DI) can break the chain, and is reported when it does. Pass 'from_file'/'to_file' to disambiguate.",
    {
      from: z.string().min(1).max(200).describe("Source symbol (function/method) the path starts at"),
      to: z.string().min(1).max(200).describe("Target symbol the path should reach"),
      from_file: z.string().optional().describe("File path (relative) to disambiguate 'from'"),
      to_file: z.string().optional().describe("File path (relative) to disambiguate 'to'"),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Max hops to search in each direction (default 6)"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      format: z.enum(["text", "json"]).optional().describe("Output format: 'text' (default) or 'json'"),
    },
    async ({ from, to, from_file, to_file, max_depth, directory, format }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const fromRes = resolveSymbol(ragDb, from, from_file);
      if (fromRes.status !== "ok") {
        return textResult(resolveError("from", from, from_file, fromRes, projectDir));
      }
      const toRes = resolveSymbol(ragDb, to, to_file);
      if (toRes.status !== "ok") {
        return textResult(resolveError("to", to, to_file, toRes, projectDir));
      }

      const res = tracePath(ragDb, fromRes.node!, toRes.node!, { maxDepth: max_depth ?? 6 });
      if (format === "json") {
        return textResult(JSON.stringify(traceToJson(res, projectDir), null, 2));
      }
      return textResult(renderTrace(res, projectDir));
    }
  );
}
