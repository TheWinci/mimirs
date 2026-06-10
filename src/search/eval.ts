import { readFile, writeFile } from "fs/promises";
import { resolve, basename } from "path";
import { RagDB } from "../db";
import { search, type DedupedResult } from "./hybrid";
import { loadConfig } from "../config";

export interface EvalTask {
  task: string;
  grading: string; // human-readable criteria for what a good answer looks like
  expectedFiles?: string[]; // optional: files the agent should reference
}

export interface EvalTrace {
  task: string;
  grading: string;
  condition: "with-rag" | "without-rag";
  searchResults: DedupedResult[];
  filesReferenced: string[];
  searchCount: number;
  durationMs: number;
}

export interface EvalSummary {
  totalTasks: number;
  withRag: {
    avgSearchResults: number;
    avgFilesReferenced: number;
    avgDurationMs: number;
    fileHitRate: number; // % of tasks where expected files were found
  };
  withoutRag: {
    avgSearchResults: number;
    avgFilesReferenced: number;
    avgDurationMs: number;
    fileHitRate: number;
  };
  traces: EvalTrace[];
}

export async function loadEvalTasks(path: string): Promise<EvalTask[]> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Eval file must be a JSON array of { task, grading } objects");
  }

  for (const entry of parsed) {
    if (!entry.task || !entry.grading) {
      throw new Error(`Invalid eval entry: ${JSON.stringify(entry)}. Each entry needs "task" (string) and "grading" (string)`);
    }
  }

  return parsed;
}

// Baseline arm: what an agent without RAG can do — guess files by matching
// task words against indexed file PATHS (the glob/filename heuristic). The old
// arm returned [] so its hit rate was always 0 and the A/B comparison could
// not fail; a comparison that can't lose measures nothing.
function filenameBaseline(taskText: string, db: RagDB, topK: number): DedupedResult[] {
  const words = taskText
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3);
  if (words.length === 0) return [];

  const scored: { path: string; score: number }[] = [];
  for (const f of db.getAllFilePaths()) {
    const p = f.path.toLowerCase();
    const matches = words.filter((w) => p.includes(w)).length;
    if (matches > 0) scored.push({ path: f.path, score: matches });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => ({ path: s.path, score: s.score, snippets: [] }));
}

/**
 * Simulate an agent's search behavior for a task.
 * "with-rag": runs semantic search on the task description and returns what was found.
 * "without-rag": filename-keyword baseline (what an agent can do with globbing alone).
 */
export async function runEvalTask(
  task: EvalTask,
  db: RagDB,
  projectDir: string,
  condition: "with-rag" | "without-rag",
  topK: number = 5
): Promise<EvalTrace> {
  const start = performance.now();
  let searchResults: DedupedResult[] = [];
  let searchCount = 0;

  if (condition === "with-rag") {
    const config = await loadConfig(projectDir);
    searchResults = await search(task.task, db, topK, 0, config.hybridWeight, config.generated);
    searchCount = 1;
  } else {
    searchResults = filenameBaseline(task.task, db, topK);
    searchCount = 1;
  }

  const durationMs = Math.round(performance.now() - start);
  const filesReferenced = searchResults.map((r) => r.path);

  return {
    task: task.task,
    grading: task.grading,
    condition,
    searchResults,
    filesReferenced,
    searchCount,
    durationMs,
  };
}

// True when `found` (absolute index path) refers to the same file as
// `expected` (eval-file path, usually project-relative). Boundary-aware:
// "src/ragdb.ts".endsWith("db.ts") used to count as a hit and inflate the
// headline fileHitRate.
function pathHit(found: string, expected: string, projectDir: string): boolean {
  const f = found.replaceAll("\\", "/");
  const absExpected = resolve(projectDir, expected).replaceAll("\\", "/");
  return f === absExpected || f === expected || f.endsWith("/" + expected.replace(/^\.\//, ""));
}

export async function runEval(
  tasks: EvalTask[],
  db: RagDB,
  projectDir: string,
  topK: number = 5
): Promise<EvalSummary> {
  const traces: EvalTrace[] = [];

  for (const task of tasks) {
    const withRag = await runEvalTask(task, db, projectDir, "with-rag", topK);
    const withoutRag = await runEvalTask(task, db, projectDir, "without-rag", topK);
    traces.push(withRag, withoutRag);
  }

  const withRagTraces = traces.filter((t) => t.condition === "with-rag");
  const withoutRagTraces = traces.filter((t) => t.condition === "without-rag");

  function computeStats(traceSet: EvalTrace[], tasks: EvalTask[]) {
    const n = traceSet.length || 1;
    const avgSearchResults = traceSet.reduce((s, t) => s + t.searchResults.length, 0) / n;
    const avgFilesReferenced = traceSet.reduce((s, t) => s + t.filesReferenced.length, 0) / n;
    const avgDurationMs = traceSet.reduce((s, t) => s + t.durationMs, 0) / n;

    // File hit rate: % of tasks with expectedFiles where at least one was found
    let hits = 0;
    let withExpected = 0;
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].expectedFiles && tasks[i].expectedFiles!.length > 0) {
        withExpected++;
        const expected = tasks[i].expectedFiles!;
        const found = traceSet[i].filesReferenced;
        const hasHit = expected.some((e) => found.some((f) => pathHit(f, e, projectDir)));
        if (hasHit) hits++;
      }
    }
    const fileHitRate = withExpected > 0 ? hits / withExpected : 0;

    return { avgSearchResults, avgFilesReferenced, avgDurationMs, fileHitRate };
  }

  return {
    totalTasks: tasks.length,
    withRag: computeStats(withRagTraces, tasks),
    withoutRag: computeStats(withoutRagTraces, tasks),
    traces,
  };
}

export function formatEvalReport(summary: EvalSummary): string {
  const lines: string[] = [];

  lines.push(`A/B Eval results (${summary.totalTasks} tasks):`);
  lines.push("");
  lines.push("                     With RAG    Without RAG");
  lines.push(`  Avg results:       ${summary.withRag.avgSearchResults.toFixed(1).padStart(8)}    ${summary.withoutRag.avgSearchResults.toFixed(1).padStart(11)}`);
  lines.push(`  Avg files found:   ${summary.withRag.avgFilesReferenced.toFixed(1).padStart(8)}    ${summary.withoutRag.avgFilesReferenced.toFixed(1).padStart(11)}`);
  lines.push(`  File hit rate:     ${(summary.withRag.fileHitRate * 100).toFixed(0).padStart(7)}%    ${(summary.withoutRag.fileHitRate * 100).toFixed(0).padStart(10)}%`);
  lines.push(`  Avg latency:       ${summary.withRag.avgDurationMs.toFixed(0).padStart(7)}ms    ${summary.withoutRag.avgDurationMs.toFixed(0).padStart(10)}ms`);

  // Per-task breakdown
  lines.push("\nPer-task breakdown:");
  const withRagTraces = summary.traces.filter((t) => t.condition === "with-rag");
  for (const trace of withRagTraces) {
    const files = trace.filesReferenced.length > 0
      ? trace.filesReferenced.map((f) => basename(f)).join(", ")
      : "(none)";
    lines.push(`  "${trace.task}"`);
    lines.push(`    files found: ${files}`);
    lines.push(`    grading: ${trace.grading}`);
  }

  return lines.join("\n");
}

export async function saveEvalTraces(traces: EvalTrace[], outputPath: string): Promise<void> {
  await writeFile(outputPath, JSON.stringify(traces, null, 2));
}
