/**
 * Symbol-level call-graph walks backing the `impact` and `trace` tools.
 *
 * The DB layer already resolves cross-file refs (symbol_refs.resolved_export_id)
 * and exposes forward edges (getCalleeRefs*) and reverse edges (getCallersOf*).
 * This module turns those into two queries an agent actually asks:
 *
 *   - impact(symbol)        — transitive callers as a pruned tree (blast radius)
 *   - trace(from → to)      — the reachable sub-graph of every path from→to
 *
 * Both share one node model and one renderer. Resolution is static name-match:
 * a callee/caller that doesn't resolve to an indexed callable is a leaf, so a
 * dynamic-dispatch hop (callback, interface→impl, DI) ends a chain. That limit
 * is stated to the agent in the tool output, not hidden.
 */

import { relative } from "path";
import type { RagDB } from "../db";
import type { CallableExport, CallableCandidate } from "../db/graph";
import { isTestPath } from "../utils/test-paths";

// A callable in the graph. `export` nodes carry an exportId (cross-file
// reachable); `local` nodes are module-private (same-file callers only).
export interface CallNode {
  kind: "export" | "local";
  exportId: number | null;
  name: string;
  fileId: number;
  filePath: string;
  startLine: number | null;
}

export function nodeKey(n: CallNode): string {
  return n.kind === "export" ? `e:${n.exportId}` : `l:${n.fileId}:${n.name}`;
}

// A callable called by more than this many distinct places is a popular
// utility — cited, not expanded, so it doesn't explode a walk. Measured
// per-export (countInboundRefsByExport), NOT by name: a common method name
// like `search` must not inherit a project-wide count and get pruned wrongly.
const AMBIENT_FANIN = 25;

/** Cached view over the graph for one walk: export lookups + inbound counts. */
class CallGraph {
  private exportsById = new Map<number, CallableExport>();
  private exportsByKey = new Map<string, CallableExport>();
  private inbound: Map<number, number>;
  private calleesCache = new Map<string, CallNode[]>();
  private callersCache = new Map<string, CallNode[]>();

  constructor(public db: RagDB) {
    for (const ex of db.getCallableExports()) {
      this.exportsById.set(ex.exportId, ex);
      this.exportsByKey.set(`${ex.fileId}:${ex.name}`, ex);
    }
    this.inbound = db.countInboundRefsByExport(new Set());
  }

  private fromExport(ex: CallableExport): CallNode {
    return {
      kind: "export",
      exportId: ex.exportId,
      name: ex.name,
      fileId: ex.fileId,
      filePath: ex.filePath,
      startLine: ex.startLine,
    };
  }

  // Inbound count for this specific callable. Locals (same-file only) are
  // never ambient — their caller set is naturally small.
  inboundOf(n: CallNode): number {
    return n.kind === "export" && n.exportId != null ? this.inbound.get(n.exportId) ?? 0 : 0;
  }
  isAmbient(n: CallNode): boolean {
    return this.inboundOf(n) > AMBIENT_FANIN;
  }

  /** Outgoing edges: callables this node calls. Unresolved / non-callable
   *  refs are dropped (leaves). Deduped by node; self-edges removed. */
  callees(n: CallNode): CallNode[] {
    const ck = nodeKey(n);
    const cached = this.calleesCache.get(ck);
    if (cached) return cached;
    const refs =
      n.kind === "export" && n.exportId != null
        ? this.db.getCalleeRefsForExport(n.exportId)
        : this.db.getCalleeRefsForLocalSymbol(n.fileId, n.name);
    const out = new Map<string, CallNode>();
    for (const ref of refs) {
      let node: CallNode | null = null;
      if (ref.resolvedExportId != null) {
        const ex = this.exportsById.get(ref.resolvedExportId);
        if (ex) node = this.fromExport(ex);
      }
      if (!node) {
        // Same-file private helper the chunker placed but file_exports never saw.
        const loc = this.db.getLocalCallable(n.fileId, ref.name);
        if (loc) {
          node = {
            kind: "local",
            exportId: null,
            name: loc.name,
            fileId: loc.fileId,
            filePath: loc.filePath,
            startLine: loc.startLine,
          };
        }
      }
      if (node) {
        const k = nodeKey(node);
        if (k !== nodeKey(n)) out.set(k, node);
      }
    }
    const result = [...out.values()];
    this.calleesCache.set(ck, result);
    return result;
  }

