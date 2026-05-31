import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import type { AnnotationRow, RagDB } from "../db";
import { normalizePath } from "../utils/path";

// Instruction prose lives in markdown, not in this file. A project override at
// `.mimirs/wiki/<name>.md` wins; otherwise the packaged default in
// `./instructions/<name>.md` is used (and cached). This is what makes the
// generation prose editable per-project — see `wiki(eject)`.
const packagedInstructionCache = new Map<string, string>();

async function loadWikiInstruction(projectDir: string, name: string): Promise<string> {
  const override = join(projectDir, ".mimirs", "wiki", `${name}.md`);
  if (existsSync(override)) {
    return await readFile(override, "utf-8");
  }
  const cached = packagedInstructionCache.get(name);
  if (cached !== undefined) return cached;
  const packaged = await readFile(new URL(`./instructions/${name}.md`, import.meta.url), "utf-8");
  packagedInstructionCache.set(name, packaged);
  return packaged;
}

// Loads an instruction file and substitutes `{{...}}` tokens. The shared blocks
// (`writing-contract`, `self-check`) are themselves overridable instruction
// files, so they resolve through `loadWikiInstruction` too — edit one file and
// every page that includes it changes. Remaining tokens are simple text values
// the caller supplies (slug, kind, schemaVersion, the overview variants).
async function renderInstruction(
  projectDir: string,
  name: string,
  tokens: Record<string, string> = {},
): Promise<string> {
  let text = await loadWikiInstruction(projectDir, name);
  for (const block of ["writing-contract", "self-check"] as const) {
    if (text.includes(`{{${block}}}`)) {
      text = text.replaceAll(`{{${block}}}`, await loadWikiInstruction(projectDir, block));
    }
  }
  for (const [key, value] of Object.entries(tokens)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

const PREFETCH_FILE = "_prefetch.json";
const DISCOVERY_FILE = "_discovery.json";
export const WIKI_DISCOVERY_SCHEMA_VERSION = 1;

export interface WikiRebuildCommand {
  mode: string;
  selectors: string[];
}

export interface WikiPrefetch {
  metadata: {
    projectRoot: string;
    generatedAt: string;
    lastCommitHash: string | null;
    mimirsVersion: string;
    index: {
      totalFiles: number;
      totalChunks: number;
      lastIndexed: string | null;
    };
  };
  map: {
    files: PrefetchFileEntry[];
  };
  annotations: Record<string, AnnotationRow[]>;
}

export interface PrefetchFileEntry {
  path: string;
  imports: string[];
  importedBy: string[];
  fanIn: number;
  fanOut: number;
  pageRank: number;
  exports: { name: string; kind: string; line: number | null }[];
}

export interface DiscoveryFile {
  metadata?: {
    schemaVersion?: number;
    prefetchCommitHash?: string | null;
    createdAt?: string;
  };
  flows?: DiscoveryFlow[];
  pages?: DiscoveryPage[];
}

export interface DiscoveryFlow {
  id?: string;
  title?: string;
  kind?: string;
  summary?: string;
  confidence?: string;
  entrypoints?: unknown[];
  files?: { path?: string; role?: string }[];
  evidence?: unknown[];
  stateChanges?: DiscoveryStateChange[];
  relatedFlows?: string[];
  interactions?: DiscoveryInteraction[];
}

export interface DiscoveryInteraction {
  name?: string;
  trigger?: string;
  description?: string;
  files?: { path?: string; role?: string }[];
  evidence?: unknown[];
}

export interface DiscoveryStateChange {
  item?: string;
  from?: string | null;
  to?: string | null;
  trigger?: string;
  description?: string;
  files?: { path?: string; role?: string }[];
  evidence?: unknown[];
}

export interface DiscoveryPage {
  slug?: string;
  title?: string;
  kind?: string;
  flowIds?: string[];
  primaryFiles?: string[];
  mustCover?: string[];
  inputs?: string[];
  outputs?: string[];
  openQuestions?: string[];
}

export interface WikiContext {
  db: RagDB;
  projectDir: string;
  version: string;
}

export function parseWikiCommand(input: string): WikiRebuildCommand {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Missing wiki command. Try `shape`.");
  const parts = trimmed.split(":");
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid wiki command '${input}'. Empty selector parts are not allowed.`);
  }
  return { mode: parts[0], selectors: parts.slice(1) };
}

function wikiDir(projectDir: string): string {
  return join(projectDir, "wiki");
}

function prefetchPath(projectDir: string): string {
  return join(wikiDir(projectDir), PREFETCH_FILE);
}

function discoveryPath(projectDir: string): string {
  return join(wikiDir(projectDir), DISCOVERY_FILE);
}

function relPath(projectDir: string, path: string): string {
  return normalizePath(relative(projectDir, path));
}

function assertSafeSelector(value: string, label: string) {
  if (!value || value.includes(":")) {
    throw new Error(`Invalid ${label} selector. The ':' character is reserved for wiki command segments.`);
  }
}

async function lastCommitHash(projectDir: string): Promise<string | null> {
  return (await gitOutput(projectDir, ["rev-parse", "HEAD"]))?.trim() || null;
}

// Runs git and returns stdout (trimmed by callers), or null on any failure —
// not a git repo, command error, git missing. Callers degrade gracefully.
async function gitOutput(projectDir: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: projectDir, stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? output : null;
  } catch {
    return null;
  }
}

// A modified wiki page whose changed-line ratio is at or above this is treated
// as a wholesale rewrite (reword / restructure / diagram swap), not a behavior
// change: it is listed as "refreshed" rather than fed to the changelog
// summarizer. Below it, the page is a surgical edit worth summarizing.
const WIKI_WHOLESALE_RATIO = 0.3;

function slugFromWikiPath(path: string): string {
  return normalizePath(path).replace(/^wiki\//, "").replace(/\.md$/, "");
}

// The pending wiki page changes vs HEAD — run before committing an update.
// Diffing the working tree needs no remembered baseline commit. Each modified
// page is classified by churn: a surgical edit (a few lines → a real behavior
// change) is summarizable; a wholesale rewrite is only listed. Only surgical
// diffs are gathered, so a 50-page regen never produces a giant changelog input.
// JSON state files and the changelog itself are excluded.
async function pendingWikiChanges(projectDir: string): Promise<{
  surgical: { slug: string; churn: number }[];
  refreshed: string[];
  added: string[];
  removed: string[];
  total: number;
  surgicalDiff: string;
}> {
  const status = (await gitOutput(projectDir, ["status", "--porcelain", "--", "wiki"])) ?? "";
  const pages: { path: string; slug: string; state: "modified" | "added" | "deleted" }[] = [];
  for (const line of status.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ")[1]; // rename: take the new path
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (!path.endsWith(".md") || path.endsWith("CHANGELOG.md")) continue;
    const state = code.includes("?") || code.includes("A") ? "added" : code.includes("D") ? "deleted" : "modified";
    pages.push({ path, slug: slugFromWikiPath(path), state });
  }

  const dir = wikiDir(projectDir);
  const total = existsSync(dir) ? (await collectMarkdownFiles(dir)).filter((p) => !p.endsWith("CHANGELOG.md")).length : 0;
  const added = pages.filter((p) => p.state === "added").map((p) => p.slug).sort();
  const removed = pages.filter((p) => p.state === "deleted").map((p) => p.slug).sort();
  const modified = pages.filter((p) => p.state === "modified");

  // One numstat call gives added/deleted lines per modified page; combine with
  // the current line count to get a churn ratio in [0,1].
  const churn = new Map<string, number>();
  if (modified.length) {
    const numstat = (await gitOutput(projectDir, ["diff", "--numstat", "HEAD", "--", ...modified.map((p) => p.path)])) ?? "";
    for (const line of numstat.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      const addCount = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0; // "-" == binary
      const delCount = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
      const path = parts.slice(2).join("\t");
      const newLines = (await readFile(join(projectDir, path), "utf-8").catch(() => "")).split("\n").length;
      const oldLines = Math.max(0, newLines - addCount + delCount);
      const denom = oldLines + newLines;
      churn.set(normalizePath(path), denom > 0 ? (addCount + delCount) / denom : 1);
    }
  }

  const surgical: { slug: string; churn: number }[] = [];
  const surgicalPaths: string[] = [];
  const refreshed: string[] = [];
  for (const p of modified) {
    const ratio = churn.get(normalizePath(p.path)) ?? 1;
    if (ratio >= WIKI_WHOLESALE_RATIO) {
      refreshed.push(p.slug);
    } else {
      surgical.push({ slug: p.slug, churn: ratio });
      surgicalPaths.push(p.path);
    }
  }
  surgical.sort((a, b) => a.slug.localeCompare(b.slug));
  refreshed.sort();

  let surgicalDiff = "";
  if (surgicalPaths.length) {
    surgicalDiff = ((await gitOutput(projectDir, ["diff", "HEAD", "--", ...surgicalPaths])) ?? "").trim();
  }

  return { surgical, refreshed, added, removed, total, surgicalDiff };
}

function computePageRank(paths: string[], edges: { fromPath: string; toPath: string }[]): Map<string, number> {
  if (paths.length === 0) return new Map();
  const damping = 0.85;
  const base = (1 - damping) / paths.length;
  const outbound = new Map<string, string[]>();
  for (const path of paths) outbound.set(path, []);
  for (const edge of edges) {
    const list = outbound.get(edge.fromPath);
    if (list) list.push(edge.toPath);
  }
  let scores = new Map(paths.map((path) => [path, 1 / paths.length]));
  for (let i = 0; i < 20; i++) {
    const next = new Map(paths.map((path) => [path, base]));
    for (const path of paths) {
      const outs = outbound.get(path) ?? [];
      const share = (scores.get(path) ?? 0) / Math.max(outs.length, 1);
      if (outs.length === 0) {
        const distributed = (damping * share) / paths.length;
        for (const p of paths) next.set(p, (next.get(p) ?? 0) + distributed);
      } else {
        for (const to of outs) next.set(to, (next.get(to) ?? 0) + damping * share);
      }
    }
    scores = next;
  }
  return scores;
}

function buildMap(projectDir: string, db: RagDB): PrefetchFileEntry[] {
  const graph = db.getGraph();
  const relById = new Map(graph.nodes.map((node) => [node.id, relPath(projectDir, node.path)]));
  const importsByPath = new Map<string, Set<string>>();
  const importedByPath = new Map<string, Set<string>>();

  for (const node of graph.nodes) {
    const rel = relById.get(node.id)!;
    importsByPath.set(rel, new Set());
    importedByPath.set(rel, new Set());
  }

  const relEdges = graph.edges.map((edge) => ({
    fromPath: relPath(projectDir, edge.fromPath),
    toPath: relPath(projectDir, edge.toPath),
  }));

  for (const edge of relEdges) {
    importsByPath.get(edge.fromPath)?.add(edge.toPath);
    importedByPath.get(edge.toPath)?.add(edge.fromPath);
  }

  const pageRank = computePageRank([...importsByPath.keys()], relEdges);
  return graph.nodes
    .map((node) => {
      const rel = relById.get(node.id)!;
      const imports = [...(importsByPath.get(rel) ?? new Set<string>())].sort();
      const importedBy = [...(importedByPath.get(rel) ?? new Set<string>())].sort();
      const linesBySymbol = new Map(
        db.getFileChunkRanges(node.path)
          .filter((range) => range.entityName)
          .map((range) => [range.entityName!, range.startLine]),
      );
      return {
        path: rel,
        imports,
        importedBy,
        fanIn: importedBy.length,
        fanOut: imports.length,
        pageRank: Number((pageRank.get(rel) ?? 0).toFixed(8)),
        exports: node.exports.map((exp) => ({ name: exp.name, kind: exp.type, line: linesBySymbol.get(exp.name) ?? null })),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function groupAnnotations(db: RagDB): Record<string, AnnotationRow[]> {
  const grouped: Record<string, AnnotationRow[]> = {};
  for (const annotation of db.getAnnotations()) {
    grouped[normalizePath(annotation.path)] ??= [];
    grouped[normalizePath(annotation.path)].push(annotation);
  }
  return grouped;
}

export async function buildPrefetch(ctx: WikiContext): Promise<WikiPrefetch> {
  const map = { files: buildMap(ctx.projectDir, ctx.db) };
  return {
    metadata: {
      projectRoot: ctx.projectDir,
      generatedAt: new Date().toISOString(),
      lastCommitHash: await lastCommitHash(ctx.projectDir),
      mimirsVersion: ctx.version,
      index: ctx.db.getStatus(),
    },
    map,
    annotations: groupAnnotations(ctx.db),
  };
}

async function writeJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJSON<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

async function readPrefetch(projectDir: string): Promise<WikiPrefetch> {
  return readJSON<WikiPrefetch>(prefetchPath(projectDir));
}

async function readDiscovery(projectDir: string): Promise<DiscoveryFile> {
  return readJSON<DiscoveryFile>(discoveryPath(projectDir));
}

function renderJSON(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function prefetchReadiness(prefetch: WikiPrefetch): string | null {
  if (prefetch.metadata.index.totalFiles > 0) return null;
  return [
    "## Stop: index is empty",
    "",
    "`wiki/_prefetch.json` was written, but the index reports 0 files. Do not draft discovery from raw source-tree guesses yet.",
    "",
    "Call `index_files` for this project, then call `wiki(shape)` again so discovery is backed by prefetch evidence.",
  ].join("\n");
}

export async function writePagePrompt(projectDir: string, slug: string, kind: string | undefined): Promise<string> {
  if (isOverviewKind(kind)) {
    const diagramRequired = !OVERVIEW_DIAGRAM_EXEMPT.has(kind!);
    return await renderInstruction(projectDir, "page-overview", {
      slug,
      kind: kind!,
      kindDescription: OVERVIEW_KIND_DESCRIPTION[kind!] ?? OVERVIEW_KIND_DESCRIPTION_FALLBACK,
      diagramGuidance: diagramRequired ? OVERVIEW_DIAGRAM_GUIDANCE.required : OVERVIEW_DIAGRAM_GUIDANCE.optional,
      diagramSelfCheck: diagramRequired ? OVERVIEW_DIAGRAM_SELFCHECK.required : OVERVIEW_DIAGRAM_SELFCHECK.optional,
    });
  }
  if (kind === "screen") return await renderInstruction(projectDir, "page-screen", { slug });
  return await renderInstruction(projectDir, "page-flow", { slug });
}

function compactDiscovery(discovery: DiscoveryFile) {
  return {
    metadata: discovery.metadata ?? {},
    flows: (discovery.flows ?? []).map((flow) => ({
      id: flow.id,
      title: flow.title,
      kind: flow.kind,
      confidence: flow.confidence,
      stateChangeCount: Array.isArray(flow.stateChanges) ? flow.stateChanges.length : 0,
    })),
    pages: (discovery.pages ?? []).map((page) => ({
      slug: page.slug,
      title: page.title,
      kind: page.kind,
      flowIds: page.flowIds ?? [],
      inputCount: Array.isArray(page.inputs) ? page.inputs.length : 0,
      outputCount: Array.isArray(page.outputs) ? page.outputs.length : 0,
    })),
  };
}

function validateStringArray(value: unknown, label: string, errors: string[], options: { required?: boolean; minItems?: number } = {}) {
  if (value === undefined) {
    if (options.required) errors.push(`${label} is missing.`);
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  if (options.minItems !== undefined && value.length < options.minItems) {
    errors.push(`${label} must contain at least ${options.minItems} item${options.minItems === 1 ? "" : "s"}.`);
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      errors.push(`${label}[${index}] must be a non-empty string.`);
    }
  });
}

function validateStateChanges(flow: DiscoveryFlow, flowIndex: number, errors: string[]) {
  if (flow.stateChanges === undefined) return;
  if (!Array.isArray(flow.stateChanges)) {
    errors.push(`flows[${flowIndex}].stateChanges must be an array when present.`);
    return;
  }

  flow.stateChanges.forEach((change, changeIndex) => {
    const prefix = `flows[${flowIndex}].stateChanges[${changeIndex}]`;
    if (!change || typeof change !== "object") {
      errors.push(`${prefix} must be an object.`);
      return;
    }
    if (!change.item || typeof change.item !== "string") errors.push(`${prefix} is missing string \`item\`.`);
    if (!("from" in change)) errors.push(`${prefix} is missing \`from\`.`);
    if (!("to" in change)) errors.push(`${prefix} is missing \`to\`.`);
    if (!change.description || typeof change.description !== "string") {
      errors.push(`${prefix} is missing string \`description\`.`);
    }
    if (change.files !== undefined && !Array.isArray(change.files)) errors.push(`${prefix}.files must be an array when present.`);
    if (change.evidence !== undefined && !Array.isArray(change.evidence)) {
      errors.push(`${prefix}.evidence must be an array when present.`);
    }
  });
}

