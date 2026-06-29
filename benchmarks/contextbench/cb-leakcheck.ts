/**
 * Leakage audit for distilled queries: does the query text literally name the
 * gold? Checks 3 ever-stronger leaks per gold file:
 *   (a) full rel path substring in query
 *   (b) basename WITH extension (e.g. "validators.py")
 *   (c) basename WITHOUT extension (e.g. "validators") as a whole word
 * Also: is the gold-naming token ALSO present in the raw problem_statement?
 * If yes, it's not a gold-leak — the user's own bug report named it (fair).
 */
import { readFileSync } from "fs";
const CB = "/Users/winci/repos/cb-repos";
const ds = JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as any[];
const Q = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;

let nGold = 0, leakPath = 0, leakBaseExt = 0, leakBaseNoExt = 0, leakNoExtNotInPS = 0;
const flags: string[] = [];
for (const g of ds.sort((a, b) => a.dir.localeCompare(b.dir))) {
  const q = (Q[g.dir] ?? "").toLowerCase();
  const ps = (g.problem_statement ?? "").toLowerCase();
  if (!q) continue;
  const gold = [...new Set(g.gold.map((x: any) => x.file as string))];
  for (const f of gold) {
    nGold++;
    const base = f.split("/").pop()!;
    const noExt = base.replace(/\.[^.]+$/, "");
    const word = new RegExp(`\\b${noExt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (q.includes(f.toLowerCase())) leakPath++;
    if (q.includes(base.toLowerCase())) leakBaseExt++;
    if (word.test(q)) {
      leakBaseNoExt++;
      const inPS = word.test(ps);
      if (!inPS) { leakNoExtNotInPS++; flags.push(`  ${g.dir.padEnd(20)} gold=${base}  noExt="${noExt}" in query but NOT in problem_statement`); }
    }
  }
}
const pct = (n: number) => `${n}/${nGold} (${(n / nGold * 100).toFixed(0)}%)`;
console.log(`gold files audited: ${nGold}`);
console.log(`(a) full path in query:            ${pct(leakPath)}`);
console.log(`(b) basename+ext in query:         ${pct(leakBaseExt)}`);
console.log(`(c) basename(noext) word in query: ${pct(leakBaseNoExt)}`);
console.log(`    of which NOT in problem_stmt:  ${pct(leakNoExtNotInPS)}   <-- the only real "leak" suspects`);
if (flags.length) { console.log(`\nsuspect (query names gold token absent from the bug report):`); for (const l of flags) console.log(l); }
else console.log(`\nno suspect leaks: every gold-name in a query is also in the user's own problem_statement.`);