  /** Incoming edges: callables that call this node. Deduped; self/recursion
   *  removed (a function listing itself as its own caller is noise). */
  callers(n: CallNode): CallNode[] {
    const ck = nodeKey(n);
    const cached = this.callersCache.get(ck);
    if (cached) return cached;
    const rows =
      n.kind === "export" && n.exportId != null
        ? this.db.getCallersOfExport(n.exportId)
        : this.db.getCallersOfLocalSymbol(n.fileId, n.name);
    const out = new Map<string, CallNode>();
    for (const r of rows) {
      if (!r.callerName) continue;
      if (r.callerName === n.name && r.fileId === n.fileId) continue;
      const ex = this.exportsByKey.get(`${r.fileId}:${r.callerName}`);
      const node: CallNode = ex
        ? this.fromExport(ex)
        : {
            kind: "local",
            exportId: null,
            name: r.callerName,
            fileId: r.fileId,
            filePath: r.filePath,
            startLine: r.startLine,
          };
      const k = nodeKey(node);
      if (k !== nodeKey(n)) out.set(k, node);
    }
    const result = [...out.values()];
    this.callersCache.set(ck, result);
    return result;
  }
}

// Every impact/trace/callees call used to build a fresh CallGraph (all
// callable exports + a full inbound-count scan). Cache per RagDB, invalidated
// by a cheap version signature over the graph tables.
const graphCache = new WeakMap<RagDB, { sig: string; g: CallGraph }>();

function getCallGraph(db: RagDB): CallGraph {
  const sig = db.getGraphVersionSignature();
  const cached = graphCache.get(db);
  if (cached && cached.sig === sig) return cached.g;
  const g = new CallGraph(db);
  graphCache.set(db, { sig, g });
  return g;
}

// ── Symbol resolution ────────────────────────────────────────────

export interface SymbolResolution {
  status: "ok" | "not_found" | "ambiguous";
  node?: CallNode;
  candidates?: CallableCandidate[];
}

function candToNode(c: CallableCandidate): CallNode {
  return {
    kind: c.isExport ? "export" : "local",
    exportId: c.exportId,
    name: c.name,
    fileId: c.fileId,
    filePath: c.filePath,
    startLine: c.startLine,
  };
}

/** Resolve a `symbol` (+ optional `file`) to one callable, or report
 *  not-found / ambiguous so the tool can ask the agent to disambiguate. */
export function resolveSymbol(db: RagDB, name: string, file?: string): SymbolResolution {
  let candidates = db.getCallablesByName(name);
  if (file) {
    // Match on a path-segment boundary: a raw suffix match let `file: "db.ts"`
    // also match "indexed-db.ts", and when exactly one WRONG candidate
    // survived, impact/trace ran on it with status "ok" and no warning.
    const norm = file.replace(/\\/g, "/").replace(/^\.\//, "");
    candidates = candidates.filter((c) => {
      const p = c.filePath.replace(/\\/g, "/");
      return p === norm || p.endsWith("/" + norm);
    });
  }
  if (candidates.length === 0) return { status: "not_found" };

  // Collapse an export and a same-name local in the same file to the export.
  const uniq = new Map<string, CallableCandidate>();
  for (const c of candidates) {
    const k = `${c.fileId}:${c.name}`;
    const existing = uniq.get(k);
    if (!existing || (c.isExport && !existing.isExport)) uniq.set(k, c);
  }
  candidates = [...uniq.values()];

  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "ok", node: candToNode(candidates[0]) };
}

// ── Tree model (shared by impact + trace rendering) ──────────────

export interface TreeNode {
  node: CallNode;
  children: TreeNode[];
  seen?: boolean; // already shown elsewhere in the tree — not re-expanded
  ambient?: boolean; // high fan-in — cited, not expanded
}