function collectDiscoveryPaths(discovery: DiscoveryFile): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const record = (path: string | undefined, where: string) => {
    if (!path || typeof path !== "string") return;
    const norm = normalizePath(path);
    if (!norm) return;
    const list = found.get(norm) ?? [];
    list.push(where);
    found.set(norm, list);
  };

  const asArray = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

  asArray(discovery.flows).forEach((flow, fi) => {
    asArray(flow.files).forEach((entry, ei) => record(entry?.path, `flows[${fi}].files[${ei}].path`));
    asArray<any>(flow.evidence).forEach((entry, ei) => {
      if (entry && typeof entry === "object") record(entry.path, `flows[${fi}].evidence[${ei}].path`);
    });
    asArray(flow.stateChanges).forEach((change, ci) => {
      asArray(change?.files).forEach((entry, ei) => record(entry?.path, `flows[${fi}].stateChanges[${ci}].files[${ei}].path`));
      asArray<any>(change?.evidence).forEach((entry, ei) => {
        if (entry && typeof entry === "object") record(entry.path, `flows[${fi}].stateChanges[${ci}].evidence[${ei}].path`);
      });
    });
  });

  asArray(discovery.pages).forEach((page, pi) => {
    asArray(page.primaryFiles).forEach((path, ei) => record(path, `pages[${pi}].primaryFiles[${ei}]`));
  });

  return found;
}

