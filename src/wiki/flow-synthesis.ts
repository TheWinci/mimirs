import { createHash } from "crypto";
import type {
  CommunityBundle,
  DataFlowBundle,
  DiscoveryResult,
  FlowSpec,
  FlowsFile,
  ServiceProfile,
  SynthesesFile,
} from "./types";
import type { RagDB } from "../db";

/**
 * Phase 3: Flow synthesis (data-flows split).
 *
 * Two-phase pipeline mirrors community synthesis:
 *
 * - **Phase A (LLM):** `renderFlowDiscoveryPrompt` builds a payload of
 *   entry-point candidates (HTTP routes, scheduled jobs, queue
 *   consumers) plus top hubs and architectural annotations. The
 *   calling LLM (Claude) names 2-6 flows and posts back via
 *   `write_flows`. Result persists to `_meta/_flows.json`.
 * - **Phase B (deterministic):** `buildDataFlowBundleFor` walks the
 *   project's import graph from each flow's trigger symbol and
 *   produces a callee-chain BFS that the writer LLM uses to render
 *   the sequence diagram.
 *
 * `find_usages` is *not* used: it returns callers (def→caller) but
 * sequence diagrams need callees (handler→service→repo). Callee
 * chains come from `db.getDependsOnForFiles` + per-line symbol
 * resolution.
 */

const FLOW_CHAIN_MAX_DEPTH = 6;
const FLOW_CHAIN_MAX_NODES = 40;

export interface FlowDiscoveryInput {
  /** Distinct HTTP triggers across all communities, keyed by `METHOD path`. */
  routes: { method: string; path: string; handlerSymbol: string | null; file: string; line: number; communitySlug: string }[];
  /** Scheduled-job triggers. */
  scheduledJobs: { schedule: string; handler: string | null; file: string; line: number; communitySlug: string }[];
  /** Queue consumers as message-driven entry points. */
  consumers: { topic: string; file: string; line: number; communitySlug: string }[];
  /** Top hubs — load-bearing files most flows pass through. */
  topHubs: string[];
  /** Architectural annotations (from existing wiki annotations). */
  annotations: { file: string; line: number; note: string }[];
  /** Community slugs available for flow attribution. */
  communitySlugs: string[];
}

/**
 * Build the Phase-A discovery input from existing per-community
 * service signals. Returns null when too few triggers exist for flow
 * synthesis to be useful — caller falls back to single-page
 * `data-flows.md` rendering.
 */
export function buildFlowDiscoveryInput(
  bundles: CommunityBundle[],
  syntheses: SynthesesFile,
  discovery: DiscoveryResult,
  threshold: number,
): FlowDiscoveryInput | null {
  const slugByCommunityId = new Map<string, string>();
  for (const [id, p] of Object.entries(syntheses.payloads)) slugByCommunityId.set(id, p.slug);

  const routes: FlowDiscoveryInput["routes"] = [];
  const scheduledJobs: FlowDiscoveryInput["scheduledJobs"] = [];
  const consumers: FlowDiscoveryInput["consumers"] = [];
  const annotations: FlowDiscoveryInput["annotations"] = [];

  for (const b of bundles) {
    const slug = slugByCommunityId.get(b.communityId) ?? b.communityId;
    if (b.serviceSignals) {
      for (const r of b.serviceSignals.routes) {
        routes.push({ ...r, communitySlug: slug });
      }
      for (const j of b.serviceSignals.scheduledJobs) {
        scheduledJobs.push({ ...j, communitySlug: slug });
      }
      for (const q of b.serviceSignals.queueOps) {
        if (q.kind !== "consume") continue;
        consumers.push({ topic: q.topic, file: q.file, line: q.line, communitySlug: slug });
      }
    }
    for (const a of b.annotations) {
      if (/architecture|invariant|contract/i.test(a.note)) {
        annotations.push(a);
      }
    }
  }

  const triggerCount = routes.length + scheduledJobs.length + consumers.length;
  if (triggerCount < threshold) return null;

  // Top hubs come from the architecture bundle, which isn't built yet at
  // Phase A. Approximate via fanIn ordering on the file graph.
  const topHubs = [...discovery.graphData.fileLevel.nodes]
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, 8)
    .map((n) => n.path);

  const communitySlugs = [...new Set(slugByCommunityId.values())].sort();

  return {
    routes,
    scheduledJobs,
    consumers,
    topHubs,
    annotations,
    communitySlugs,
  };
}