// ── impact: transitive callers ───────────────────────────────────

export interface ImpactResult {
  root: CallNode;
  tree: TreeNode; // root, with callers as descendants
  shownCallers: number; // distinct callers actually printed in the bounded tree
  totalCallers: number; // true distinct transitive callers (ignores depth/budget/ambient)
  totalFiles: number; // distinct files those callers live in
  totalCapped: boolean; // count walk hit its cap → totalCallers is a lower bound
  maxDepth: number;
  truncated: boolean; // tree shows fewer than the total (depth / budget / ambient)
  ambientNames: Map<string, number>; // cited-but-not-expanded → inbound count
}

// The count walk is cheap (visited-set only, no tree, edges memoised) but still
// bounded so a pathological hot symbol can't run unbounded — past this the
// reported total is "≥N".
const COUNT_CAP = 2000;

export function impactWalk(
  db: RagDB,
  root: CallNode,
  opts: { maxDepth?: number; budget?: number } = {},
): ImpactResult {
  const maxDepth = opts.maxDepth ?? 3;
  const budget = opts.budget ?? 80;
  const g = getCallGraph(db);

  // ── Display pass: a bounded tree (depth + budget + ambient-prune). What an
  //    agent reads. The most direct callers survive when the budget runs out. ──
  const visited = new Set<string>([nodeKey(root)]);
  const shown = new Set<string>();
  const ambientNames = new Map<string, number>();
  let expanded = 0;
  let truncated = false;

  const tree: TreeNode = { node: root, children: [] };
  const queue: { tn: TreeNode; depth: number }[] = [{ tn: tree, depth: 0 }];
  while (queue.length > 0) {
    const { tn, depth } = queue.shift()!;
    const callers = g.callers(tn.node);
    if (depth >= maxDepth) {
      if (callers.length > 0) truncated = true;
      continue;
    }
    for (const c of callers) {
      const k = nodeKey(c);
      shown.add(k);
      const child: TreeNode = { node: c, children: [] };
      tn.children.push(child);
      if (visited.has(k)) {
        child.seen = true;
        continue;
      }
      visited.add(k);
      if (g.isAmbient(c)) {
        child.ambient = true;
        ambientNames.set(c.name, g.inboundOf(c));
        truncated = true;
        continue;
      }
      if (expanded >= budget) {
        truncated = true;
        continue;
      }
      expanded++;
      queue.push({ tn: child, depth: depth + 1 });
    }
  }

  // ── Count pass: the true transitive caller set (no depth/budget/ambient), so
  //    the headline number is honest even when the printed tree is bounded.
  //    Reuses the memoised edges from the display pass — no extra DB cost for
  //    overlapping nodes. ──
  const counted = new Set<string>([nodeKey(root)]);
  const files = new Set<number>();
  let totalCapped = false;
  const cq: CallNode[] = [root];
  while (cq.length > 0 && !totalCapped) {
    const n = cq.shift()!;
    for (const c of g.callers(n)) {
      const k = nodeKey(c);
      if (counted.has(k)) continue;
      if (counted.size > COUNT_CAP) {
        totalCapped = true;
        break;
      }
      counted.add(k);
      files.add(c.fileId);
      cq.push(c);
    }
  }

  return {
    root,
    tree,
    shownCallers: shown.size,
    // Guard against count-cap ordering ever reporting fewer than we displayed.
    totalCallers: Math.max(counted.size - 1, shown.size),
    totalFiles: files.size,
    totalCapped,
    maxDepth,
    truncated,
    ambientNames,
  };
}

/**
 * Direct callees of a symbol — the functions/methods it calls, one hop out, with
 * each call resolved to its definition. The forward complement of `usages`
 * (which is callers, one hop in). Deduped by node identity.
 */
