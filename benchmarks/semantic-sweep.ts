/**
 * Semantic vs keyword weight sweep.
 *
 * The first-party benchmark queries name the target's exact identifiers, so they
 * favour BM25 — which would bias a hybridWeight decision toward lexical. This
 * isolates the OTHER half: queries that describe a file's purpose WITHOUT using
 * its vocabulary. We programmatically keep only the low-lexical-overlap ones
 * (BM25 can't keyword-match them — only semantics can), then sweep the weight on
 * that set vs the keyword set. If recall collapses as weight -> 0 on the semantic
 * set, vector weight is essential and we must not lower the default too far.
 *
 * Run: bun benchmarks/semantic-sweep.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { RagDB } from "../src/db";
import { loadBenchmarkQueries, runBenchmark, type BenchmarkQuery } from "../src/search/benchmark";

const STOP = new Set([
  "the", "and", "for", "from", "with", "that", "this", "what", "when", "where",
  "how", "all", "not", "but", "has", "have", "get", "set", "new", "use", "can",
  "will", "into", "each", "only", "does", "are", "its", "their", "them", "they",
  "out", "off", "any", "one", "two", "way", "who", "why", "had", "was", "were",
  "been", "than", "then", "now", "our", "your", "his",
]);

const contentWords = (q: string): string[] =>
  [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];

/** Fraction of query content words that appear (as substrings) in the target file(s). */
function lexicalOverlap(q: BenchmarkQuery): number {
  const words = contentWords(q.query);
  if (words.length === 0) return 1;
  const text = q.expected
    .map((p) => { try { return readFileSync(resolve(".", p), "utf-8").toLowerCase(); } catch { return ""; } })
    .join("\n");
  return words.filter((w) => text.includes(w)).length / words.length;
}

async function sweep(db: RagDB, qs: BenchmarkQuery[], label: string) {
  console.log(`\n${label}  (${qs.length} queries)`);
  console.log("weight  Recall@10    MRR    Zero-miss");
  for (const w of [1.0, 0.7, 0.5, 0.3, 0.0]) {
    const s = await runBenchmark(qs, db, ".", 10, w);
    const tag = w === 1.0 ? " (pure vector)" : w === 0.0 ? " (pure BM25)" : "";
    console.log(`  ${w.toFixed(2)}    ${(s.recallAtK * 100).toFixed(1).padStart(5)}%   ${s.mrr.toFixed(3)}    ${(s.zeroMissRate * 100).toFixed(1)}%${tag}`);
  }
}

const db = new RagDB(".");

const semAll = await loadBenchmarkQueries("./benchmarks/semantic-queries.json");
const annotated = semAll.map((q) => ({ q, ov: lexicalOverlap(q) })).sort((a, b) => a.ov - b.ov);
const THRESH = 0.34;
const semantic = annotated.filter((a) => a.ov <= THRESH).map((a) => a.q);

console.log(`Lexical overlap of each semantic query with its target file (lower = more purely semantic):`);
for (const a of annotated) console.log(`  ${(a.ov * 100).toFixed(0).padStart(3)}%  ${a.q.expected[0].padEnd(34)} | ${a.q.query.slice(0, 52)}`);
console.log(`\nKept ${semantic.length}/${semAll.length} as genuinely semantic (overlap <= ${THRESH * 100}%).`);

await sweep(db, semantic, "SEMANTIC (low lexical overlap — only meaning can find these)");
const keyword = await loadBenchmarkQueries("./benchmarks/mimirs-queries.json");
await sweep(db, keyword, "KEYWORD (original first-party — name the identifiers)");

db.close();
