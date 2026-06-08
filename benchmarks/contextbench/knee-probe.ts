/**
 * Knee/smoothness probe: treat sorted search() file scores as a function and look
 * for an elbow (Kneedle) + largest first-derivative drop, then ask whether any
 * such cut separates gold from noise better than fixed topK. Diagnostic only.
 *   bun benchmarks/contextbench/knee-probe.ts
 */
import { readFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search } from "../../src/search/hybrid";

const repoDir = process.env.ARENA_REPO ?? "/tmp/cb-arena/repo";
const issue = readFileSync(process.env.ARENA_ISSUE ?? "/tmp/cb-arena/issue.txt", "utf8");
const gold = (JSON.parse(readFileSync(process.env.ARENA_GOLD ?? "/tmp/cb-arena-gold.json", "utf8")).gold) as { file: string }[];
const goldFiles = new Set(gold.map((g) => g.file));
const rel = (p: string) => (p.startsWith(repoDir) ? p.slice(repoDir.length + 1) : p);
const base = (p: string) => rel(p).split("/").pop() ?? "";
const isBarrel = (p: string) => ["__init__.py", "index.ts", "index.js", "mod.rs"].includes(base(p));
const isTest = (p: string) => /(^|\/)tests?\//.test(rel(p)) || /test_|_test\.|\.test\./.test(base(p)) || base(p) === "conftest.py";

/**
 * Head-cluster cutoff (user's rule): walk the steep head while each relative drop
 * Δ% >= T; the last head member is the "floor"; keep everything >= floor*mult.
 * Returns the kept count.
 */
function headCutoff(scores: number[], T: number, mult: number): { floorRank: number; cut: number } {
  let h = 0; // index of last head member (0-based)
  for (let i = 1; i < scores.length; i++) {
    const drop = scores[i - 1] > 0 ? (scores[i - 1] - scores[i]) / scores[i - 1] : 0;
    if (drop >= T) h = i; else break;
  }
  const floor = scores[h];
  const cut = floor * mult;
  let kept = 0;
  for (const s of scores) if (s >= cut) kept++;
  return { floorRank: h + 1, cut: kept };
}