export function directCallees(db: RagDB, root: CallNode): CallNode[] {
  const g = getCallGraph(db);
  const seen = new Set<string>();
  const out: CallNode[] = [];
  for (const c of g.callees(root)) {
    const k = nodeKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// ── trace: reachable sub-graph from → to ─────────────────────────

export interface TraceResult {
  from: CallNode;
  to: CallNode;
  found: boolean;
  spine: CallNode[]; // shortest path from→to (inclusive); [] when not found
  tree: TreeNode | null; // forward tree over the reachable sub-graph
  subgraphSize: number;
  truncated: boolean;
  forwardFrontier?: CallNode[]; // deepest nodes reached from `from` (no-path case)
  backwardFrontier?: CallNode[]; // direct callers of `to` (no-path case)
}

interface BfsResult {
  nodes: Map<string, { node: CallNode; dist: number }>;
  truncated: boolean;
  maxDist: number;
}

function bfs(
  g: CallGraph,
  start: CallNode,
  dir: "callees" | "callers",
  maxDepth: number,
  budget: number,
): BfsResult {
  const nodes = new Map<string, { node: CallNode; dist: number }>();
  nodes.set(nodeKey(start), { node: start, dist: 0 });
  const queue: { node: CallNode; dist: number }[] = [{ node: start, dist: 0 }];
  let truncated = false;
  let maxDist = 0;
  while (queue.length > 0) {
    const { node, dist } = queue.shift()!;
    if (dist >= maxDepth) continue;
    const next = dir === "callees" ? g.callees(node) : g.callers(node);
    for (const c of next) {
      const k = nodeKey(c);
      if (nodes.has(k)) continue;
      if (nodes.size >= budget) {
        truncated = true;
        continue;
      }
      nodes.set(k, { node: c, dist: dist + 1 });
      maxDist = Math.max(maxDist, dist + 1);
      queue.push({ node: c, dist: dist + 1 });
    }
  }
  return { nodes, truncated, maxDist };
}

export function tracePath(
  db: RagDB,
  from: CallNode,
  to: CallNode,
  opts: { budget?: number } = {},
): TraceResult {
  // Reachability is determined with an UNCAPPED search, so connectivity is never
  // a false negative: if any path exists it is found. The visited-set in `bfs`
  // bounds the walk to the graph size, so "uncapped" still terminates. `budget`
  // only limits how much of the connecting sub-graph is rendered for display —
  // it does not gate whether a connection is found.
  const displayBudget = opts.budget ?? 300;
  const g = getCallGraph(db);
  const fromK = nodeKey(from);
  const toK = nodeKey(to);

  if (fromK === toK) {
    return {
      from,
      to,
      found: true,
      spine: [from],
      tree: { node: from, children: [] },
      subgraphSize: 1,
      truncated: false,
    };
  }

  // A node lies on some from→to path iff `from` reaches it (forward) AND it
  // reaches `to` (backward-reachable from `to`). Intersect the two FULL reaches.
  const fwd = bfs(g, from, "callees", Infinity, Infinity);
  const bwd = bfs(g, to, "callers", Infinity, Infinity);

  const sub = new Set<string>();
  for (const k of fwd.nodes.keys()) if (bwd.nodes.has(k)) sub.add(k);

  if (!sub.has(fromK) || !sub.has(toK)) {
    return {
      from,
      to,
      found: false,
      spine: [],
      tree: null,
      subgraphSize: 0,
      truncated: false, // reachability was complete — this is a definitive no-path
      forwardFrontier: [...fwd.nodes.values()]
        .filter((v) => v.dist === fwd.maxDist && v.dist > 0)
        .map((v) => v.node)
        .slice(0, 8),
      backwardFrontier: g.callers(to).slice(0, 8),
    };
  }

  const nodeOf = new Map<string, CallNode>();
  for (const [k, v] of fwd.nodes) nodeOf.set(k, v.node);

  // Forward adjacency restricted to the sub-graph.
  const adj = new Map<string, CallNode[]>();
  for (const k of sub) {
    const kids = g.callees(nodeOf.get(k)!).filter((c) => sub.has(nodeKey(c)));
    adj.set(k, kids);
  }

  const spine = shortestPath(adj, nodeOf, fromK, toK);

  // Display pass: forward tree from `from`, bounded by a node budget so a huge
  // connecting sub-graph can't blow the output. The shortest-path spine is
  // always kept; other nodes fill the remaining budget. `subgraphSize` still
  // reports the TRUE connecting size even when the drawn tree is truncated.
  const spineKeys = new Set(spine.map(nodeKey));
  const placed = new Set<string>();
  let rendered = 0;
  let displayTruncated = false;
  const build = (k: string): TreeNode => {
    const tn: TreeNode = { node: nodeOf.get(k)!, children: [] };
    if (placed.has(k)) {
      tn.seen = true;
      return tn;
    }
    placed.add(k);
    if (k === toK) return tn; // target is a leaf
    for (const c of adj.get(k) ?? []) {
      const ck = nodeKey(c);
      if (!spineKeys.has(ck) && rendered >= displayBudget) {
        displayTruncated = true;
        continue;
      }
      rendered++;
      tn.children.push(build(ck));
    }
    return tn;
  };
  const tree = build(fromK);

  return { from, to, found: true, spine, tree, subgraphSize: sub.size, truncated: displayTruncated };
}

function shortestPath(
  adj: Map<string, CallNode[]>,
  nodeOf: Map<string, CallNode>,
  fromK: string,
  toK: string,
): CallNode[] {
  const prev = new Map<string, string>();
  const seen = new Set([fromK]);
  const queue = [fromK];
  while (queue.length > 0) {
    const k = queue.shift()!;
    if (k === toK) break;
    for (const c of adj.get(k) ?? []) {
      const ck = nodeKey(c);
      if (seen.has(ck)) continue;
      seen.add(ck);
      prev.set(ck, k);
      queue.push(ck);
    }
  }
  if (!seen.has(toK)) return [];
  const path: CallNode[] = [];
  let cur: string | undefined = toK;
  while (cur) {
    path.unshift(nodeOf.get(cur)!);
    cur = prev.get(cur);
  }
  return path;
}

// ── Test-impact (impact's "Tests to run" section) ────────────────

export interface TestImpact {
  precise: string[]; // test files that reference the symbol by name
  broad: string[]; // test files that transitively import the target's file
}

/**
 * All file ids that transitively import any of `seedFileIds` (seeds included).
 * File-level; the visited set guarantees termination, so no depth cap is
 * needed. Shared by collectTests (impact's broad tests) and the `affected` CLI.
 */
export function transitiveImporters(db: RagDB, seedFileIds: number[]): Set<number> {
  const closure = new Set<number>(seedFileIds);
  let frontier = [...seedFileIds];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const fid of frontier) {
      for (const importer of db.getImportersOf(fid)) {
        if (!closure.has(importer)) {
          closure.add(importer);
          next.push(importer);
        }
      }
    }
    frontier = next;
  }
  return closure;
}

