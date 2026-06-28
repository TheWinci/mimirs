/**
 * Anthropic Contextual-Retrieval benchmark, run against the mimirs pipeline.
 *
 * Source: anthropics/claude-cookbooks @ capabilities/contextual-embeddings/data
 *   - codebase_chunks.json : 90 source docs (9 real repos x 10 files), multi-lang
 *   - evaluation_set.jsonl  : 248 single-gold queries, each with golden_doc_uuids
 *
 * Anthropic's metric is Pass@k = "golden doc retrieved within top-k" (they headline
 * 1 - recall@20). They score chunk retrieval over THEIR char-split chunks + Voyage
 * embeddings + BM25 (+rerank). We can't reuse their chunk ids (mimirs chunks by
 * symbol, not 250-char windows) so we score the fair, directly-comparable axis:
 * DOCUMENT-level recall@k. Materialize the 90 docs as real files, index with the
 * full mimirs pipeline, run all 248 queries through hybrid search, and check whether
 * the gold document appears in the top-k returned files.
 *
 * Their published doc-level baseline (1 - recall@20): embeddings-only 5.7% failure;
 * +contextual+BM25 2.9%; +rerank 1.9%. We report failure@20 next to Pass@k so the
 * comparison is one glance.
 *
 * Run:
 *   DATA=<dir with codebase_chunks.json + evaluation_set.jsonl> \
 *   bun benchmarks/contextbench/cb-anthropic-ctx.ts
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";
import { search } from "../../src/search/hybrid";

const DATA = process.env.DATA ?? resolve(import.meta.dir, "../../.cb-anthropic");
const CORPUS = process.env.CORPUS ?? resolve(import.meta.dir, "../../.cb-anthropic/corpus");
const KS = [1, 3, 5, 10, 20];

interface Chunk { content: string }
interface Doc { doc_id: string; original_uuid: string; content: string; chunks: Chunk[] }
interface GoldMeta { uuid: string; meta: { relative_path: string; repo_name: string } }
interface EvalRow { query: string; golden_doc_uuids: string[]; golden_documents: GoldMeta[] }

/** uuid -> repo-relative path, harvested from the eval set's inlined golden_documents. */
function buildPathMap(rows: EvalRow[]): Map<string, { repo: string; path: string }> {
  const m = new Map<string, { repo: string; path: string }>();
  for (const r of rows)
    for (const gd of r.golden_documents)
      if (!m.has(gd.uuid)) m.set(gd.uuid, { repo: gd.meta.repo_name, path: gd.meta.relative_path });
  return m;
}

/** Lay the 90 docs out on disk under <corpus>/<repo>/<relative_path>; return abs-path -> uuid. */
function materialize(docs: Doc[], paths: Map<string, { repo: string; path: string }>): Map<string, string> {
  rmSync(CORPUS, { recursive: true, force: true });
  const pathToUuid = new Map<string, string>();
  for (const d of docs) {
    const info = paths.get(d.original_uuid);
    if (!info) throw new Error(`no path for doc ${d.doc_id} (${d.original_uuid})`);
    const rel = info.path.replace(/^\/+/, "");
    const abs = resolve(CORPUS, info.repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, d.content);
    pathToUuid.set(abs, d.original_uuid);
  }
  return pathToUuid;
}

async function main() {
  const docs = JSON.parse(readFileSync(`${DATA}/codebase_chunks.json`, "utf8")) as Doc[];
  const rows = readFileSync(`${DATA}/evaluation_set.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as EvalRow);
  console.log(`Anthropic Contextual-Retrieval bench: ${docs.length} docs, ${rows.length} queries`);

  const pathMap = buildPathMap(rows);
  const pathToUuid = materialize(docs, pathMap);
  console.log(`materialized ${pathToUuid.size} files under ${CORPUS}`);

  // Index the corpus with the full mimirs pipeline. Keep every file (the corpus IS
  // the gold set) — broad include, no test/vendor excludes.
  mkdirSync(resolve(CORPUS, ".mimirs"), { recursive: true });
  writeFileSync(resolve(CORPUS, ".mimirs/config.json"), JSON.stringify({
    include: ["**/*.rs", "**/*.c", "**/*.h", "**/*.cpp", "**/*.py", "**/*.java"],
    exclude: [".mimirs/**", ".git/**"],
  }, null, 2));

  const db = new RagDB(CORPUS);
  const cfg = await loadConfig(CORPUS);
  const t = performance.now();
  await indexDirectory(CORPUS, db, cfg, () => {});
  const nFiles = (db as unknown as { db: { query(s: string): { get(): { n: number } } } }).db.query("SELECT COUNT(*) n FROM files").get().n;
  console.log(`indexed ${nFiles} files in ${((performance.now() - t) / 1000).toFixed(0)}s\n`);

  const maxK = Math.max(...KS);
  const hit: Record<number, number> = Object.fromEntries(KS.map((k) => [k, 0]));
  const ranks: number[] = [];
  let evaluated = 0;

  for (const r of rows) {
    const gold = r.golden_doc_uuids[0];
    const res = await search(r.query, db, maxK, 0, cfg.hybridWeight, cfg.generated);
    const uuids = res.map((x) => pathToUuid.get(x.path));
    let rank = 0;
    for (let i = 0; i < uuids.length; i++) if (uuids[i] === gold) { rank = i + 1; break; }
    ranks.push(rank);
    for (const k of KS) if (rank > 0 && rank <= k) hit[k]++;
    evaluated++;
  }
  db.close();

  const n = evaluated;
  console.log(`Results (n=${n}, doc-level, single-gold)\n`);
  console.log(`   k   Pass@k    recall   failure@k`);
  for (const k of KS) {
    const recall = hit[k] / n;
    const pct = (v: number) => (v * 100).toFixed(1).padStart(6) + "%";
    console.log(`  ${String(k).padEnd(3)}  ${String(hit[k]).padStart(3)}/${n}  ${pct(recall)}    ${pct(1 - recall)}`);
  }
  const found = ranks.filter((x) => x > 0);
  const mrr = ranks.reduce((s, x) => s + (x > 0 ? 1 / x : 0), 0) / n;
  console.log(`\n  MRR=${mrr.toFixed(3)}   median rank(found)=${found.sort((a, b) => a - b)[Math.floor(found.length / 2)] ?? "-"}   misses@${maxK}=${n - found.length}`);
  console.log(`\nAnthropic published failure@20 (1-recall@20): embed-only 5.7% | +ctx+BM25 2.9% | +rerank 1.9%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