/**
 * Render the Phase-A LLM prompt. Output JSON shape mirrors `FlowsFile`
 * minus the fingerprint (computed server-side after acceptance).
 */
export function renderFlowDiscoveryPrompt(input: FlowDiscoveryInput): string {
  const lines: string[] = [];
  lines.push("# Flow synthesis prompt");
  lines.push("");
  lines.push(
    "Identify 2-6 *named end-to-end flows* through this service. A flow starts at a trigger (HTTP route, scheduled job, queue consumer) and ends when control returns to the trigger source or terminates the request. Pick flows by importance, not by trigger count — the goal is a navigable index a senior engineer would actually use.",
  );
  lines.push("");
  lines.push(`## Available communities (${input.communitySlugs.length})`);
  lines.push(input.communitySlugs.map((s) => `\`${s}\``).join(", "));
  lines.push("");
  if (input.routes.length > 0) {
    lines.push(`## HTTP routes (${input.routes.length})`);
    for (const r of input.routes) {
      const handler = r.handlerSymbol ? ` → \`${r.handlerSymbol}\`` : "";
      lines.push(`- \`${r.method} ${r.path}\`${handler} — \`${r.file}:${r.line}\` (community: \`${r.communitySlug}\`)`);
    }
    lines.push("");
  }
  if (input.scheduledJobs.length > 0) {
    lines.push(`## Scheduled jobs (${input.scheduledJobs.length})`);
    for (const j of input.scheduledJobs) {
      const handler = j.handler ? ` → \`${j.handler}\`` : "";
      lines.push(`- \`${j.schedule}\`${handler} — \`${j.file}:${j.line}\` (community: \`${j.communitySlug}\`)`);
    }
    lines.push("");
  }
  if (input.consumers.length > 0) {
    lines.push(`## Queue consumers (${input.consumers.length})`);
    for (const c of input.consumers) {
      lines.push(`- consume \`${c.topic}\` — \`${c.file}:${c.line}\` (community: \`${c.communitySlug}\`)`);
    }
    lines.push("");
  }
  if (input.topHubs.length > 0) {
    lines.push(`## Top hubs (load-bearing files most flows pass through)`);
    for (const h of input.topHubs) lines.push(`- \`${h}\``);
    lines.push("");
  }
  if (input.annotations.length > 0) {
    lines.push(`## Architectural annotations`);
    for (const a of input.annotations) {
      lines.push(`- \`${a.file}:${a.line}\` — ${a.note}`);
    }
    lines.push("");
  }
  lines.push(`## Your output`);
  lines.push("");
  lines.push(
    [
      "Call `write_flows(payload)` with this shape:",
      "",
      "```json",
      "{",
      '  "flows": [',
      "    {",
      '      "name": "<short title, e.g. \\"Checkout\\" or \\"User signup\\">",',
      '      "slug": "<kebab-case slug, /^[a-z0-9-]+$/>",',
      '      "purpose": "<1-2 sentences on what the flow accomplishes>",',
      '      "trigger": { "kind": "http"|"queue"|"scheduled"|"manual", "ref": "<METHOD path | topic | schedule | symbol>" },',
      '      "memberCommunities": ["<slug1>", "<slug2>", ...]',
      "    }",
      "  ]",
      "}",
      "```",
      "",
      "Pick 2-6 flows. Prefer breadth (different triggers) over depth (multiple flows from the same handler). Reference only triggers and communities listed above — do not invent.",
    ].join("\n"),
  );
  return lines.join("\n");
}

/**
 * Compute a fingerprint over the input set so warm regens can skip the
 * LLM call when nothing material has changed. Hashes sorted trigger refs
 * + sorted community slugs.
 */
export function flowDiscoveryFingerprint(input: FlowDiscoveryInput): string {
  const triggerRefs = [
    ...input.routes.map((r) => `route:${r.method} ${r.path}`),
    ...input.scheduledJobs.map((j) => `cron:${j.schedule}@${j.handler ?? j.file}`),
    ...input.consumers.map((c) => `consume:${c.topic}`),
  ].sort();
  const slugs = [...input.communitySlugs].sort();
  const h = createHash("sha256");
  h.update(triggerRefs.join("\n"));
  h.update("\n--\n");
  h.update(slugs.join("\n"));
  return h.digest("hex").slice(0, 16);
}

/**
 * Validate a Phase-A LLM output payload. Returns the validated FlowsFile
 * on success, an error message on rejection. Slug uniqueness is enforced
 * within the payload; cross-regen uniqueness is N/A (single file replaces
 * the previous content wholesale).
 */