export function collectTests(db: RagDB, root: CallNode, projectDir: string): TestImpact {
  const graph = db.getGraph();
  const idToPath = new Map<number, string>();
  const testPaths: string[] = [];
  for (const n of graph.nodes) {
    idToPath.set(n.id, n.path);
    if (isTestPath(n.path)) testPaths.push(n.path);
  }

  // Precise: test files naming the symbol.
  const preciseAbs = [...new Set(db.getSymbolReferencesByName([root.name], testPaths).map((r) => r.file))];
  const preciseSet = new Set(preciseAbs);

  // Broad: transitive file-level importers of the target's file, kept if a test.
  const closure = transitiveImporters(db, [root.fileId]);
  const broadAbs: string[] = [];
  for (const fid of closure) {
    const p = idToPath.get(fid);
    if (p && isTestPath(p) && !preciseSet.has(p)) broadAbs.push(p);
  }

  const rel = (p: string) => relative(projectDir, p) || p;
  return {
    precise: preciseAbs.map(rel).sort(),
    broad: broadAbs.map(rel).sort(),
  };
}

export interface AffectedTests {
  changed: string[]; // input files found in the index
  unknown: string[]; // input files not in the index (skipped)
  tests: string[]; // test files transitively importing any changed file
}

/**
 * Test files affected by a set of changed files — the core of the `affected`
 * CLI. Walks importers of the changed files transitively and keeps the tests.
 * `changedAbsPaths` must be absolute: the caller resolves per input mode
 * (git-root-relative for auto-detect, cwd-relative for args/stdin).
 */