function validateDiscoveryPaths(discovery: DiscoveryFile, projectDir: string): string[] {
  const errors: string[] = [];
  const paths = collectDiscoveryPaths(discovery);
  for (const [path, locations] of paths) {
    if (existsSync(join(projectDir, path))) continue;
    for (const where of locations) {
      errors.push(`${where} references missing file \`${path}\`.`);
    }
  }
  return errors;
}

const OVERVIEW_KINDS = [
  "overview:architecture",
  "overview:data-model",
  "overview:module-map",
  "overview:runtime-lifecycle",
  "overview:configuration",
  "overview:integrations",
] as const;

const OVERVIEW_KIND_TO_SLUG: Record<string, string> = {
  "overview:architecture": "architecture",
  "overview:data-model": "data-model",
  "overview:module-map": "module-map",
  "overview:runtime-lifecycle": "runtime-lifecycle",
  "overview:configuration": "configuration",
  "overview:integrations": "integrations",
};

const OVERVIEW_DIAGRAM_EXEMPT = new Set(["overview:configuration"]);

// Overview pages carry conditional content the markdown can't express on its
// own: a per-kind description and a diagram rule that flips for diagram-exempt
// kinds. These stay as code; `page-overview.md` exposes them as tokens
// (`{{kindDescription}}`, `{{diagramGuidance}}`, `{{diagramSelfCheck}}`) that
// `writePagePrompt` fills based on `kind`.
const OVERVIEW_KIND_DESCRIPTION: Record<string, string> = {
  "overview:architecture": "the project's components and how they communicate at runtime",
  "overview:data-model": "the project's persistent state, on-disk layout, and storage schema",
  "overview:module-map":
    "the project's top-level packages or directories, their responsibilities, and the import boundaries between them",
  "overview:runtime-lifecycle": "the project's long-running process from boot through ready, request handling, and shutdown",
  "overview:configuration": "the project's configuration surface: env vars, config files, flag precedence, and defaults",
  "overview:integrations": "the external services this project talks to, including databases, APIs, queues, and model providers",
};
const OVERVIEW_KIND_DESCRIPTION_FALLBACK = "a cross-cutting aspect of the project";
const OVERVIEW_DIAGRAM_GUIDANCE = {
  required:
    "- Include at least one diagram. Use `graph` or `flowchart` for component/module/integration relationships, or `erDiagram` for data-model schemas. Sequence diagrams are usually wrong here; they belong on flow pages. In Mermaid labels use `<br>` for line breaks — never `\\n`, which renders literally. Never use a reserved word (`graph`, `subgraph`, `end`, `class`, `state`, `click`) as a node id; suffix it instead.",
  optional:
    "- Diagrams are optional for configuration overviews. Tables of env vars, config keys, and precedence rules are usually more useful than a diagram.",
};
const OVERVIEW_DIAGRAM_SELFCHECK = {
  required: "5. Confirm the page has at least one diagram and that every node or relationship in it is grounded in real code.",
  optional: "5. Confirm any tables of config keys, env vars, or precedence rules match the actual loader code.",
};