export function validateFlowsPayload(
  payload: unknown,
  fingerprint: string,
  knownCommunitySlugs: ReadonlySet<string>,
): { ok: true; value: FlowsFile } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "payload must be an object" };
  }
  const p = payload as { flows?: unknown };
  if (!Array.isArray(p.flows)) {
    return { ok: false, error: "missing `flows` array" };
  }
  const flows: FlowSpec[] = [];
  const usedSlugs = new Set<string>();
  for (const raw of p.flows) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "each flow must be an object" };
    }
    const f = raw as Partial<FlowSpec>;
    if (typeof f.name !== "string" || f.name.trim() === "") {
      return { ok: false, error: "flow.name required" };
    }
    if (typeof f.slug !== "string" || !/^[a-z0-9-]+$/.test(f.slug)) {
      return { ok: false, error: `flow.slug invalid (must match /^[a-z0-9-]+$/): ${f.slug}` };
    }
    if (usedSlugs.has(f.slug)) {
      return { ok: false, error: `duplicate flow slug: ${f.slug}` };
    }
    usedSlugs.add(f.slug);
    if (typeof f.purpose !== "string" || f.purpose.trim() === "") {
      return { ok: false, error: `flow.purpose required (slug=${f.slug})` };
    }
    if (!f.trigger || typeof f.trigger !== "object") {
      return { ok: false, error: `flow.trigger required (slug=${f.slug})` };
    }
    const t = f.trigger as Partial<FlowSpec["trigger"]>;
    if (
      t.kind !== "http" &&
      t.kind !== "queue" &&
      t.kind !== "scheduled" &&
      t.kind !== "manual"
    ) {
      return { ok: false, error: `flow.trigger.kind invalid (slug=${f.slug})` };
    }
    if (typeof t.ref !== "string" || t.ref.trim() === "") {
      return { ok: false, error: `flow.trigger.ref required (slug=${f.slug})` };
    }
    if (!Array.isArray(f.memberCommunities)) {
      return { ok: false, error: `flow.memberCommunities required (slug=${f.slug})` };
    }
    for (const mc of f.memberCommunities) {
      if (typeof mc !== "string" || !knownCommunitySlugs.has(mc)) {
        return { ok: false, error: `flow.memberCommunities references unknown community: ${mc} (slug=${f.slug})` };
      }
    }
    flows.push({
      name: f.name,
      slug: f.slug,
      purpose: f.purpose,
      trigger: { kind: t.kind, ref: t.ref },
      memberCommunities: f.memberCommunities,
    });
  }
  return { ok: true, value: { version: 1, fingerprint, flows } };
}

/**
 * Phase B: build the per-flow detail bundle. Walks the import + symbol
 * graph from each flow's trigger handler downward, capping at
 * FLOW_CHAIN_MAX_DEPTH hops and FLOW_CHAIN_MAX_NODES total entries.
 *
 * Direction is callee (handler → service → repo). `db.getDependsOnForFiles`
 * gives file-level edges; per-line symbol scan inside each visited file
 * resolves which symbols are actually called from the parent hop.
 */