export function affectedTests(db: RagDB, changedAbsPaths: string[], projectDir: string): AffectedTests {
  const idToPath = new Map<number, string>();
  for (const n of db.getGraph().nodes) idToPath.set(n.id, n.path);

  const rel = (p: string) => relative(projectDir, p) || p;
  const changedIds: number[] = [];
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const abs of changedAbsPaths) {
    const rec = db.getFileByPath(abs);
    if (rec) {
      changedIds.push(rec.id);
      changed.push(rel(abs));
    } else {
      unknown.push(rel(abs));
    }
  }

  const tests: string[] = [];
  for (const fid of transitiveImporters(db, changedIds)) {
    const p = idToPath.get(fid);
    if (p && isTestPath(p)) tests.push(rel(p));
  }

  return { changed: changed.sort(), unknown: unknown.sort(), tests: tests.sort() };
}

// ── Rendering ────────────────────────────────────────────────────

function rel(projectDir: string, p: string): string {
  return relative(projectDir, p) || p;
}

function loc(projectDir: string, n: CallNode): string {
  const line = n.startLine != null ? `:${n.startLine}` : "";
  return `${rel(projectDir, n.filePath)}${line}`;
}

function renderTreeNode(
  tn: TreeNode,
  depth: number,
  projectDir: string,
  lines: string[],
  targetKey?: string,
): void {
  const indent = "  ".repeat(depth);
  let suffix = "";
  if (tn.seen) suffix = "  (↑ seen above)";
  else if (tn.ambient) suffix = "  (ambient — not expanded)";
  if (targetKey && nodeKey(tn.node) === targetKey) suffix += "  ◀ target";
  lines.push(`${indent}${tn.node.name}  ${loc(projectDir, tn.node)}${suffix}`);
  for (const c of tn.children) renderTreeNode(c, depth + 1, projectDir, lines, targetKey);
}

export function renderImpact(res: ImpactResult, projectDir: string, tests: TestImpact): string {
  const r = res.root;
  if (res.totalCallers === 0) {
    const note =
      r.kind === "local"
        ? " It is not exported, so only same-file callers are tracked."
        : " It looks like an entry point, or is only reached via dynamic dispatch (callback / interface / DI).";
    return `${r.name}  ${loc(projectDir, r)}\n\nNo callers found in the index.${note}`;
  }

  const lines: string[] = [];
  const totalStr = res.totalCapped ? `≥${res.totalCallers}` : `${res.totalCallers}`;
  const partial = res.shownCallers < res.totalCallers;
  let header = `${r.name}  ${loc(projectDir, r)} — called by ${totalStr} symbol${
    res.totalCallers !== 1 ? "s" : ""
  } across ${res.totalFiles} file${res.totalFiles !== 1 ? "s" : ""}`;
  header += partial ? `; showing the ${res.shownCallers} nearest (depth ≤ ${res.maxDepth}):` : ":";
  lines.push(header);

  for (const child of res.tree.children) renderTreeNode(child, 1, projectDir, lines);

  if (res.ambientNames.size > 0) {
    const parts = [...res.ambientNames.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${n} (${c} callers)`);
    lines.push("", `── ambient (high fan-in, not expanded): ${parts.join(", ")} ──`);
  }
  if (partial) {
    lines.push(`── raise \`hops\`, pass \`file\`, or run impact on a node above to expand the rest ──`);
  }

  lines.push("", renderTests(tests));
  lines.push("", `── Tip: read_relevant("${r.name}") for the code, or usages("${r.name}") for every raw reference. ──`);
  return lines.join("\n");
}