function isOverviewKind(kind: string | undefined): boolean {
  return typeof kind === "string" && kind.startsWith("overview:");
}

function validateDiscoveryShape(discovery: DiscoveryFile): string[] {
  const errors: string[] = [];
  if (!discovery || typeof discovery !== "object") return ["Discovery must be a JSON object."];
  if (!("metadata" in discovery)) errors.push("Missing top-level `metadata`.");
  if (!Array.isArray(discovery.flows)) errors.push("Missing top-level `flows` array.");
  if (!Array.isArray(discovery.pages)) errors.push("Missing top-level `pages` array.");
  if (!Array.isArray(discovery.flows) || !Array.isArray(discovery.pages)) return errors;

  const flowIds = new Set<string>();
  const pageSlugs = new Set<string>();
  const pageFlowIds = new Set<string>();
  const seenOverviewKinds = new Set<string>();
  const overviewSlugs = new Set(Object.values(OVERVIEW_KIND_TO_SLUG));
  const broadPageSlugs = new Set([
    "api",
    "api-surface",
    "data-flow",
    "data-flows",
    "endpoints",
    "entities",
    "events",
    "glossary",
    "messages",
    "modules",
    "overview",
    "queues",
    "routes",
  ]);

  discovery.flows.forEach((flow, index) => {
    if (!flow.id) {
      errors.push(`flows[${index}] is missing \`id\`.`);
      return;
    }
    if (flow.id.includes(":")) errors.push(`flows[${index}].id contains reserved ':' character.`);
    if (flowIds.has(flow.id)) errors.push(`Duplicate flow id \`${flow.id}\`.`);
    flowIds.add(flow.id);
    validateStateChanges(flow, index, errors);
  });

  discovery.pages.forEach((page, index) => {
    if (!page.slug) {
      errors.push(`pages[${index}] is missing \`slug\`.`);
      return;
    }
    const kindIsString = !!page.kind && typeof page.kind === "string" && page.kind.trim().length > 0;
    if (!kindIsString) {
      errors.push(`pages[${index}] is missing string \`kind\`.`);
    }
    const overview = kindIsString && isOverviewKind(page.kind);
    if (kindIsString && page.kind!.includes(":") && !overview) {
      errors.push(`pages[${index}].kind contains reserved ':' character.`);
    }
    if (overview && !OVERVIEW_KIND_TO_SLUG[page.kind!]) {
      errors.push(`pages[${index}].kind \`${page.kind}\` is not one of: ${OVERVIEW_KINDS.join(", ")}.`);
    }
    if (page.slug.includes(":")) errors.push(`pages[${index}].slug contains reserved ':' character.`);
    if (overview) {
      const expectedSlug = OVERVIEW_KIND_TO_SLUG[page.kind!];
      if (expectedSlug && page.slug !== expectedSlug) {
        errors.push(`pages[${index}].slug \`${page.slug}\` must be \`${expectedSlug}\` for overview kind \`${page.kind}\`.`);
      }
      if (seenOverviewKinds.has(page.kind!)) {
        errors.push(`Duplicate overview kind \`${page.kind}\`. At most one overview page per kind.`);
      }
      seenOverviewKinds.add(page.kind!);
    } else if (overviewSlugs.has(page.slug)) {
      errors.push(`pages[${index}].slug \`${page.slug}\` is reserved for an overview page. Set \`kind\` to the matching \`overview:*\` value.`);
    } else if (broadPageSlugs.has(page.slug)) {
      errors.push(`pages[${index}].slug \`${page.slug}\` is too broad. Use one page per concrete flow instead.`);
    }
    if (pageSlugs.has(page.slug)) errors.push(`Duplicate page slug \`${page.slug}\`.`);
    pageSlugs.add(page.slug);
    if (overview) {
      if (page.flowIds !== undefined && !Array.isArray(page.flowIds)) {
        errors.push(`pages[${index}].flowIds must be an array when present.`);
      }
      validateStringArray(page.primaryFiles, `pages[${index}].primaryFiles`, errors, { required: true, minItems: 3 });
      const ids = Array.isArray(page.flowIds) ? page.flowIds : [];
      for (const flowId of ids) {
        if (!flowIds.has(flowId)) errors.push(`pages[${index}].flowIds references missing flow id \`${flowId}\`.`);
      }
    } else {
      if (!Array.isArray(page.flowIds)) errors.push(`pages[${index}] is missing \`flowIds\` array.`);
      const ids = Array.isArray(page.flowIds) ? page.flowIds : [];
      if (ids.length !== 1) errors.push(`pages[${index}].flowIds must contain exactly one flow id.`);
      for (const flowId of ids) {
        if (!flowIds.has(flowId)) errors.push(`pages[${index}].flowIds references missing flow id \`${flowId}\`.`);
        if (pageFlowIds.has(flowId)) errors.push(`Flow id \`${flowId}\` is assigned to more than one page.`);
        pageFlowIds.add(flowId);
      }
    }
    validateStringArray(page.inputs, `pages[${index}].inputs`, errors, { minItems: 1 });
    validateStringArray(page.outputs, `pages[${index}].outputs`, errors, { minItems: 1 });
  });

  return errors;
}

