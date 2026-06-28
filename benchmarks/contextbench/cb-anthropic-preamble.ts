/**
 * Phase-1 proof harness for the LLM contextual-preamble lever, on Anthropic's own
 * Contextual-Retrieval bench (90 docs / 248 queries). Same corpus + scoring as
 * cb-anthropic-ctx.ts; this one adds:
 *
 *   mode "dump"  -> index the corpus, then dump every mimirs chunk that needs a
 *                  blurb to preambles_todo.json: {content_hash, file, lines, snippet,
 *                  file_content}. The host model (Claude in-session) reads this and
 *                  writes preambles_done.json = { content_hash: blurb }.
 *   mode "score" -> index + score. If RAG_PREAMBLE_FILE is set, the indexer prepends
 *                  each chunk's blurb (keyed by content_hash) to the embed text, so
 *                  this run is the "preamble ON" condition. Unset = OFF baseline.
 *
 * The blurb is keyed by the MIMIRS chunk content_hash (not Anthropic's chunks), so
 * it lines up with what the productized chunk_preambles table will store.
 *
 * Run:
 *   bun benchmarks/contextbench/cb-anthropic-preamble.ts dump
 *   # write preambles_done.json, then:
 *   RAG_PREAMBLE_FILE=.cb-anthropic/preambles_done.json \
 *     bun benchmarks/contextbench/cb-anthropic-preamble.ts score
 *   bun benchmarks/contextbench/cb-anthropic-preamble.ts score   # OFF baseline
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";
import { search } from "../../src/search/hybrid";

const DATA = process.env.DATA ?? resolve(import.meta.dir, "../../.cb-anthropic");
const CORPUS = process.env.CORPUS ?? resolve(import.meta.dir, "../../.cb-anthropic/corpus");
const TODO = `${DATA}/preambles_todo.json`;
const KS = [1, 3, 5, 10, 20];

interface Chunk { content: string }
interface Doc { doc_id: string; original_uuid: string; content: string; chunks: Chunk[] }
interface GoldMeta { uuid: string; meta: { relative_path: string; repo_name: string } }
interface EvalRow { query: string; golden_doc_uuids: string[]; golden_documents: GoldMeta[] }

function buildPathMap(rows: EvalRow[]): Map<string, { repo: string; path: string }> {
  const m = new Map<string, { repo: string; path: string }>();
  for (const r of rows)
    for (const gd of r.golden_documents)
      if (!m.has(gd.uuid)) m.set(gd.uuid, { repo: gd.meta.repo_name, path: gd.meta.relative_path });
  return m;
}

function materialize(docs: Doc[], paths: Map<string, { repo: string; path: string }>): Map<string, string> {
  rmSync(CORPUS, { recursive: true, force: true });
  const pathToUuid = new Map<string, string>();
  for (const d of docs) {
    const info = paths.get(d.original_uuid)!;
    const rel = info.path.replace(/^\/+/, "");
    const abs = resolve(CORPUS, info.repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, d.content);
    pathToUuid.set(abs, d.original_uuid);
  }
  return pathToUuid;
}

async function buildIndex() {
  const docs = JSON.parse(readFileSync(`${DATA}/codebase_chunks.json`, "utf8")) as Doc[];
  const rows = readFileSync(`${DATA}/evaluation_set.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as EvalRow);
  const pathToUuid = materialize(docs, buildPathMap(rows));
  mkdirSync(resolve(CORPUS, ".mimirs"), { recursive: true });
  writeFileSync(resolve(CORPUS, ".mimirs/config.json"), JSON.stringify({
    include: ["**/*.rs", "**/*.c", "**/*.h", "**/*.cpp", "**/*.py", "**/*.java"],
    exclude: [".mimirs/**", ".git/**"],
  }, null, 2));
  const db = new RagDB(CORPUS);
  const cfg = await loadConfig(CORPUS);
  await indexDirectory(CORPUS, db, cfg, () => {});
  return { db, cfg, rows, pathToUuid };
}

type RawDB = { db: { query(s: string): { all(...a: unknown[]): unknown[] } } };

async function dump() {
  const { db } = await buildIndex();
  const corpusPrefix = CORPUS.endsWith("/") ? CORPUS : CORPUS + "/";
  const rowsRaw = (db as unknown as RawDB).db.query(
    `SELECT c.content_hash AS hash, c.snippet AS snippet, c.start_line AS s, c.end_line AS e, f.path AS path
     FROM chunks c JOIN files f ON f.id = c.file_id
     WHERE c.chunk_index >= 0 AND c.content_hash IS NOT NULL`
  ).all() as { hash: string; snippet: string; s: number | null; e: number | null; path: string }[];
  db.close();

  // De-dup by content_hash (identical chunks share a blurb) and attach whole-file content.
  const fileCache = new Map<string, string>();
  const seen = new Set<string>();
  const todo: { content_hash: string; file: string; lines: string; snippet: string; file_content: string }[] = [];
  for (const r of rowsRaw) {
    if (seen.has(r.hash)) continue;
    seen.add(r.hash);
    if (!fileCache.has(r.path)) fileCache.set(r.path, readFileSync(r.path, "utf8"));
    todo.push({
      content_hash: r.hash,
      file: r.path.startsWith(corpusPrefix) ? r.path.slice(corpusPrefix.length) : r.path,
      lines: `${r.s ?? "?"}-${r.e ?? "?"}`,
      snippet: r.snippet,
      file_content: fileCache.get(r.path)!,
    });
  }
  writeFileSync(TODO, JSON.stringify(todo, null, 2));
  console.log(`dumped ${todo.length} unique chunks (from ${rowsRaw.length} total) -> ${TODO}`);
  console.log(`files: ${fileCache.size}`);
}

async function score() {
  const preFile = process.env.RAG_PREAMBLE_FILE;
  const mode = preFile ? `ON (${preFile.split("/").pop()})` : "OFF baseline";
  const { db, cfg, rows, pathToUuid } = await buildIndex();
  let covered = 0;
  if (preFile) {
    const map = JSON.parse(readFileSync(preFile, "utf8")) as Record<string, string>;
    covered = Object.keys(map).length;
  }

  const qOverride: (string | null)[] | null = process.env.QUERY_FILE ? JSON.parse(readFileSync(process.env.QUERY_FILE, "utf8")) : null;
  if (qOverride) console.log(`(using rewritten queries from ${process.env.QUERY_FILE})`);
  const maxK = Math.max(...KS);
  const hit: Record<number, number> = Object.fromEntries(KS.map((k) => [k, 0]));
  const ranks: number[] = [];
  const perQuery: { query: string; gold: string; rank: number }[] = [];
  for (let qi = 0; qi < rows.length; qi++) {
    const r = rows[qi];
    const gold = r.golden_doc_uuids[0];
    const res = await search((qOverride?.[qi]) || r.query, db, maxK, 0, cfg.hybridWeight, cfg.generated);
    const uuids = res.map((x) => pathToUuid.get(x.path));
    let rank = 0;
    for (let i = 0; i < uuids.length; i++) if (uuids[i] === gold) { rank = i + 1; break; }
    ranks.push(rank);
    perQuery.push({ query: r.query, gold, rank });
    for (const k of KS) if (rank > 0 && rank <= k) hit[k]++;
  }
  db.close();
  if (process.env.DUMP_RANKS) writeFileSync(process.env.DUMP_RANKS, JSON.stringify(perQuery, null, 2));

  const n = rows.length;
  console.log(`\n=== preamble ${mode}  (n=${n}, doc-level)${covered ? `  blurbs=${covered}` : ""} ===`);
  console.log(`   k   Pass@k    recall   failure@k`);
  for (const k of KS) {
    const recall = hit[k] / n;
    const pct = (v: number) => (v * 100).toFixed(1).padStart(6) + "%";
    console.log(`  ${String(k).padEnd(3)}  ${String(hit[k]).padStart(3)}/${n}  ${pct(recall)}    ${pct(1 - recall)}`);
  }
  const found = ranks.filter((x) => x > 0);
  const mrr = ranks.reduce((s, x) => s + (x > 0 ? 1 / x : 0), 0) / n;
  console.log(`  MRR=${mrr.toFixed(3)}  Pass@1=${(hit[1] / n * 100).toFixed(1)}%  misses@${maxK}=${n - found.length}`);
}

const mode = process.argv[2] ?? "score";
(mode === "dump" ? dump() : score()).catch((e) => { console.error(e); process.exit(1); });
