/**
 * Trim lab: line precision is capped because gold = specific lines but mimirs
 * returns whole functions. Try trimming each returned chunk to its query-relevant
 * line window(s) — the only lever that can raise LINE precision without dropping
 * the chunk entirely. Measures all 4 metrics on the arena vs untrimmed.
 * Run: bun benchmarks/contextbench/trim-lab.ts
 */
import { readFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { searchChunks, type ChunkResult } from "../../src/search/hybrid";

const repoDir = "/tmp/cb-arena/repo";
const issue = readFileSync("/tmp/cb-arena/issue.txt", "utf8");
const gold = (JSON.parse(readFileSync("/tmp/cb-arena-gold.json", "utf8")).gold) as { file: string; start: number; end: number }[];
const goldFiles = new Set(gold.map((g) => g.file));
const goldLines = new Map<string, Set<number>>();
for (const g of gold) { const s = goldLines.get(g.file) ?? new Set<number>(); for (let i = g.start; i <= g.end; i++) s.add(i); goldLines.set(g.file, s); }
const tgl = [...goldLines.values()].reduce((a, s) => a + s.size, 0);
const rel = (p: string) => !p ? "" : (p.startsWith(repoDir) ? p.slice(repoDir.length + 1) : p);

type Span = { path: string; startLine: number; endLine: number };
function sc(spans: Span[]) {
  const pf = new Set<string>(); let pl = 0, ph = 0; const gh = new Set<string>();
  for (const c of spans) {
    const f = rel(c.path); pf.add(f); const gl = goldLines.get(f);
    for (let i = c.startLine; i <= c.endLine; i++) { pl++; if (gl?.has(i)) { ph++; gh.add(f + i); } }
  }
  const fc = [...goldFiles].filter((f) => pf.has(f)).length / goldFiles.size;
  const fp = pf.size ? [...pf].filter((f) => goldFiles.has(f)).length / pf.size : 0;
  const lc = tgl ? gh.size / tgl : 0; const lp = pl ? ph / pl : 0;
  return { fc, fp, lc, lp };
}
const fmt = (r: ReturnType<typeof sc>) => `fileCov ${(r.fc*100).toFixed(0).padStart(3)}%  filePrec ${(r.fp*100).toFixed(0).padStart(3)}%  lineCov ${(r.lc*100).toFixed(0).padStart(3)}%  linePrec ${(r.lp*100).toFixed(1).padStart(4)}%`;

const STOP = new Set("the a an of to in and or for is are be this that with from as at by on it its if then else def class self return import not none true false".split(" "));
function queryTerms(): Set<string> {
  return new Set(issue.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 4 && !STOP.has(w)));
}

// Trim a chunk to contiguous windows around lines that contain >=1 query term,
// padding by `pad` lines. Returns sub-spans (absolute line numbers).
function trimChunk(c: ChunkResult, terms: Set<string>, pad: number): Span[] {
  if (c.startLine == null || c.endLine == null) return [];
  const lines = c.content.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const toks = lines[i].toLowerCase().split(/[^a-z0-9_]+/);
    if (toks.some((t) => t.length >= 4 && terms.has(t))) hits.push(i);
  }
  if (hits.length === 0) return [{ path: c.path, startLine: c.startLine, endLine: c.endLine }]; // no signal → keep whole
  // merge hit lines into windows with padding
  const wins: [number, number][] = [];
  for (const h of hits) {
    const s = Math.max(0, h - pad), e = Math.min(lines.length - 1, h + pad);
    if (wins.length && s <= wins[wins.length - 1][1] + 1) wins[wins.length - 1][1] = Math.max(wins[wins.length - 1][1], e);
    else wins.push([s, e]);
  }
  return wins.map(([s, e]) => ({ path: c.path, startLine: c.startLine! + s, endLine: c.startLine! + e }));
}

async function main() {
  const db = new RagDB(repoDir); const cfg = await loadConfig(repoDir);
  const terms = queryTerms();
  console.log(`gold ${gold.length} spans / ${goldFiles.size} files / ${tgl} lines\n`);
  for (const K of [12, 20]) {
    const base = await searchChunks(issue, db, K, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, true);
    const whole: Span[] = base.filter((c) => c.startLine != null).map((c) => ({ path: c.path, startLine: c.startLine!, endLine: c.endLine! }));
    console.log(`── top${K} ──`);
    console.log(`  untrimmed       ${fmt(sc(whole))}`);
    for (const pad of [0, 2, 5]) {
      const trimmed = base.flatMap((c) => trimChunk(c, terms, pad));
      console.log(`  trim pad${pad}        ${fmt(sc(trimmed))}`);
    }
    console.log();
  }
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
