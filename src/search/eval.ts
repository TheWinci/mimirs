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

/**
 * Simulate an agent's search behavior for a task.
 * "with-rag": runs semantic search on the task description and returns what was found.
 * "without-rag": returns empty results (simulating an agent with no RAG).
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
    searchResults = await search(task.task, db, topK, 0, config.hybridWeight);
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
        const hasHit = expected.some((e) =>
          found.some((f) => f === e || f.endsWith(e) || e.endsWith(f))
        );
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