export function renderTests(t: TestImpact): string {
  const total = t.precise.length + t.broad.length;
  if (total === 0) {
    return "Tests to run: none found (no indexed test references or imports the affected code).";
  }
  const CAP = 25;
  const lines = [`Tests to run: ${total}`];
  const block = (label: string, files: string[]) => {
    if (files.length === 0) return;
    lines.push(`  ${label}:`);
    for (const p of files.slice(0, CAP)) lines.push(`    ${p}`);
    if (files.length > CAP) lines.push(`    … +${files.length - CAP} more`);
  };
  block("precise (reference the symbol)", t.precise);
  block("broad (import affected files)", t.broad);
  return lines.join("\n");
}

export function renderTrace(res: TraceResult, projectDir: string): string {
  if (nodeKey(res.from) === nodeKey(res.to)) {
    return `${res.from.name} and ${res.to.name} resolve to the same symbol — nothing to trace.`;
  }
  if (!res.found) {
    const lines = [
      `No call path from ${res.from.name} to ${res.to.name} (searched the full reachable graph).`,
      `Resolution is static — a dynamic-dispatch hop (callback, interface→impl, DI) breaks the chain. Try read_relevant around the gap.`,
    ];
    if (res.forwardFrontier?.length) {
      lines.push("", `From ${res.from.name}, deepest reached:`);
      for (const n of res.forwardFrontier) lines.push(`  ${n.name}  ${loc(projectDir, n)}`);
    }
    if (res.backwardFrontier?.length) {
      lines.push("", `Direct callers of ${res.to.name}:`);
      for (const n of res.backwardFrontier) lines.push(`  ${n.name}  ${loc(projectDir, n)}`);
    }
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push(
    `Trace  ${res.from.name} ⇒ ${res.to.name}  (reachable sub-graph: ${res.subgraphSize} node${
      res.subgraphSize !== 1 ? "s" : ""
    })`,
    "",
  );
  renderTreeNode(res.tree!, 0, projectDir, lines, nodeKey(res.to));
  const hops = res.spine.length - 1;
  lines.push("", `spine (shortest): ${res.spine.map((n) => n.name).join(" → ")}  (${hops} hop${hops !== 1 ? "s" : ""})`);
  if (res.truncated) lines.push(`── drawn sub-graph capped at the node budget; the full connecting set is ${res.subgraphSize} nodes ──`);
  return lines.join("\n");
}

// ── JSON output ──────────────────────────────────────────────────

function nodeJson(projectDir: string, n: CallNode) {
  return { name: n.name, kind: n.kind, file: rel(projectDir, n.filePath), line: n.startLine };
}

function treeJson(projectDir: string, tn: TreeNode): unknown {
  return {
    ...nodeJson(projectDir, tn.node),
    ...(tn.seen ? { seen: true } : {}),
    ...(tn.ambient ? { ambient: true } : {}),
    children: tn.children.map((c) => treeJson(projectDir, c)),
  };
}

export function impactToJson(res: ImpactResult, tests: TestImpact, projectDir: string) {
  return {
    root: nodeJson(projectDir, res.root),
    shownCallers: res.shownCallers,
    totalCallers: res.totalCallers,
    totalCapped: res.totalCapped,
    totalFiles: res.totalFiles,
    maxDepth: res.maxDepth,
    truncated: res.truncated,
    ambient: [...res.ambientNames.entries()].map(([name, callers]) => ({ name, callers })),
    callers: res.tree.children.map((c) => treeJson(projectDir, c)),
    tests,
  };
}

export function traceToJson(res: TraceResult, projectDir: string) {
  return {
    from: nodeJson(projectDir, res.from),
    to: nodeJson(projectDir, res.to),
    found: res.found,
    subgraphSize: res.subgraphSize,
    truncated: res.truncated,
    spine: res.spine.map((n) => nodeJson(projectDir, n)),
    tree: res.tree ? treeJson(projectDir, res.tree) : null,
    forwardFrontier: res.forwardFrontier?.map((n) => nodeJson(projectDir, n)),
    backwardFrontier: res.backwardFrontier?.map((n) => nodeJson(projectDir, n)),
  };
}