function validationResponse(projectDir: string, errors: string[]): string {
  if (errors.length === 0) {
    return [
      "`wiki/_discovery.json` passed structural checks.",
      "",
      "Ask the human whether to continue. If the human says yes, call `wiki(write)` next; that prompt will tell you to read `wiki(discovery)` and split page writing by slug.",
    ].join("\n");
  }
  return [
    "`wiki/_discovery.json` has structural errors:",
    "",
    ...errors.map((error) => `- ${error}`),
    "",
    `Fix \`${relative(projectDir, discoveryPath(projectDir))}\`, then call \`wiki(validate-discovery)\` again.`,
  ].join("\n");
}

const MARKDOWN_LINK_RE = /\[(?:[^\]]*)\]\(([^)\s]+)\)/g;

interface BrokenLink {
  file: string;
  target: string;
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { recursive: true });
  return entries
    .filter((entry) => typeof entry === "string" && entry.endsWith(".md"))
    .map((entry) => normalizePath(entry as string));
}

function extractRelativeMarkdownLinks(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
    const raw = match[1];
    if (!raw) continue;
    const url = raw.split("#")[0]!.trim();
    if (!url || !url.endsWith(".md")) continue;
    if (/^[a-z][a-z0-9+\-.]*:/i.test(url)) continue;
    if (url.startsWith("/")) continue;
    out.push(url);
  }
  return out;
}

