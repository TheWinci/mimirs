/**
 * SweRank / SWE-Loc Mode-A adapter — drop mimirs in as the retriever.
 *
 * SweRank ships pre-processed BEIR folders (one per issue) with a function- (or
 * file-) level `corpus.jsonl`, the issue as `queries.jsonl`, and gold `qrels`.
 * Its leaderboard metric (recall@k at file/module/function) is computed by
 * `src/refactored_eval_localization.py`, which only needs a ranked list of
 * corpus-ids per instance. So we replace ONLY the retrieval core with mimirs and
 * reuse their python eval unchanged.
 *
 * This script: for each instance dir, index its corpus into a throwaway RagDB
 * (one corpus doc = one file = one pre-embedded chunk — we bypass the chunker so
 * granularity matches their gold exactly), rank the issue query with mimirs'
 * hybrid (vector + BM25 RRF), and emit `{instance_id: [doc_id, ... top100]}`.
 *
 * Then `swerank_attach_and_eval.py` attaches these as the `docs` column and runs
 * SweRank's own localization eval. See plans/external-benchmarks-survey.md.
 *
 * Run:
 *   RAG_DB_DIR=/tmp/swerank-mimirs \
 *   bun benchmarks/swe-localization/swerank-adapter.ts <datasets_dir> <out_prefix> [limit] [weights] [dirPrefix]
 *
 *   weights   = comma list, swept from ONE embedding pass (e.g. "0.5,0.3,0.1,0").
 *               One output file per weight: <out_prefix>.w<weight>.json
 *   dirPrefix = which instance dirs to rank (default "swe-bench-lite-function_").
 *               Mixing datasets dilutes eval — keep this scoped to one.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { RagDB } from "../../src/db";
import { embedBatch, embed } from "../../src/embeddings/embed";
import { rrfFuse, search } from "../../src/search/hybrid";

const TOPK = 100; // SweRank's get_top_docs keeps top-100 per instance

interface BeirDoc { _id: string; text: string; title?: string }

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

/** A SweRank instance dir = BEIR layout: corpus.jsonl, queries.jsonl, qrels/test.tsv. */
function isInstanceDir(dir: string): boolean {
  return existsSync(join(dir, "corpus.jsonl")) && existsSync(join(dir, "queries.jsonl"));
}

/**
 * Rank one instance at every requested weight from a SINGLE embedding pass.
 * Corpus docs are pushed as synthetic-path files (doc_<i>) so mimirs path
 * normalization can't mangle BEIR ids that contain ':' or '/'; we map the ranked
 * synthetic paths back to real doc-ids before emitting. Returns
 * {weight: {instance_id: [doc_id...]}}.
 */
async function rankInstance(
  dir: string,
  weights: number[],
  mode: "raw" | "full",
): Promise<Record<number, Record<string, string[]>>> {
  const corpus = readJsonl<BeirDoc>(join(dir, "corpus.jsonl"));
  const queries = readJsonl<BeirDoc>(join(dir, "queries.jsonl"));

  const dbDir = join(process.env.RAG_DB_DIR ?? tmpdir(), `swerank-inst`);
  rmSync(dbDir, { recursive: true, force: true });
  const db = new RagDB(dbDir);
  const out: Record<number, Record<string, string[]>> = {};
  for (const w of weights) out[w] = {};
  try {
    // One corpus doc -> one file -> one pre-embedded chunk (chunker bypassed —
    // their corpus is already function-chunked). In "full" mode the file path is
    // the real BEIR id, so mimirs' path/filename boosts and the full search()
    // ranker apply; "raw" uses synthetic paths + bare vector+BM25 fusion.
    // Graph/symbol boosts can't apply either way: a flattened function corpus has
    // no cross-file imports to resolve — that needs real cloned repos (Mode B).
    const pathByIdx = corpus.map((d, i) => (mode === "full" ? d._id : `doc_${i}`));
    const idByPath = new Map(corpus.map((d, i) => [pathByIdx[i], d._id]));

    const texts = corpus.map((d) => (d.title ? `${d.title}\n${d.text}` : d.text));
    const BATCH = 64;
    for (let i = 0; i < corpus.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const embs = await embedBatch(slice);
      for (let j = 0; j < slice.length; j++) {
        db.upsertFile(pathByIdx[i + j], `h${i + j}`, [{ snippet: slice[j], embedding: embs[j] }]);
      }
    }

    for (const q of queries) {
      if (mode === "full") {
        // Full mimirs ranker (hybrid fusion + path/filename boosts + symbol
        // expansion). Re-runs retrieval per weight; corpus embedding is already
        // done, so this is cheap.
        for (const w of weights) {
          const res = await search(q.text, db, TOPK, 0, w);
          out[w][q._id] = res.map((r) => idByPath.get(r.path)!).filter(Boolean);
        }
      } else {
        const qe = await embed(q.text);
        const vec = db.search(qe, TOPK).map((r) => ({ path: r.path, score: r.score }));
        const bm25 = db.textSearch(q.text, TOPK).map((r) => ({ path: r.path, score: r.score }));
        for (const w of weights) {
          const fused = rrfFuse(vec, bm25, w, (r) => r.path)
            .sort((a, b) => b.score - a.score)
            .slice(0, TOPK);
          out[w][q._id] = fused.map((r) => idByPath.get(r.path)!).filter(Boolean);
        }
      }
    }
    return out;
  } finally {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

async function main() {
  const datasetsDir = process.argv[2];
  const outPrefix = process.argv[3];
  const limit = parseInt(process.argv[4] ?? "0", 10) || Infinity;
  const weights = (process.argv[5] ?? "0.5").split(",").map((s) => parseFloat(s.trim()));
  const dirPrefix = process.argv[6] ?? "swe-bench-lite-function_";
  // raw = bare vector+BM25 fusion (correct for this benchmark). "full" adds
  // path/filename boosts via search() but BACKFIRES on the flat function corpus
  // (boosts assume real repo structure) — kept only for the record. See plan.
  const mode = (process.env.RANK_MODE as "raw" | "full") ?? "raw";
  if (!datasetsDir || !outPrefix) {
    console.error("usage: bun swerank-adapter.ts <datasets_dir> <out_prefix> [limit] [weights] [dirPrefix]");
    process.exit(1);
  }

  const dirs = readdirSync(datasetsDir)
    .filter((d) => d.startsWith(dirPrefix))
    .map((d) => join(datasetsDir, d))
    .filter(isInstanceDir)
    .slice(0, limit);
  console.log(`Ranking ${dirs.length} '${dirPrefix}' instances at weights [${weights.join(", ")}] (mode=${mode})...`);

  const all: Record<number, Record<string, string[]>> = {};
  for (const w of weights) all[w] = {};
  let done = 0;
  for (const dir of dirs) {
    const res = await rankInstance(dir, weights, mode);
    for (const w of weights) Object.assign(all[w], res[w]);
    if (++done % 5 === 0) console.log(`  ${done}/${dirs.length}`);
  }

  for (const w of weights) {
    const path = `${outPrefix}.w${w}.json`;
    writeFileSync(path, JSON.stringify(all[w], null, 2));
    console.log(`Wrote ${Object.keys(all[w]).length} rankings @w${w} -> ${path}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
