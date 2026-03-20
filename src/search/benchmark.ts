import { readFile } from "fs/promises";
import { resolve } from "path";
import { RagDB } from "../db";
import { search, type DedupedResult } from "./hybrid";
import { loadConfig } from "../config";

export interface BenchmarkQuery {
  query: string;
  expected: string[]; // file paths (relative or absolute)
}

export interface BenchmarkResult {
  query: string;
  expected: string[];
  results: { path: string; score: number }[];
  recall: number; // fraction of expected files found in top-K
  reciprocalRank: number; // 1/rank of first expected file (0 if none found)
  hit: boolean; // at least one expected file found
}

export interface BenchmarkSummary {
  total: number;
  recallAtK: number; // average recall across queries
  mrr: number; // mean reciprocal rank
  zeroMissRate: number; // fraction of queries that missed all expected files
  results: BenchmarkResult[];
}

export async function loadBenchmarkQueries(path: string): Promise<BenchmarkQuery[]> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Benchmark file must be a JSON array of { query, expected } objects");
  }

  for (const entry of parsed) {
    if (!entry.query || !Array.isArray(entry.expected) || entry.expected.length === 0) {
      throw new Error(`Invalid benchmark entry: ${JSON.stringify(entry)}. Each entry needs "query" (string) and "expected" (string[])`);
    }
  }

  return parsed;
}

function normalizePath(p: string, projectDir: string): string {
  // If already absolute, return as-is; otherwise resolve relative to project
  if (p.startsWith("/")) return p;
  return resolve(projectDir, p);
}

export async function runBenchmark(
  queries: BenchmarkQuery[],
  db: RagDB,
  projectDir: string,
  topK: number = 5,
  hybridWeight?: number
): Promise<BenchmarkSummary> {
  const config = await loadConfig(projectDir);
  const weight = hybridWeight ?? config.hybridWeight;

  const results: BenchmarkResult[] = [];

  for (const q of queries) {
    const searchResults = await search(q.query, db, topK, 0, weight);

    const resultPaths = searchResults.map((r) => r.path);
    const expectedNormalized = q.expected.map((p) => normalizePath(p, projectDir));

    // Recall: fraction of expected files found in results
    const found = expectedNormalized.filter((e) =>
      resultPaths.some((r) => r === e || r.endsWith(e) || e.endsWith(r))
    );
    const recall = found.length / expectedNormalized.length;

    // Reciprocal rank: 1/rank of first expected file in results
    let reciprocalRank = 0;
    for (let i = 0; i < resultPaths.length; i++) {
      const matchesExpected = expectedNormalized.some(
        (e) => resultPaths[i] === e || resultPaths[i].endsWith(e) || e.endsWith(resultPaths[i])
      );
      if (matchesExpected) {
        reciprocalRank = 1 / (i + 1);
        break;
      }
    }

    results.push({
      query: q.query,
      expected: q.expected,
      results: searchResults.map((r) => ({ path: r.path, score: r.score })),
      recall,
      reciprocalRank,
      hit: found.length > 0,
    });
  }

  const total = results.length;
  const recallAtK = total > 0 ? results.reduce((s, r) => s + r.recall, 0) / total : 0;
  const mrr = total > 0 ? results.reduce((s, r) => s + r.reciprocalRank, 0) / total : 0;
  const misses = results.filter((r) => !r.hit).length;
  const zeroMissRate = total > 0 ? misses / total : 0;

  return { total, recallAtK, mrr, zeroMissRate, results };
}

export function formatBenchmarkReport(summary: BenchmarkSummary, topK: number = 5): string {
  const lines: string[] = [];

  lines.push(`Benchmark results (${summary.total} queries, top-${topK}):`);
  lines.push(`  Recall@${topK}:      ${(summary.recallAtK * 100).toFixed(1)}%`);
  lines.push(`  MRR:            ${summary.mrr.toFixed(3)}`);
  lines.push(`  Zero-miss rate: ${(summary.zeroMissRate * 100).toFixed(1)}% (${summary.results.filter((r) => !r.hit).length} queries)`);

  // Show failures
  const failures = summary.results.filter((r) => !r.hit);
  if (failures.length > 0) {
    lines.push("\nMissed queries (no expected file in results):");
    for (const f of failures) {
      lines.push(`  "${f.query}"`);
      lines.push(`    expected: ${f.expected.join(", ")}`);
      const got = f.results.length > 0
        ? f.results.map((r) => r.path).join(", ")
        : "(no results)";
      lines.push(`    got:      ${got}`);
    }
  }

  // Show partial hits (recall < 1 but > 0)
  const partials = summary.results.filter((r) => r.hit && r.recall < 1);
  if (partials.length > 0) {
    lines.push("\nPartial matches (some expected files missing):");
    for (const p of partials) {
      lines.push(`  "${p.query}" — recall: ${(p.recall * 100).toFixed(0)}%`);
    }
  }

  return lines.join("\n");
}
