"use strict";
// Retrieval inspector frontend. Fetches the per-stage trace + gold-neighbourhood
// graph from the server and renders each pipeline stage with gold annotation.
// Gold matching is client-side (suffix hit), so paths stay absolute on the wire.

const $ = (id) => document.getElementById(id);
const state = {
  instance: null, mode: "distilled", tab: "file",
  leafOnly: "true", includeFix: "false", data: null,
};
let timer = null;

const hit = (p, e) => p === e || p.endsWith("/" + e) || p.endsWith(e);
const isGoldP = (p, goldFiles) => goldFiles.some((g) => hit(p, g));
const relOf = (p, dir) => (p && dir && p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const rankIn = (list, gold) => { for (let i = 0; i < list.length; i++) if (hit(list[i].path, gold)) return i + 1; return 0; };
const badge = (r) => r === 0 ? `<span class="badge b-miss">miss</span>`
  : r <= 8 ? `<span class="badge b-found">@${r}</span>`
  : r <= 12 ? `<span class="badge b-amber">@${r}</span>`
  : `<span class="badge b-miss">@${r}</span>`;

async function boot() {
  const insts = await (await fetch("/api/instances")).json();
  const sel = $("instance");
  sel.innerHTML = insts.map((d) => `<option value="${d.dir}">${d.dir}  (gold ${d.goldFiles}f/${d.goldLines}L)</option>`).join("");
  state.instance = insts[0].dir;
  wire();
  run();
}

function wire() {
  $("instance").onchange = (e) => { state.instance = e.target.value; run(); };
  for (const id of ["weight", "k", "kchunk", "threshold", "pgmc", "relCutoff", "parentBoost"])
    $(id).oninput = () => { if (id === "weight") $("weightV").textContent = $("weight").value; schedule(); };
  segGroup("mode", (v) => { state.mode = v; run(); });
  segGroup("leafOnly", (v) => { state.leafOnly = v; run(); });
  segGroup("includeFix", (v) => { state.includeFix = v; if (state.tab === "graph") drawGraph(); });
  for (const b of $("tabs").querySelectorAll("button")) b.onclick = () => setTab(b.dataset.t);
}
function segGroup(id, cb) {
  const el = $(id);
  for (const b of el.querySelectorAll("button")) b.onclick = () => {
    for (const x of el.querySelectorAll("button")) x.classList.remove("on");
    b.classList.add("on"); cb(b.dataset.v);
  };
}
function schedule() { clearTimeout(timer); timer = setTimeout(run, 350); }
function setTab(t) {
  state.tab = t;
  for (const b of $("tabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.t === t);
  render();
}

function qs() {
  const p = new URLSearchParams({
    instance: state.instance, mode: state.mode,
    weight: $("weight").value || "0.5", k: $("k").value, kchunk: $("kchunk").value,
    threshold: $("threshold").value, pgmc: $("pgmc").value, leafOnly: state.leafOnly,
    relCutoff: $("relCutoff").value, parentBoost: $("parentBoost").value,
  });
  return p.toString();
}

async function run() {
  $("status").textContent = "running…";
  try {
    const data = await (await fetch("/api/trace?" + qs())).json();
    if (data.error) { $("status").textContent = ""; $("view").innerHTML = `<div class="err">${esc(data.error)}</div>`; return; }
    // sync knob defaults from server config on first load of an instance
    if (state.data?.instance !== data.instance) {
      $("weight").value = data.params.weight; $("weightV").textContent = data.params.weight;
      $("relCutoff").value = data.params.relCutoff; $("parentBoost").value = data.params.parentBoost;
      $("threshold").value = data.params.threshold; $("pgmc").value = data.params.pgmc;
    }
    state.data = data;
    $("status").textContent = `file ${data.durations.file}ms · chunk ${data.durations.chunk}ms`;
    render();
  } catch (e) { $("status").textContent = ""; $("view").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

function render() {
  const d = state.data; if (!d) return;
  renderHead(d);
  if (state.tab === "graph") { $("view").innerHTML = `<div class="legend"></div><div id="cy"></div>`; drawGraph(); return; }
  const stages = state.tab === "file" ? d.file : d.chunk;
  $("view").innerHTML = missedPanel(d, stages) + stages.map((s) => renderStage(s, d)).join("");
  for (const s of $("view").querySelectorAll("details")) s.open = true;
}

function renderHead(d) {
  const rankStage = (state.tab === "file" ? d.file : d.chunk).find((s) => s.name === (state.tab === "file" ? "ranked" : "chunkScored"));
  const list = rankStage ? rankStage.payload : [];
  const golds = d.goldFiles.map((g) => `<span style="margin-right:14px">${esc(g.split("/").pop())} ${badge(rankIn(list, g))}</span>`).join("");
  let lineNote = "";
  if (state.tab === "chunk") lineNote = `<div class="meta">${lineCoverage(d)}</div>`;
  $("head").innerHTML = `<div class="qbox"><div class="q">${esc(d.query)}</div>
    <div class="meta">${d.repo} · mode <b>${d.mode}</b> · ${d.goldFiles.length} gold files</div>
    <div class="meta">${golds}</div>${lineNote}</div>`;
}

function lineCoverage(d) {
  const fin = d.chunk.find((s) => s.name === "final"); if (!fin) return "";
  const goldLines = new Map();
  for (const g of d.gold) { const s = goldLines.get(g.file) || new Set(); for (let i = g.start; i <= g.end; i++) s.add(i); goldLines.set(g.file, s); }
  const tot = [...goldLines.values()].reduce((a, s) => a + s.size, 0);
  let coveredL = 0, predL = 0;
  for (const c of fin.payload) {
    if (c.startLine == null) continue; predL += (c.endLine - c.startLine + 1);
    for (const [f, set] of goldLines) if (hit(c.path, f)) for (let i = c.startLine; i <= c.endLine; i++) if (set.has(i)) coveredL++;
  }
  return `gold-line coverage: ${coveredL}/${tot} (${tot ? (coveredL / tot * 100).toFixed(0) : 0}%) · returned ${predL} lines`;
}

function missedPanel(d, stages) {
  const rankStage = stages.find((s) => s.name === (state.tab === "file" ? "ranked" : "chunkScored"));
  if (!rankStage) return "";
  const vec = (stages.find((s) => s.name.startsWith("vector")) || {}).payload || [];
  const txt = (stages.find((s) => s.name.startsWith("text")) || {}).payload || [];
  const missed = d.goldFiles.map((g) => ({ g, r: rankIn(rankStage.payload, g) })).filter((x) => x.r === 0 || x.r > 8);
  if (!missed.length) return `<div class="qbox"><span class="badge b-found">all gold in top-8</span></div>`;
  const rows = missed.map(({ g, r }) => {
    const vr = rankIn(vec, g), tr = rankIn(txt, g);
    const why = vr === 0 && tr === 0 ? "not retrieved by either channel"
      : `vector ${vr || "—"} · keyword ${tr || "—"}`;
    return `<tr><td class="path">${esc(g.split("/").pop())}</td><td>${badge(r)}</td><td><small>${why}</small></td></tr>`;
  }).join("");
  return `<div class="miss-panel"><h3>missed / deep gold (${missed.length})</h3><table>${rows}</table></div>`;
}

function renderStage(s, d) {
  const n = s.name;
  let inner, count = "";
  if (n === "boosts") { inner = boostsTable(s.payload, d.goldFiles); count = "path → filename → graph"; }
  else if (n === "symbols") {
    const p = s.payload;
    inner = `<small>identifiers: ${p.identifiers.length ? p.identifiers.map(esc).join(", ") : "(none)"} · injected: ${p.hits.length}</small>`
      + (p.hits.length ? listTable(p.hits.map((h) => ({ path: h, score: null })), d) : "");
  }
  else if (Array.isArray(s.payload)) { inner = listTable(s.payload, d); count = `${s.payload.length} rows`; }
  else { inner = kvTable(s.payload); }
  return `<details class="stage"><summary>${esc(n)} <span class="n">${count}</span></summary><div class="body">${inner}</div></details>`;
}

function listTable(list, d) {
  if (!list.length) return `<small>(empty)</small>`;
  const hasChunk = list.some((r) => r.chunkIndex !== undefined);
  const hasLine = list.some((r) => r.startLine != null);
  const head = `<tr><th>#</th><th>score</th>${hasLine ? "<th>lines</th>" : ""}${hasChunk ? "<th>chunk</th>" : ""}<th>path</th><th>entity</th></tr>`;
  const rows = list.map((r, i) => {
    const g = isGoldP(r.path, d.goldFiles);
    const sc = r.score == null ? "" : Number(r.score).toFixed(4);
    const ln = hasLine ? `<td>${r.startLine != null ? r.startLine + "-" + r.endLine : ""}</td>` : "";
    const ch = hasChunk ? `<td>${r.chunkIndex}</td>` : "";
    return `<tr class="${g ? "gold" : ""}"><td>${i + 1}</td><td class="score">${sc}</td>${ln}${ch}<td class="path">${esc(relOf(r.path, d.dir))}${g ? '<span class="badge b-gold">gold</span>' : ""}</td><td><small>${esc(r.entityName || "")}</small></td></tr>`;
  }).join("");
  return `<table>${head}${rows}</table>`;
}

function boostsTable(payload, goldFiles) {
  const m = new Map();
  const put = (arr, key) => arr.forEach((r) => { const o = m.get(r.path) || { path: r.path }; o[key] = r.score; m.set(r.path, o); });
  put(payload.path, "p"); put(payload.filename, "f"); put(payload.graph, "g");
  const rows = [...m.values()].sort((a, b) => (b.g ?? 0) - (a.g ?? 0)).slice(0, 60).map((o) => {
    const gold = isGoldP(o.path, goldFiles);
    const f = (v) => v == null ? "" : v.toFixed(4);
    return `<tr class="${gold ? "gold" : ""}"><td class="score">${f(o.p)}</td><td class="score">${f(o.f)}</td><td class="score">${f(o.g)}</td><td class="path">${esc(o.path.split("/").slice(-2).join("/"))}${gold ? '<span class="badge b-gold">gold</span>' : ""}</td></tr>`;
  }).join("");
  return `<table><tr><th>path↑</th><th>+filename</th><th>+graph</th><th>file</th></tr>${rows}</table>`;
}

function kvTable(obj) {
  return `<table>${Object.entries(obj).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(4)) : JSON.stringify(v))}</td></tr>`).join("")}</table>`;
}

async function drawGraph() {
  const p = new URLSearchParams({ instance: state.instance, includeFix: state.includeFix, k: $("kchunk").value });
  const g = await (await fetch("/api/graph?" + p)).json();
  if (g.error) { $("view").innerHTML = `<div class="err">${esc(g.error)}</div>`; return; }
  document.querySelector("#view .legend").innerHTML =
    `<b>${g.nodes.length}</b> nodes · <b>${g.edges.length}</b> edges · co-change: ${g.coSource} ` +
    `&nbsp;|&nbsp; <span style="color:var(--gold)">●</span> gold &nbsp; <span style="color:var(--acc)">●</span> retrieved &nbsp; <span style="color:var(--dim)">●</span> neighbour &nbsp; — import &nbsp; ┄ co-change`;
  const elements = [
    ...g.nodes.map((n) => ({ data: { id: n.id, label: n.label + (n.rank ? ` #${n.rank}` : ""), kind: n.kind } })),
    ...g.edges.map((e, i) => ({ data: { id: "e" + i, source: e.source, target: e.target, type: e.type, gg: e.goldGold } })),
  ];
  cytoscape({
    container: $("cy"), elements,
    style: [
      { selector: "node", style: { "label": "data(label)", "color": "#d7dbe2", "font-size": "9px", "background-color": "#8b93a3", "width": 14, "height": 14, "text-wrap": "wrap", "text-max-width": "90px" } },
      { selector: 'node[kind="gold"]', style: { "background-color": "#e0b341", "width": 22, "height": 22, "font-size": "11px" } },
      { selector: 'node[kind="retrieved"]', style: { "background-color": "#5aa0f2" } },
      { selector: "edge", style: { "width": 1, "line-color": "#3a4150", "curve-style": "bezier" } },
      { selector: 'edge[type="cochange"]', style: { "line-style": "dashed", "line-color": "#6a5a8a" } },
      { selector: "edge[?gg]", style: { "width": 3, "line-color": "#e0b341" } },
    ],
    layout: { name: "cose", animate: false, nodeRepulsion: 9000, idealEdgeLength: 70 },
  });
}

boot();
