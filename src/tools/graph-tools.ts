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
  directCallees,
  affectedTests,
  renderImpact,
  renderTrace,
  impactToJson,
  traceToJson,
  type SymbolResolution,
} from "../graph/trace";
import { findGitRoot, runGit } from "../git/exec";
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
    "Visualize how files relate to each other — imports, exports, and fan-in/fan-out. Faster than reading import statements across many files. Use 'focus' to zoom into a specific file's neighborhood. Use format 'json' for structured data with fan-in/fan-out metrics. Use search or read_relevant next to explore specific areas of the map. Routing — for ONE file's direct connections use depends_on/dependents; for a SYMBOL's callers use usages/impact.",
    {
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      focus: z
        .string()
        .optional()
        .describe("File path (relative to project) to focus on — shows only nearby files"),
      hops: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Neighborhood radius (in import hops) around 'focus' (default 2). Ignored without 'focus'."),
      zoom: z
        .enum(["file", "directory"])
        .optional()
        .describe("Zoom level: 'file' (default) or 'directory' for large projects"),
      format: z
        .enum(["text", "json"])
        .optional()
        .describe("Output format: 'text' (default) for readable output, 'json' for structured data with fan-in/fan-out metrics and all exports."),
    },
    async ({ directory, focus, hops, zoom, format }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const map = generateProjectMap(ragDb, {
        projectDir,
        focus,
        maxHops: hops,
        zoom: zoom ?? "file",
        format: format ?? "text",
      });

      if (format === "json") {
        return {
          content: [{ type: "text" as const, text: map }],
        };
      }

      const footer = `\n── Tip: call search("<topic>") to find files related to a specific area, or depends_on/dependents for a single file's connections. ──`;

      return {
        content: [{ type: "text" as const, text: `${map}${footer}` }],
      };
    }
  );

  server.tool(
    "usages",
    "Find call sites and references to a symbol across indexed files — with file paths, line numbers, and matching lines. Resolves aliased imports: searching the original name finds call sites that import it under an alias (`import { getDB as g }; g()`). Primary matches come from an AST-derived reference index (real call/reference sites); for file types without reference extraction (e.g. HTML/CSS/YAML) or names not in that index it falls back to a text search, which can also surface matches inside comments or strings. Use before renaming or changing a function signature. This is the SYMBOL-level, flat, 1-hop view. Routing — for the transitive caller TREE plus tests to run use impact; for FILE-level importers use dependents; for the path between two symbols use trace.",
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

      const limit = top ?? 30;
      // Fetch one past the limit so we can tell "exactly `limit`" from "more
      // exist" and say so — usages runs before renames where a hidden site breaks.
      const raw = ragDb.findUsages(symbol, exact ?? true, limit + 1);
      const truncated = raw.length > limit;
      const results = raw.slice(0, limit);

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
      // Truncation must be loud: usages is used before renames, where a hidden
      // call site breaks the build. Never present a capped set as complete.
      const countLabel = truncated
        ? `Showing the first ${results.length} usage${results.length !== 1 ? "s" : ""} of "${symbol}" (more exist — raise \`top\` past ${limit} to see all)`
        : `Found ${results.length} usage${results.length !== 1 ? "s" : ""} of "${symbol}" across ${fileCount} file${fileCount !== 1 ? "s" : ""}`;
      const lines: string[] = [`${countLabel}:\n`];

      for (const [path, usages] of byFile) {
        lines.push(path);
        for (const u of usages) {
          const lineStr = u.line != null ? `:${u.line}` : "";
          lines.push(`  ${lineStr}  ${u.snippet}`);
        }
        lines.push("");
      }

      const footer = `── Tip: call dependents("<file>") on any file above to see its full importer tree. ──`;
      lines.push(footer);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  server.tool(
    "depends_on",
    "List all files that a given file imports (its dependencies). Shows the resolved import graph — what this file actually depends on. This is FILE-level, outward direction. Routing — reverse (files that import this one) is dependents; for a single symbol's references use usages.",
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
    "dependents",
    "List all files that import a given file (reverse dependencies). Shows the blast radius before modifying a file — every file that would be affected by a change. This is FILE-level, inward direction. Routing — reverse (what this file imports) is depends_on; for finer SYMBOL-level blast radius use impact (transitive callers + tests) or usages (flat refs).",
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
    "Symbol-level blast radius: the transitive callers of a function or method as a pruned call tree, plus the test files to run for the change. More precise than dependents (which is file-level). Use before changing a signature or behavior. Pass 'file' to disambiguate a name defined in several places. Tracks functions and methods (not classes/constants). This is the SYMBOL-level, transitive (tree + tests) view. Routing — for a flat list of direct call sites use usages; for FILE-level blast radius use dependents; for how one specific symbol reaches this one use trace.",
    {
      symbol: z.string().min(1).max(200).describe("Function or method name to analyze"),
      file: z
        .string()
        .optional()
        .describe("File path (relative) to disambiguate when the name is defined in multiple places"),
      hops: z.number().int().min(1).optional().describe("Caller levels to walk in the displayed tree (default 3, no hard cap). The headline total-caller count stays complete regardless of this."),
      maxNodes: z.number().int().min(1).optional().describe("Max caller nodes to draw in the tree (default 80). Bounds output only — the total count is still honest."),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      format: z.enum(["text", "json"]).optional().describe("Output format: 'text' (default) or 'json'"),
    },
    async ({ symbol, file, hops, maxNodes, directory, format }) => {
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
      const res = impactWalk(ragDb, root, { maxDepth: hops ?? 3, budget: maxNodes ?? 80 });
      const tests = collectTests(ragDb, root, projectDir);

      if (format === "json") {
        return textResult(JSON.stringify(impactToJson(res, tests, projectDir), null, 2));
      }
      return textResult(renderImpact(res, projectDir, tests));
    }
  );

  server.tool(
    "trace",
    "Show how one symbol reaches another: the connecting call sub-graph from 'from' to 'to', with the shortest path highlighted. Answers 'how does X reach Y'. Reachability is COMPLETE — the whole reachable graph is searched (no hop limit), so a 'no path' result means truly unreachable, not 'too far'. Branches that don't reach 'to' are pruned; the DRAWN sub-graph is bounded by maxNodes (the connectivity answer is not). Static resolution — a dynamic-dispatch hop (callback, interface→impl, DI) can break the chain, and is reported when it does. Pass 'from_file'/'to_file' to disambiguate. This is the SYMBOL-to-symbol PATH view (two endpoints). Routing — for ALL callers of a single symbol use impact; for all references to a symbol use usages.",
    {
      from: z.string().min(1).max(200).describe("Source symbol (function/method) the path starts at"),
      to: z.string().min(1).max(200).describe("Target symbol the path should reach"),
      from_file: z.string().optional().describe("File path (relative) to disambiguate 'from'"),
      to_file: z.string().optional().describe("File path (relative) to disambiguate 'to'"),
      maxNodes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max nodes to DRAW in the connecting sub-graph (default 300). Does not limit reachability — a path is always found if one exists."),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      format: z.enum(["text", "json"]).optional().describe("Output format: 'text' (default) or 'json'"),
    },
    async ({ from, to, from_file, to_file, maxNodes, directory, format }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const fromRes = resolveSymbol(ragDb, from, from_file);
      if (fromRes.status !== "ok") {
        return textResult(resolveError("from", from, from_file, fromRes, projectDir));
      }
      const toRes = resolveSymbol(ragDb, to, to_file);
      if (toRes.status !== "ok") {
        return textResult(resolveError("to", to, to_file, toRes, projectDir));
      }

      const res = tracePath(ragDb, fromRes.node!, toRes.node!, { budget: maxNodes ?? 300 });
      if (format === "json") {
        return textResult(JSON.stringify(traceToJson(res, projectDir), null, 2));
      }
      return textResult(renderTrace(res, projectDir));
    }
  );

  server.tool(
    "callees",
    "List the functions/methods a symbol directly calls (one hop out), each resolved to its definition file:line. The forward complement of usages (callers, one hop in) — use it to see what a function depends on before editing it. Static resolution: dynamic dispatch (callbacks, interface→impl, DI) and calls into unindexed code won't appear. Pass 'file' to disambiguate a name defined in several places. Routing — reverse (who calls this) is usages (flat) or impact (transitive + tests); for FILE-level imports use depends_on; for the path between two symbols use trace.",
    {
      symbol: z.string().min(1).max(200).describe("Function or method name whose callees to list"),
      file: z
        .string()
        .optional()
        .describe("File path (relative) to disambiguate when the name is defined in multiple places"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ symbol, file, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const resolution = resolveSymbol(ragDb, symbol, file);
      if (resolution.status !== "ok") {
        return textResult(resolveError("symbol", symbol, file, resolution, projectDir));
      }

      const callees = directCallees(ragDb, resolution.node!);
      if (callees.length === 0) {
        return textResult(
          `"${symbol}" calls nothing resolvable — it's a leaf, or its calls are dynamic / into unindexed code.`,
        );
      }

      const lines = [`"${symbol}" directly calls ${callees.length} symbol${callees.length !== 1 ? "s" : ""}:\n`];
      for (const c of callees) {
        const ln = c.startLine != null ? `:${c.startLine}` : "";
        lines.push(`  ${c.name}  ${relative(projectDir, c.filePath)}${ln}`);
      }
      lines.push(`\n── Tip: call impact("${symbol}") for who calls it, or read_relevant("${symbol}") for its body. ──`);
      return textResult(lines.join("\n"));
    }
  );

  server.tool(
    "affected",
    "Given changed files (or the working-tree diff against HEAD by default), report the test files that transitively import them — what to run for this change. The interactive counterpart of the `affected` CLI; pair with impact for symbol-level blast radius. Returns changed (indexed) files, the tests to run, and any changed files not in the index.",
    {
      files: z
        .array(z.string())
        .optional()
        .describe("Changed file paths (relative to project). Omit to use the git working-tree diff against HEAD."),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ files, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      let changedAbs: string[];
      if (files && files.length > 0) {
        changedAbs = files.map((f) => resolve(projectDir, f));
      } else {
        const gitRoot = await findGitRoot(projectDir);
        if (!gitRoot) {
          return textResult("No files given and not a git repository. Pass `files`, or run inside a git repo.");
        }
        const out = await runGit(["diff", "--name-only", "HEAD"], gitRoot);
        const changed = (out ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        if (changed.length === 0) {
          return textResult("No changed files (git diff against HEAD is empty).");
        }
        changedAbs = changed.map((f) => resolve(gitRoot, f));
      }

      const res = affectedTests(ragDb, changedAbs, projectDir);
      const sections: string[] = [];
      sections.push(`Changed (indexed): ${res.changed.length > 0 ? res.changed.join(", ") : "none"}`);
      if (res.unknown.length > 0) {
        sections.push(`Not indexed (ignored): ${res.unknown.join(", ")}`);
      }
      sections.push(
        res.tests.length > 0
          ? `Tests to run (${res.tests.length}):\n` + res.tests.map((t) => `  ${t}`).join("\n")
          : "Tests to run: none found (nothing indexed transitively imports the changed files).",
      );
      return textResult(sections.join("\n\n"));
    }
  );
}