async function validateWikiPages(projectDir: string): Promise<BrokenLink[]> {
  const root = wikiDir(projectDir);
  const files = await collectMarkdownFiles(root);
  const broken: BrokenLink[] = [];
  for (const relFile of files) {
    const absFile = join(root, relFile);
    const body = await readFile(absFile, "utf-8");
    const targets = extractRelativeMarkdownLinks(body);
    for (const target of targets) {
      const resolved = resolve(dirname(absFile), target);
      if (existsSync(resolved)) continue;
      broken.push({ file: relFile, target });
    }
  }
  return broken;
}

function pagesValidationResponse(broken: BrokenLink[]): string {
  if (broken.length === 0) {
    return "All relative `.md` links under `wiki/` resolve to existing files.";
  }
  return [
    "`wiki/` has broken relative `.md` links:",
    "",
    ...broken.map(({ file, target }) => `- \`wiki/${file}\` → \`${target}\` (target does not exist).`),
    "",
    "Fix the listed pages or rebuild the affected pages, then call `wiki(validate-pages)` again.",
  ].join("\n");
}

function findFlow(discovery: DiscoveryFile, id: string): DiscoveryFlow | null {
  return (discovery.flows ?? []).find((flow) => flow.id === id) ?? null;
}

function findPage(discovery: DiscoveryFile, slug: string): DiscoveryPage | null {
  return (discovery.pages ?? []).find((page) => page.slug === slug) ?? null;
}

function findMapEntries(prefetch: WikiPrefetch, paths: string[]): PrefetchFileEntry[] {
  const wanted = new Set(paths.map(normalizePath));
  return prefetch.map.files.filter((file) => wanted.has(file.path));
}

function annotationsFor(prefetch: WikiPrefetch, paths: string[]): Record<string, AnnotationRow[]> {
  const out: Record<string, AnnotationRow[]> = {};
  for (const path of paths) {
    const key = normalizePath(path);
    if (prefetch.annotations[key]) out[key] = prefetch.annotations[key];
  }
  return out;
}

function buildPagePacket(prefetch: WikiPrefetch, discovery: DiscoveryFile, slug: string) {
  const page = findPage(discovery, slug);
  if (!page) throw new Error(`No page found for slug '${slug}'.`);
  const flows = (page.flowIds ?? []).map((id) => findFlow(discovery, id)).filter((flow): flow is DiscoveryFlow => !!flow);
  const primaryFiles = (page.primaryFiles ?? []).map(normalizePath);
  return {
    page,
    flows,
    mapEntries: findMapEntries(prefetch, primaryFiles),
    annotations: annotationsFor(prefetch, primaryFiles),
    evidence: flows.flatMap((flow) => flow.evidence ?? []),
  };
}

function emptyPrefetch(ctx: WikiContext): WikiPrefetch {
  return {
    metadata: {
      projectRoot: ctx.projectDir,
      generatedAt: new Date().toISOString(),
      lastCommitHash: null,
      mimirsVersion: ctx.version,
      index: { totalFiles: 0, totalChunks: 0, lastIndexed: null },
    },
    map: { files: [] },
    annotations: {},
  };
}

function readSelector(prefetch: WikiPrefetch, command: WikiRebuildCommand): unknown {
  const [selector] = command.selectors;
  if (command.mode !== "prefetch") throw new Error(`Unsupported prefetch command '${command.mode}'.`);
  if (!selector) return prefetch;
  if (selector === "metadata") return prefetch.metadata;
  if (selector === "map") {
    const path = command.selectors[1];
    if (!path) return prefetch.map;
    assertSafeSelector(path, "path");
    const found = prefetch.map.files.find((file) => file.path === normalizePath(path));
    if (!found) throw new Error(`No prefetch map entry found for '${path}'.`);
    return found;
  }
  if (selector === "annotations") {
    const path = command.selectors[1];
    if (!path) return prefetch.annotations;
    assertSafeSelector(path, "path");
    return prefetch.annotations[normalizePath(path)] ?? [];
  }
  throw new Error(`Unknown prefetch selector '${selector}'.`);
}

// --- iterative update: detect what changed since the wiki was last generated ---