async function main() {
  const db = new RagDB(repoDir);
  const cfg = await loadConfig(repoDir);
  const rawRes = await search(issue, db, 60, 0, cfg.hybridWeight, cfg.generated);
  // Mirror the real cb-adapter: tests are excluded at INDEX time, so drop them here.
  // NOBARREL=1 also drops barrel/index files (the affinity-bug bump that poisons
  // the steep head) before the cutoff sees them.
  const res = rawRes.filter((r) => !isTest(r.path) && !(process.env.NOBARREL === "1" && isBarrel(r.path)));
  const scores = res.map((r) => r.score);
  const n = scores.length;

  // Kneedle on the sorted-descending curve: normalize x,y to [0,1]; the knee of a
  // convex-decreasing curve is the index of max (x_norm - y_norm) i.e. furthest
  // below the chord from first to last point.
  const xs = scores.map((_, i) => i / (n - 1));
  const smin = scores[n - 1], smax = scores[0], span = smax - smin || 1;
  const ys = scores.map((s) => (s - smin) / span);
  let kneeIdx = 0, kneeVal = -Infinity;
  for (let i = 0; i < n; i++) { const d = xs[i] - ys[i]; if (d > kneeVal) { kneeVal = d; kneeIdx = i; } }

  // Largest single drop (first derivative) and its location.
  let maxDropIdx = 0, maxDrop = -Infinity;
  const deltas: number[] = [];
  for (let i = 1; i < n; i++) { const d = scores[i - 1] - scores[i]; deltas.push(d); if (d > maxDrop) { maxDrop = d; maxDropIdx = i; } }

  // Largest RELATIVE drop ignoring the first 1 (skip the affinity-explosion head).
  let maxRelIdx = 0, maxRel = -Infinity;
  for (let i = 2; i < n; i++) { const r = scores[i - 1] > 0 ? (scores[i - 1] - scores[i]) / scores[i - 1] : 0; if (r > maxRel) { maxRel = r; maxRelIdx = i; } }

  console.log(`astropy deb49033 — ${n} files, gold ${goldFiles.size}\n`);
  console.log(`rank  score    Δ        Δ%     tag    file`);
  res.forEach((r, i) => {
    const f = rel(r.path);
    const tag = goldFiles.has(f) ? "GOLD" : isBarrel(r.path) ? "barrel" : "-";
    const d = i > 0 ? (scores[i - 1] - scores[i]) : 0;
    const dp = i > 0 && scores[i - 1] > 0 ? (d / scores[i - 1]) * 100 : 0;
    const mark = i === kneeIdx ? " <-KNEE" : i === maxDropIdx ? " <-maxΔ" : i === maxRelIdx ? " <-maxΔ%" : "";
    console.log(`${String(i + 1).padStart(3)}  ${scores[i].toFixed(3).padStart(8)}  ${d.toFixed(3).padStart(7)}  ${dp.toFixed(0).padStart(4)}%  ${tag.padEnd(6)} ${f}${mark}`);
  });

  const goldRanks = res.map((r, i) => goldFiles.has(rel(r.path)) ? i + 1 : 0).filter(Boolean);
  console.log(`\ngold at ranks: ${goldRanks.join(", ")}`);
  console.log(`Kneedle knee:        rank ${kneeIdx + 1} (cut keeps ${kneeIdx + 1})`);
  console.log(`max abs Δ drop:      rank ${maxDropIdx + 1}`);
  console.log(`max rel Δ% drop:     rank ${maxRelIdx + 1}`);
  const lastGold = Math.max(...goldRanks);
  for (const [name, cut] of [["knee", kneeIdx + 1], ["maxΔ", maxDropIdx + 1], ["maxΔ%", maxRelIdx + 1]] as [string, number][]) {
    const goldKept = goldRanks.filter((g) => g <= cut).length;
    console.log(`  cut@${name}=${cut}: gold kept ${goldKept}/${goldFiles.size}, noise kept ${cut - goldKept}, lastGold@${lastGold}`);
  }

  console.log(`\n=== head-cluster cutoff (floor*0.8), tests excluded ===`);
  console.log(`gold ranks (tests-excluded): ${goldRanks.join(", ")}`);
  for (const T of [0.15, 0.2, 0.25]) {
    const { floorRank, cut } = headCutoff(scores, T, 0.8);
    const goldKept = goldRanks.filter((g) => g <= cut).length;
    const cov = goldKept / goldFiles.size, prec = cut ? goldKept / cut : 0;
    console.log(`  T=${T}: head floor@rank${floorRank} -> keep ${cut} files | gold ${goldKept}/${goldFiles.size} cov=${(cov*100).toFixed(0)}% prec=${(prec*100).toFixed(0)}%`);
  }
  // Combined break: a step counts as a "wall" only if big in BOTH %drop and raw
  // drop. Tiny-raw tail flutter (15% on a 0.05 drop) is vetoed; a close pair in
  // the head (small %) doesn't end the head prematurely. Head = above the last
  // wall; floor = file just above it; keep >= floor*0.8.
  // Option B: barrels STAY in results, but are excluded from the wall calc (their
  // affinity-inflated scores fake a steep head). Compute the wall on non-barrels;
  // the threshold = the wall-bottom non-barrel score (gold sits just under the last
  // step). Final kept = all barrels + non-barrels scoring >= threshold.
  console.log(`\n=== wall cutoff (non-barrels set the wall, barrels ride the threshold) ===`);
  const nb = res.filter((r) => !isBarrel(r.path));       // non-barrel rows, ranked
  const nbScores = nb.map((r) => r.score);
  const nBarrels = res.length - nb.length;
  for (const Tp of [0.15]) for (const Tr of [0.5, 1.0, 2.0]) {
    let lastWall = 1; // 0-based index of lower item of deepest wall, within nb
    for (let i = 1; i < nbScores.length; i++) {
      const raw = nbScores[i - 1] - nbScores[i];
      const pct = nbScores[i - 1] > 0 ? raw / nbScores[i - 1] : 0;
      if (pct >= Tp && raw >= Tr) lastWall = i;
    }
    const threshold = nbScores[lastWall];               // wall-bottom non-barrel score
    const kept = res.filter((r) => isBarrel(r.path) || r.score >= threshold);
    const keptFiles = new Set(kept.map((r) => rel(r.path)));
    const goldKept = [...goldFiles].filter((f) => keptFiles.has(f)).length;
    const prec = kept.length ? goldKept / kept.length : 0;
    console.log(`  Tp=${Tp} Tr=${Tr}: thr=${threshold.toFixed(3)} -> keep ${kept.length} (${nBarrels} barrels + ${kept.length - nBarrels} nb) | gold ${goldKept}/${goldFiles.size} cov=${(goldKept/goldFiles.size*100).toFixed(0)}% prec=${(prec*100).toFixed(0)}%`);
  }

  console.log(`\n  fixed-K baselines:`);
  for (const K of [5, 8, 12, 20]) {
    const goldKept = goldRanks.filter((g) => g <= K).length;
    console.log(`  topK=${K}: gold ${goldKept}/${goldFiles.size} cov=${(goldKept/goldFiles.size*100).toFixed(0)}% prec=${(goldKept/K*100).toFixed(0)}%`);
  }
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