export function buildDataFlowBundleFor(
  flow: FlowSpec,
  bundles: CommunityBundle[],
  syntheses: SynthesesFile,
  db: RagDB,
  projectDir: string,
  serviceProfile: ServiceProfile | undefined,
): DataFlowBundle | null {
  void serviceProfile;
  // Locate the trigger handler symbol + file.
  const seed = locateTrigger(flow, bundles);
  if (!seed) return null;

  const slugByCommunityId = new Map<string, string>();
  for (const [id, p] of Object.entries(syntheses.payloads)) slugByCommunityId.set(id, p.slug);

  // BFS over file-level dependency graph from the seed file.
  const visited = new Set<string>();
  const queue: { file: string; depth: number }[] = [{ file: seed.file, depth: 0 }];
  const callChain: DataFlowBundle["callChain"] = [];
  visited.add(seed.file);

  // Build a path → fileId map once.
  const fileRows = db.getFilesByPaths(bundles.flatMap((b) => b.memberFiles).map((p) => `${projectDir}/${p}`));
  const idByPath = new Map<string, number>();
  const pathById = new Map<number, string>();
  for (const f of fileRows) {
    idByPath.set(f.path, f.id);
    pathById.set(f.id, f.path);
  }

  // Pre-compute deps map.
  const allFileIds = [...idByPath.values()];
  const depsByFromId = new Map<number, string[]>();
  for (const row of db.getDependsOnForFiles(allFileIds)) {
    let arr = depsByFromId.get(row.fromFileId);
    if (!arr) { arr = []; depsByFromId.set(row.fromFileId, arr); }
    arr.push(row.toPath);
  }

  while (queue.length > 0 && callChain.length < FLOW_CHAIN_MAX_NODES) {
    const { file, depth } = queue.shift()!;
    if (depth > FLOW_CHAIN_MAX_DEPTH) continue;

    const symbol = depth === 0 ? (seed.symbol ?? "<entry>") : extractTopSymbol(projectDir, file) ?? "<unknown>";
    const line = depth === 0 ? seed.line : 1;
    const calls: string[] = [];

    // Children: files this file depends on (callees).
    const fullPath = `${projectDir}/${file}`;
    const fileId = idByPath.get(fullPath);
    if (fileId !== undefined) {
      const deps = depsByFromId.get(fileId) ?? [];
      for (const dep of deps) {
        // Drop project-prefix to get a relative path.
        const rel = dep.startsWith(`${projectDir}/`) ? dep.slice(projectDir.length + 1) : dep;
        if (visited.has(rel)) continue;
        visited.add(rel);
        if (depth + 1 <= FLOW_CHAIN_MAX_DEPTH) {
          queue.push({ file: rel, depth: depth + 1 });
          const childSymbol = extractTopSymbol(projectDir, rel);
          if (childSymbol) calls.push(childSymbol);
        }
      }
    }

    callChain.push({ symbol, file, line, depth, calls });
  }

  // Member communities = distinct communitySlugs for files in the call chain.
  const fileToCommunity = new Map<string, string>();
  for (const b of bundles) {
    const slug = slugByCommunityId.get(b.communityId) ?? b.communityId;
    for (const f of b.memberFiles) fileToCommunity.set(f, slug);
  }
  const memberCommunities = [...new Set(callChain.map((c) => fileToCommunity.get(c.file)).filter((x): x is string => !!x))];

  // Annotations on call-chain files.
  const chainFiles = new Set(callChain.map((c) => c.file));
  const annotations: DataFlowBundle["annotations"] = [];
  for (const b of bundles) {
    for (const a of b.annotations) {
      if (chainFiles.has(a.file)) annotations.push(a);
    }
  }

  return {
    name: flow.name,
    slug: flow.slug,
    purpose: flow.purpose,
    trigger: flow.trigger,
    memberCommunities,
    callChain,
    annotations,
  };
}

/**
 * Find the file + symbol matching a flow's trigger across community
 * bundles. HTTP triggers match `METHOD path` against routes; queue
 * triggers match topic name; scheduled triggers match handler symbol;
 * manual triggers match the raw ref against any handler symbol.
 */
function locateTrigger(
  flow: FlowSpec,
  bundles: CommunityBundle[],
): { file: string; line: number; symbol: string | null } | null {
  for (const b of bundles) {
    if (!b.serviceSignals) continue;
    if (flow.trigger.kind === "http") {
      for (const r of b.serviceSignals.routes) {
        if (`${r.method} ${r.path}` === flow.trigger.ref) {
          return { file: r.file, line: r.line, symbol: r.handlerSymbol };
        }
      }
    } else if (flow.trigger.kind === "queue") {
      for (const q of b.serviceSignals.queueOps) {
        if (q.kind === "consume" && q.topic === flow.trigger.ref) {
          return { file: q.file, line: q.line, symbol: null };
        }
      }
    } else if (flow.trigger.kind === "scheduled") {
      for (const j of b.serviceSignals.scheduledJobs) {
        if (j.schedule === flow.trigger.ref || j.handler === flow.trigger.ref) {
          return { file: j.file, line: j.line, symbol: j.handler };
        }
      }
    }
  }
  return null;
}

/**
 * Best-effort top-symbol extraction from a file's source. Returns the
 * first exported function/class/type symbol encountered; null when
 * nothing matches. Used to label call-chain hops.
 */
function extractTopSymbol(projectDir: string, file: string): string | null {
  // Lazy require — avoids pulling fs into the main module load when this
  // path isn't exercised on small projects.
  const fs = require("fs") as typeof import("fs");
  let text: string;
  try {
    text = fs.readFileSync(`${projectDir}/${file}`, "utf-8");
  } catch {
    return null;
  }
  const re = /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|def|fn)\s+(\w+)/;
  const m = text.match(re);
  return m ? m[1] : null;
}