// Past these, a targeted update is not worth attempting — recommend a regen.
const CAUSE_DIFF_MAX_BYTES = 64 * 1024;
const CAUSE_FILES_MAX = 25;
const LOCKFILE_NAMES = new Set(["package-lock.json", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"]);

function isNoiseFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return LOCKFILE_NAMES.has(base) || base.endsWith(".lock");
}

async function gitSucceeds(projectDir: string, args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: projectDir, stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

// The commit the wiki was last generated from. Never trusts the stamped hash
// blindly: it survives rebases, squashes, and dropped commits.
async function resolveBaseline(projectDir: string): Promise<{ commit: string | null; source: string; warning?: string }> {
  let stamped: string | null = null;
  const changelogPath = join(wikiDir(projectDir), "CHANGELOG.md");
  if (existsSync(changelogPath)) {
    const match = (await readFile(changelogPath, "utf-8")).match(/^##\s*\[([0-9a-fA-F]{7,40})\]/m);
    if (match) stamped = match[1];
  }

  if (stamped && (await gitSucceeds(projectDir, ["cat-file", "-e", `${stamped}^{commit}`]))) {
    if (await gitSucceeds(projectDir, ["merge-base", "--is-ancestor", stamped, "HEAD"])) {
      return { commit: stamped, source: `changelog stamp ${stamped}` };
    }
    const mergeBase = (await gitOutput(projectDir, ["merge-base", stamped, "HEAD"]))?.trim();
    if (mergeBase) return { commit: mergeBase, source: `merge-base with diverged stamp ${stamped}` };
  }

  // The last commit that wrote the wiki is reachable by definition.
  const lastWiki = (await gitOutput(projectDir, ["log", "-1", "--format=%H", "--", "wiki"]))?.trim();
  if (lastWiki) {
    const why = stamped ? `stamp ${stamped} unreachable; ` : "";
    return { commit: lastWiki, source: `${why}last wiki/ commit ${lastWiki.slice(0, 7)}` };
  }

  return {
    commit: null,
    source: "none",
    warning: "Could not anchor a baseline (no usable changelog stamp, no wiki/ history). Regenerate the wiki instead of a targeted update.",
  };
}

async function wikiPageIndex(projectDir: string): Promise<{ slug: string; title: string }[]> {
  try {
    const discovery = await readDiscovery(projectDir);
    return (discovery.pages ?? [])
      .filter((page): page is DiscoveryPage & { slug: string } => Boolean(page.slug))
      .map((page) => ({ slug: page.slug, title: page.title ?? page.slug }));
  } catch {
    return [];
  }
}

// The "cause" of a wiki update: source + instruction changes since the baseline,
// excluding the wiki/ output itself, binaries, and lockfiles — no directory
// assumptions, so it works for any project layout. The LLM maps these to pages.
async function buildCausePacket(projectDir: string): Promise<{
  baseline: string | null;
  baselineSource: string;
  files: string[];
  diff: string;
  tooLarge: boolean;
  pageIndex: { slug: string; title: string }[];
  warning?: string;
}> {
  const { commit: baseline, source: baselineSource, warning } = await resolveBaseline(projectDir);
  const pageIndex = await wikiPageIndex(projectDir);

  if (!baseline) {
    return { baseline, baselineSource, files: [], diff: "", tooLarge: false, pageIndex, warning };
  }

  // numstat over baseline → working tree; drop binaries ("-\t-"), lockfiles, and
  // anything under wiki/ (the output we regenerate).
  const numstat = (await gitOutput(projectDir, ["diff", "--numstat", baseline])) ?? "";
  const files: string[] = [];
  for (const line of numstat.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const isBinary = parts[0] === "-" && parts[1] === "-";
    const path = parts.slice(2).join("\t");
    if (!path || isBinary || isNoiseFile(path) || normalizePath(path).startsWith("wiki/")) continue;
    files.push(path);
  }
  files.sort();

  const diff = files.length ? ((await gitOutput(projectDir, ["diff", baseline, "--", ...files])) ?? "").trim() : "";
  const tooLarge = diff.length > CAUSE_DIFF_MAX_BYTES || files.length > CAUSE_FILES_MAX;

  return { baseline, baselineSource, files, diff: tooLarge ? "" : diff, tooLarge, pageIndex, warning };
}

export async function runWikiRebuild(ctx: WikiContext, input: string): Promise<string> {
  const command = parseWikiCommand(input);

  if (command.mode === "shape") {
    const prefetch = await buildPrefetch(ctx);
    await mkdir(wikiDir(ctx.projectDir), { recursive: true });
    await writeJSON(prefetchPath(ctx.projectDir), prefetch);
    const readiness = prefetchReadiness(prefetch);
    const discovery = await renderInstruction(ctx.projectDir, "discovery", {
      schemaVersion: String(WIKI_DISCOVERY_SCHEMA_VERSION),
    });
    return [
      `Wrote \`wiki/${PREFETCH_FILE}\`.`,
      ...(readiness ? ["", readiness] : []),
      "",
      discovery,
    ].join("\n");
  }

  if (command.mode === "prefetch") {
    const prefetch = await readPrefetch(ctx.projectDir);
    return renderJSON(readSelector(prefetch, command));
  }

  if (command.mode === "validate-discovery") {
    try {
      const discovery = await readDiscovery(ctx.projectDir);
      const errors = [
        ...validateDiscoveryShape(discovery),
        ...validateDiscoveryPaths(discovery, ctx.projectDir),
      ];
      return validationResponse(ctx.projectDir, errors);
    } catch (err) {
      return validationResponse(ctx.projectDir, [`Could not read valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }

  if (command.mode === "validate-pages") {
    const broken = await validateWikiPages(ctx.projectDir);
    return pagesValidationResponse(broken);
  }

  if (command.mode === "discovery") {
    const discovery = await readDiscovery(ctx.projectDir);
    const selector = command.selectors[0];
    if (!selector) return renderJSON(compactDiscovery(discovery));
    if (selector === "flow") {
      const id = command.selectors[1];
      if (!id) throw new Error("Missing flow id. Use `wiki(discovery:flow:<id>)`.");
      assertSafeSelector(id, "flow id");
      const flow = findFlow(discovery, id);
      if (!flow) throw new Error(`No flow found for id '${id}'.`);
      return renderJSON(flow);
    }
    if (selector === "page") {
      const slug = command.selectors[1];
      if (!slug) throw new Error("Missing page slug. Use `wiki(discovery:page:<slug>)`.");
      assertSafeSelector(slug, "page slug");
      const page = findPage(discovery, slug);
      if (!page) throw new Error(`No page found for slug '${slug}'.`);
      return renderJSON(page);
    }
    throw new Error(`Unknown discovery selector '${selector}'.`);
  }

  if (command.mode === "write") {
    const selector = command.selectors[0];
    if (!selector) return await renderInstruction(ctx.projectDir, "write");
    if (selector !== "page") throw new Error(`Unknown write selector '${selector}'.`);
    const slug = command.selectors[1];
    if (!slug) throw new Error("Missing page slug. Use `wiki(write:page:<slug>)`.");
    assertSafeSelector(slug, "page slug");
    const prefetch = existsSync(prefetchPath(ctx.projectDir))
      ? await readPrefetch(ctx.projectDir)
      : emptyPrefetch(ctx);
    const discovery = await readDiscovery(ctx.projectDir);
    const packet = buildPagePacket(prefetch, discovery, slug);
    return [
      await writePagePrompt(ctx.projectDir, slug, packet.page.kind),
      "",
      "## Page packet",
      "",
      "```json",
      renderJSON(packet),
      "```",
    ].join("\n");
  }

  if (command.mode === "eject") {
    const force = command.selectors[0] === "force";
    const destDir = join(ctx.projectDir, ".mimirs", "wiki");
    await mkdir(destDir, { recursive: true });
    const names = [
      "README",
      "discovery",
      "write",
      "writing-contract",
      "self-check",
      "page-flow",
      "page-overview",
      "page-screen",
      "changelog",
      "update",
    ];
    const written: string[] = [];
    const skipped: string[] = [];
    for (const name of names) {
      const dest = join(destDir, `${name}.md`);
      if (existsSync(dest) && !force) {
        skipped.push(`${name}.md`);
        continue;
      }
      const packaged = await readFile(new URL(`./instructions/${name}.md`, import.meta.url), "utf-8");
      await writeFile(dest, packaged);
      written.push(`${name}.md`);
    }
    return [
      "Ejected wiki instruction defaults to `.mimirs/wiki/`.",
      `Wrote: ${written.length ? written.join(", ") : "(none)"}`,
      ...(skipped.length
        ? [`Skipped (already present — use \`wiki(eject:force)\` to overwrite): ${skipped.join(", ")}`]
        : []),
      "",
      "Edit these files to customize wiki generation for this project; they override the packaged defaults. They are gitignored under `.mimirs/` — un-ignore them to share with your team. See `.mimirs/wiki/README.md`.",
    ].join("\n");
  }

  if (command.mode === "update") {
    const { baseline, baselineSource, files, diff, tooLarge, pageIndex, warning } = await buildCausePacket(ctx.projectDir);
    const prompt = await renderInstruction(ctx.projectDir, "update", {});

    if (!baseline) {
      return [prompt, "", "## Update signal", "", `- ${warning ?? "No baseline found; regenerate the wiki."}`].join("\n");
    }
    if (!files.length) {
      return [
        prompt,
        "",
        "## Update signal",
        "",
        `- Baseline: ${baselineSource}`,
        "- No source or instruction changes since the last wiki version — nothing to update.",
      ].join("\n");
    }

    const signal = [
      "## Update signal",
      "",
      `- Baseline: ${baselineSource}`,
      `- Changed files since baseline (${files.length}):`,
      ...files.map((file) => `  - ${file}`),
      ...(tooLarge
        ? ["", "**Too much changed for a targeted update — run the full wiki rebuild instead of regenerating individual pages.**"]
        : []),
      "",
      "### Wiki pages (slug — title)",
      "",
      pageIndex.length ? pageIndex.map((page) => `- ${page.slug} — ${page.title}`).join("\n") : "(no discovery page index found)",
      ...(tooLarge ? [] : ["", "### Cause diff", "", diff || "(empty)"]),
    ].join("\n");

    return [prompt, "", signal].join("\n");
  }

  if (command.mode === "changelog") {
    const currentFull = await lastCommitHash(ctx.projectDir);
    const currentCommit = currentFull ? currentFull.slice(0, 7) : "unknown";
    const date = new Date().toISOString().slice(0, 10);
    const { surgical, refreshed, added, removed, surgicalDiff } = await pendingWikiChanges(ctx.projectDir);
    const totalChanged = surgical.length + refreshed.length + added.length + removed.length;

    const list = (slugs: string[]) => (slugs.length ? slugs.join(", ") : "none");
    const prompt = await renderInstruction(ctx.projectDir, "changelog", { currentCommit, date });
    const signal = [
      "## Changelog signal",
      "",
      `- Stamp: [${currentCommit}] - ${date}`,
      `- Pending wiki changes: ${totalChanged}`,
      `- Surgical edits (summarize from the diffs below): ${list(surgical.map((s) => s.slug))}`,
      `- Refreshed wholesale (list only, do not summarize): ${list(refreshed)}`,
      `- New pages: ${list(added)}`,
      `- Removed pages: ${list(removed)}`,
      ...(surgical.length
        ? ["", "### Surgical page diffs", "", surgicalDiff || "(empty)"]
        : []),
    ].join("\n");

    return [prompt, "", signal].join("\n");
  }

  throw new Error(`Unknown wiki command '${input}'. Try \`shape\`, \`prefetch\`, \`validate-discovery\`, \`discovery\`, \`write\`, \`update\`, \`changelog\`, \`eject\`, or \`validate-pages\`.`);
}
