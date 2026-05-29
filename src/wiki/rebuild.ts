import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import type { AnnotationRow, RagDB } from "../db";
import { normalizePath } from "../utils/path";

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
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && output ? output : null;
  } catch {
    return null;
  }
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

function discoveryPrompt(): string {
  return [
    "You are discovering wiki flows for this project.",
    "",
    "Your job is to create `wiki/_discovery.json`. Do not write final wiki pages yet.",
    "",
    "Use the prefetch data and mimirs tools to find real project flows. A flow must have a trigger, a path through code, an observable outcome, and evidence. Do not treat plain helpers, types, config objects, database tables, or folders as flows by themselves.",
    "",
    "For each flow, also capture important item state changes. An item is a project-specific thing whose state changes during the flow, such as an order, job, file, index row, cache entry, session, message, or checkpoint. Only record state changes you can support with source evidence.",
    "",
    "Granularity rules:",
    "",
    "1. Default to one flow and one page per externally triggered behavior.",
    "2. HTTP routes and API endpoints must be split by concrete method and route, such as `POST /checkout`. Do not create one broad `api`, `endpoints`, or `routes` page.",
    "3. Messages, events, queue topics, and consumers must be split by concrete message, topic, event, or handler. Do not create one broad `messages`, `events`, or `queues` page.",
    "4. CLI subcommands, MCP tools, workers, jobs, schedules, webhooks, and server starts each get their own flow and page when they have separate triggers.",
    "5. Do not create glossary, entity, or generic data-flow pages. The only non-flow pages allowed are the six overview kinds described below.",
    "6. If many flows share the same files, keep separate pages and connect them with `relatedFlows`; do not merge them into one category page.",
    "7. Every flow page should have a category `kind`, usually matching the referenced flow kind, such as `tool`, `command`, `route`, `message`, `job`, or `schedule`. Every flow page must have exactly one `flowIds` item. Add `inputs` and `outputs` arrays when they help explain the flow; omit either one when there is no meaningful value.",
    "8. Frontend UI screens (route components, top-level views mounted by a router or app shell) use kind `screen`. One screen flow per route. User interactions within a screen (button clicks, form submits, mutations) are not separate flows; capture them in the screen flow's `interactions[]` array. Do not create a separate page per interaction.",
    "9. Detect screens structurally: look for a router or app-shell module that maps URL paths or route ids to component modules, and follow each mapping to its top-level component. Do not assume framework conventions; verify by reading the router and the rendered component.",
    "",
    "Start here:",
    "",
    "1. Call `wiki(prefetch:metadata)` to understand the generated prefetch.",
    "2. Call `wiki(prefetch:map)` to inspect the file-level project map.",
    "3. Use mimirs tools such as `read_relevant`, `search`, `project_map`, `depends_on`, `depended_on_by`, `search_symbols`, and `find_usages` to discover and verify each likely flow.",
    "4. Use focused reads like `wiki(prefetch:map:<path>)` and `wiki(prefetch:annotations:<path>)` when the full sections are too large.",
    "",
    "Discovery coverage checklist:",
    "",
    "1. First identify how this project exposes externally triggered behavior. Do not assume the trigger style from generic framework names.",
    "2. Look for the project's own registration, routing, dispatch, subscription, scheduling, and command patterns. Use filenames, imports, exports, project map centrality, and direct code reads to infer those patterns.",
    "3. For each trigger family you find, enumerate the concrete triggers from source code before writing discovery. Examples of trigger families include HTTP routes, RPC procedures, message topics, event listeners, CLI subcommands, workers, jobs, schedules, webhooks, MCP tools, and server starts. This list is not exhaustive.",
    "4. Create one flow per concrete externally triggered behavior, even when several flows share the same handler, service, or files.",
    "5. Verify each candidate flow by following it from trigger to at least one observable outcome, such as a response, database access, network call, file operation, queue publish, cache update, process start, or scheduled side effect.",
    "6. Inspect declarative, generated, decorator-based, config-driven, or framework-magic layers directly before deciding coverage is complete.",
    "7. Do not omit thin wrappers, aliases, or forwarding flows if they are externally callable. Keep them separate and connect them with `relatedFlows`.",
    "8. If coverage is uncertain, record the uncertainty in `openQuestions` instead of silently skipping the candidate.",
    "9. For each verified flow, list the concrete items whose state changes. Use `from: null` when the item is created, `to: null` when it is deleted, and plain labels such as `queued`, `indexed`, `written`, `cached`, or `returned` when the code uses implicit states instead of enum values.",
    "10. When a flow depends on concrete caller-provided values or external conditions, list them in the page `inputs` array. Inputs can be request parameters, command flags, tool arguments, file paths, config values, environment variables, messages, schedules, or user actions. Omit `inputs` when there is no meaningful input.",
    "11. When a flow has concrete outputs or visible side effects, list them in the page `outputs` array. Outputs can be responses, returned text, written files, database rows, index updates, spawned processes, published messages, logs, or other visible side effects. Do not list inputs as outputs. Omit `outputs` when there is no meaningful output.",
    "12. Every `mustCover`, `inputs`, and `outputs` item must name behavior, a parameter, a table, or a metric you verified in source during discovery. Do not list a feature, table name, field, or metric you have not confirmed exists. A wrong `mustCover` item is worse than a missing one: it forces the page writer either to repeat the error or to break character correcting it. When in doubt, leave it out and record the uncertainty in `openQuestions`.",
    "",
    "Overview pages (second pass):",
    "",
    "After you have enumerated every concrete flow, re-read the flow set and evaluate the six overview page kinds below. Emit an overview page only when its trigger fires for this project. At most one page per kind. Overview pages live at the wiki root (e.g. `wiki/architecture.md`), have no `flowIds` requirement, and must cite at least three source files in `primaryFiles`. If a second-pass overview reveals a flow you missed, go back and add the missing flow to `flows[]` before finalizing.",
    "",
    "Each overview page must (a) cite at least three source files with line ranges in its body, (b) link to at least two flow pages it ties together, and (c) include one diagram. The diagram requirement is waived only for `overview:configuration`. If you cannot meet these constraints honestly, do not write the page.",
    "",
    "The six kinds, with triggers:",
    "",
    "- `overview:architecture` — components and how they talk. Trigger: at least two distinct runtime components or process boundaries (e.g. CLI + server, client + worker, app + queue consumer). Slug: `architecture`.",
    "- `overview:data-model` — persistent state: schemas, files written to disk, cache layout. Trigger: project owns persistent state (SQL/ORM files, embedded DB deps, writes outside tmp). Skip for stateless libraries. Slug: `data-model`.",
    "- `overview:module-map` — top-level packages/dirs, their responsibilities, and the import boundaries between them. Trigger: at least four top-level source directories with distinct roles. Slug: `module-map`.",
    "- `overview:runtime-lifecycle` — boot → ready → handle → shutdown, with where state is initialized. Trigger: at least one long-running process (server, daemon, worker). Skip for CLIs that exit per invocation. Slug: `runtime-lifecycle`.",
    "- `overview:configuration` — env vars, config files, flag precedence. Trigger: configuration surface beyond roughly five knobs, or multi-source precedence (env > file > defaults). No diagram required. Slug: `configuration`.",
    "- `overview:integrations` — external services the project talks to (databases, APIs, queues, model providers). Trigger: at least two external services or providers. Slug: `integrations`.",
    "",
    "Create `wiki/_discovery.json` with this shape:",
    "",
    "```json",
    renderJSON({
      metadata: {
        schemaVersion: WIKI_DISCOVERY_SCHEMA_VERSION,
        prefetchCommitHash: "<from prefetch metadata>",
        createdAt: "<iso timestamp>",
      },
      flows: [
        {
          id: "<stable-flow-id>",
          title: "<human title for one concrete trigger>",
          kind: "<route|endpoint|message|consumer|worker|job|schedule|command|tool|screen|server-start|other-flow>",
          summary: "<what this one flow does>",
          confidence: "<high|medium|low>",
          entrypoints: ["<method + route, command, tool name, topic, schedule, or other trigger>"],
          files: [{ path: "<root-relative source path>", role: "<entrypoint|handler|service|store|other>" }],
          evidence: [{ path: "<root-relative source path>", startLine: 1, endLine: 2 }],
          stateChanges: [
            {
              item: "<domain item or artifact whose state changes>",
              from: "<previous state or null when created>",
              to: "<next state or null when deleted>",
              trigger: "<code action that causes the change>",
              description: "<plain-language explanation of the change>",
              files: [{ path: "<root-relative source path>", role: "<writer|store|publisher|other>" }],
              evidence: [{ path: "<root-relative source path>", startLine: 1, endLine: 2 }],
            },
          ],
          relatedFlows: ["<other-flow-id>"],
          interactions: [
            {
              name: "<short user action label, e.g. submit, delete row, toggle filter>",
              trigger: "<concrete UI event, e.g. click on Save button, submit of search form>",
              description: "<what the handler does in plain language>",
              files: [{ path: "<root-relative source path>", role: "<handler|mutation|api-call|other>" }],
              evidence: [{ path: "<root-relative source path>", startLine: 1, endLine: 2 }],
            },
          ],
        },
      ],
      pages: [
        {
          slug: "<category>/<specific-flow-slug>",
          title: "<same concrete flow title>",
          kind: "<same category as the referenced flow kind, such as tool|command|route|message|job|schedule|screen>",
          flowIds: ["<stable-flow-id>"],
          primaryFiles: ["<root-relative source path>"],
          mustCover: ["<important behavior this page must explain>"],
          inputs: ["<optional request parameter, command flag, tool argument, config value, file path, message, schedule, or user action>"],
          outputs: ["<optional response, returned value, persisted artifact, or side effect this page must describe>"],
          openQuestions: [],
        },
        {
          slug: "<one of: architecture|data-model|module-map|runtime-lifecycle|configuration|integrations>",
          title: "<human title for the overview>",
          kind: "<matching overview:* kind>",
          primaryFiles: [
            "<root-relative source path 1>",
            "<root-relative source path 2>",
            "<root-relative source path 3>",
          ],
          mustCover: ["<topic this overview must explain>"],
          openQuestions: [],
        },
      ],
    }),
    "```",
    "",
    "When `wiki/_discovery.json` is written, call `wiki(validate-discovery)`.",
  ].join("\n");
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

function writeCoordinatorPrompt(): string {
  return [
    "You are coordinating wiki page writing from validated discovery data.",
    "",
    "Your job is to split the page-writing work by page slug. Do not write all pages yourself unless there is only one page.",
    "",
    "Start here:",
    "",
    "1. Call `wiki(discovery)` to get the compact list of flows and pages.",
    "2. Split the `pages[]` list by `slug`.",
    "3. Assign different page slugs to different subagents for faster writing.",
    "4. Tell each subagent to call `wiki(write:page:<slug>)` with its assigned slug.",
    "5. Make sure each subagent owns different output files under `wiki/`.",
    "",
    "Each page writer should only write its assigned page or pages. Page writers should not redo discovery and should not edit unrelated wiki pages.",
    "",
    "After all assigned page writers finish, call `wiki(validate-pages)` to check that every relative `.md` link in the wiki resolves to an existing file. Fix any broken links it reports before stopping.",
  ].join("\n");
}

function sourceFirstWritingContract(): string[] {
  return [
    "Source-first writing contract:",
    "",
    "- Treat discovery, page packets, and `mustCover` items as a map of what to investigate, not as text to copy into the page.",
    "- The page must teach verified behavior from source: what starts the flow, what code runs, what data moves, what state changes, what can fail, and what the caller or user observes.",
    "- Explain concepts before relying on internal names. Name functions, types, tables, files, and flags only after explaining the idea they serve.",
    "- Expand thin packet bullets into source-backed explanations. If a packet says `response`, explain where the response is built, what shape it has, which branch returns it, and what errors or empty states change it.",
    "- Do not paste discovery summaries, `mustCover` wording, or file lists as the page body. Reopen the code and turn them into plain-language behavior.",
    "- Never let pipeline vocabulary reach the reader. The words `mustCover`, `discovery`, `discovery packet`, `page packet`, `the packet`, `flowId`/`flowIds`, and raw flow ids such as `flow-tool-search` must not appear anywhere in the page body — the reader has never seen the generation pipeline. For cross-references write a plain Markdown link (for example `[index_status](../tools/index-status.md)`), never a bare flow id or slug.",
    "- When a `mustCover` item, packet summary, or input/output hint disagrees with the source, write only the real behavior, plainly, as fact. Do not narrate the disagreement: never write sentences like \"the packet says X but the code does Y\", \"the mustCover item names Z\", or \"the discovery brief lists W\". The correction must be invisible — state the verified behavior and move on.",
    "- Keep examples realistic but clearly synthetic unless every value was just verified from current source.",
    "",
  ];
}

function sourceFirstSelfCheck(): string[] {
  return [
    "Source-first self-check:",
    "",
    "1. For every paragraph, ask whether it explains code behavior or only repeats discovery text. Rewrite repeated discovery text from source.",
    "2. For every `mustCover` item, confirm the page answers: what is it, where does it happen, why does it matter, and what source proves it?",
    "3. For every input, output, state change, failure case, and example, confirm it matches source behavior and not an assumption.",
    "4. If a section feels compact or dry, do not add filler. Reopen the relevant source and add the missing why, data movement, branch, state change, or user-visible result.",
    "5. Scan the whole page for pipeline vocabulary: the words `mustCover`, `discovery`, `packet`, `flowId`, and any `flow-...` slug. If any appears, rewrite that sentence to state the behavior or link plainly. None of these may reach the reader.",
    "6. Confirm every section heading matches what the body and the source actually deliver. Do not promise `ranked`, `line ranges`, `annotations`, or any field the code does not produce; rename the heading to match reality.",
    "",
  ];
}

function writePagePrompt(slug: string, kind: string | undefined): string {
  if (isOverviewKind(kind)) return writeOverviewPagePrompt(slug, kind!);
  if (kind === "screen") return writeScreenPagePrompt(slug);
  return [
    "You are writing one wiki page from validated discovery data.",
    "",
    `Assigned page slug: \`${slug}\``,
    "",
    `Your job is to write \`wiki/${slug}.md\`. Do not edit other wiki pages. Do not redo the whole discovery process. Use the page packet and referenced flows as a map, then read the referenced source before writing.`,
    "",
    "Start here:",
    "",
    "1. Read the page item included in this prompt.",
    "2. Read the referenced flows included in this prompt.",
    "3. Read the source files named in `page.primaryFiles`, `flows[].files`, `flows[].evidence`, and `flows[].stateChanges[].evidence`. Follow the flow from trigger to observable result before writing.",
    "4. Use `wiki(prefetch:map:<path>)` and `wiki(prefetch:annotations:<path>)` for focused context.",
    "5. Use mimirs tools such as `read_relevant`, `search`, `depends_on`, `depended_on_by`, `search_symbols`, and `find_usages` when the named files point to helper code or when you need exact code context.",
    "",
    ...sourceFirstWritingContract(),
    "For the assigned page:",
    "",
    "- Write to `wiki/<slug>.md`.",
    "- Use the page `title` as the H1.",
    "- Do not write a discovery transcript or a summary card. Write a useful engineering page for someone trying to understand, debug, or safely change this flow.",
    "- Do not write from the page packet alone. The packet tells you where to look; the page should explain behavior you verified in the referenced source.",
    "- Let the page length follow the flow. A tiny wrapper may be short; a flow with branching, state changes, background work, or cross-file handoffs should be much deeper.",
    "- Add detail when it explains behavior: why the step exists, what data moves, what state changes, what can fail, and what the caller observes.",
    "- Do not pad. Every extra paragraph should be backed by code evidence or should clarify a real consequence for users, agents, stored state, or maintainers.",
    "- Explain what this one flow does in plain language, including when someone would use it and what problem it solves.",
    "- Add a Mermaid sequence diagram with `autonumber` when the page describes a flow. In Mermaid labels use `<br>` for line breaks — never `\\n`, which renders as a literal backslash-n. Never use a reserved word (`graph`, `subgraph`, `end`, `class`, `state`, `click`) as a node or participant id; suffix it (for example `endNode`) instead.",
    "- Add a numbered list below the diagram that explains each diagram step with more context.",
    "- Add an `Inputs` section when the page has `inputs`, formatted as a Markdown table with columns name, type, required, and description. Cover every item in that array, focusing on what the caller, environment, schedule, message, config, or file system provides to the flow.",
    "- Add an `Outputs` section when the page has `outputs`, formatted as a Markdown table with columns output and where it lands / shape / description. Cover every item in that array, focusing on what the flow returns, writes, updates, starts, publishes, or otherwise changes.",
    "- When the page compares this flow against a sibling flow (this tool vs that tool, this command vs that command) or lists a fixed set (models, exit codes, command grammar, allowed types), use a Markdown table rather than prose bullets. Tables scan faster and are the preferred format for any small comparison or enumeration.",
    "- Add a `State changes` section when the referenced flows include `stateChanges`. Name each item, show the before and after state, explain why the change matters, and cite the code that performs the change.",
    "- Add a `Branches and failure cases` section and enumerate every branch you can verify in source: empty-result paths, missing-input handling, optional flags, lock/query-only modes, startup phases, abort or cancellation, and error handling. Prefer listing every real branch over summarizing a few.",
    "- Add an `Example` section when useful. For MCP tools, show example arguments JSON. For CLI pages, show an example command. For server-start pages, show the lifecycle phases.",
    "- Example output blocks are illustrative, not factual. If you show a sample output, the shape and field names should match what the command actually emits, but specific values such as file paths, line numbers, ids, timestamps, or hashes should be either obviously synthetic (`src/example.ts:42`, `<commit-sha>`) or verified against current source. Do not paste real-looking paths or identifiers that you have not just confirmed exist.",
    "- Treat `mustCover` as the list of required topics for this page. Every item in `page.mustCover` must be explained in the page body, with source-backed detail when possible.",
    "- Use citations sparingly. Cite the main source location for each section, surprising behavior, non-obvious constraint, or important cross-file handoff. Do not cite every sentence or every diagram step.",
    "- Prefer one root-relative inline-code citation per paragraph or bullet when several claims come from nearby code, for example `src/server.ts:42` or `src/search/hybrid.ts:10`. Do not use Markdown links for source-file citations.",
    "- Add a short `Key source files` section when a page touches several files, listing each important root-relative file path and what role it plays.",
    "- Mention important `openQuestions` instead of hiding uncertainty.",
    "- Only link to related pages whose subject is named in `relatedFlows`, appears as a caller or callee of `primaryFiles`, or is otherwise structurally connected in source. Do not invent thematic relationships.",
    "- Keep the page focused on its assigned `slug`, `flowIds`, and `primaryFiles`.",
    "",
    "Self-check before finishing:",
    "",
    "1. Re-read the page you just wrote, paragraph by paragraph.",
    "2. For each inline citation like `src/foo.ts:42` or `src/foo.ts:10-20`, open that file and confirm the cited range actually contains what the surrounding sentence claims. When it does not match, first try to find the real location in the source and correct the line number; only remove the citation if no such location exists.",
    "3. For each function, type, constant, command, flag, or tool name you named in the body, confirm it exists in the referenced source. When it does not, search the source for the real name and replace the invented one; only delete the claim if no real equivalent exists.",
    "4. For each diagram step and each numbered list item, confirm there is source evidence for that step. When a step is wrong but the underlying behavior is real, rewrite the step to match the code; only remove the step when no backing behavior exists.",
    "5. For each `mustCover` item, confirm the page explains it from verified source behavior, not from rephrasing the packet summary. When the explanation is thin or wrong, reopen the source and rewrite it from what the code actually does.",
    "6. For each state change, input, and output you described, confirm it matches the discovery entry and the cited code. When they disagree, correct the page to match the code; only drop the item when no evidence supports it at all.",
    "7. Prefer correcting over deleting. Reach for the source first and fix the claim. Delete only when the source shows no matching behavior. A shorter accurate page beats a longer page with invented detail, but an accurate page that explains the real behavior beats both.",
    "",
    ...sourceFirstSelfCheck(),
  ].join("\n");
}

function writeScreenPagePrompt(slug: string): string {
  return [
    "You are writing one wiki page for a frontend UI screen from validated discovery data.",
    "",
    `Assigned page slug: \`${slug}\``,
    "",
    `Your job is to write \`wiki/${slug}.md\`. This is a screen page, not a backend flow page. A screen lives over time, renders a component tree, and reacts to user interactions, so the page shape is different from request/response flow pages. Do not edit other wiki pages. Do not redo the whole discovery process.`,
    "",
    "Start here:",
    "",
    "1. Read the page item and the referenced screen flow included in this prompt.",
    "2. Read the source files named in `page.primaryFiles`, `flows[].files`, `flows[].evidence`, `flows[].interactions[].evidence`, and `flows[].stateChanges[].evidence`. Trace mount, render, and each interaction in the source before writing.",
    "3. Use mimirs tools such as `read_relevant`, `search`, `project_map`, `depends_on`, `depended_on_by`, `search_symbols`, and `find_usages` to map the component tree, find state owners, and locate API call sites.",
    "",
    ...sourceFirstWritingContract(),
    "For the assigned page:",
    "",
    "- Write to `wiki/<slug>.md`.",
    "- Use the page `title` as the H1.",
    "- Open with one short paragraph: what this screen is, where it lives (route path or mount point), and what the user can do on it. Cite the route registration or mount site with a root-relative inline citation such as `src/app/routes.ts:42`.",
    "- Add a `Mount-time flow` section with a Mermaid sequence diagram (use `autonumber`). Cover what happens from route match or mount through first paint: route params parsed, props read, store slices subscribed, server data fetched, first render. Below the diagram, add a numbered list explaining each step with source citations. In every Mermaid diagram on this page, use `<br>` for label line breaks — never `\\n`, which renders literally — and never use a reserved word (`graph`, `subgraph`, `end`, `class`, `state`, `click`) as a node id; suffix it instead.",
    "- Add a `Component tree` section with a Mermaid `graph` diagram of the rendered tree. Include every component that materially owns or consumes state, fetches data, or handles a user interaction. Do not cap the depth — render the full structure even when it is large; readers can scroll. The shape is a guide, not a contract: single-page apps often have one root with many flat siblings, and that is fine — do not force a deeper hierarchy than the code has. Where applicable, annotate nodes with `(owns: ...)` for the state they define and `(consumes: ...)` for store slices, contexts, or refs they read. These annotations carry most of the signal when the diagram itself is flat; treat them as required whenever a node owns or consumes external state. Below the diagram, add short bullets only for nodes that need explanation; do not narrate the whole tree.",
    "- Add an `Interactions` section. For every entry in `flows[].interactions[]`, add an `###` sub-section using the interaction `name` as the heading. Each sub-section must include: the concrete trigger, a short Mermaid sequence diagram tracing handler → state change → API call → store update → re-render, source citations for the handler and any mutation or API call, and a one-line note on what the user sees afterwards. Triggers do not have to be clicks: keyboard shortcuts registered via `document.addEventListener` or hotkey hooks, window-level events such as `hashchange`, `focus`, `blur`, `visibilitychange`, `beforeunload`, and same-page URL mutations all count as legitimate trigger sources for an interaction. Name the concrete event source in the trigger line (for example \"keydown Alt+Shift+D on document\", \"window hashchange event\"). If an interaction has error or empty states grounded in source, mention them inline in its sub-section, not in a separate failures section. When the handler implementation lives outside `primaryFiles` (for example in a sibling package or in the upstream library this screen embeds), still cite it; describe the screen's *use* of that handler, not its full implementation.",
    "- Add a `State surface` section as a table with columns `Name | Scope | Owner`, listing each state slice this screen reads or writes. `Scope` is local, store, server-cache, url, persisted (localStorage / IndexedDB), or other. `Owner` is the file and symbol that defines or initializes it. Only include slices grounded in source.",
    "- Add an `API surface` section as a table with columns `Endpoint | Transport | Call site`. List each backend endpoint or external integration this screen makes. `Endpoint` is the path, URL, topic, or channel as it appears in source (do not invent base URLs). `Transport` covers the wire kind, not just HTTP — examples: `GET`, `POST`, `WebSocket`, `SSE`, `Firebase RTDB`, `Firebase Storage`, `IndexedDB`, `postMessage`, `GraphQL query`. Use whatever label honestly describes the integration. `Call site` is a root-relative file path and line such as `src/screens/checkout/api.ts:42`. Do not link to backend flow pages; the path string is enough.",
    "- Add an `Entry points and transitions` section with two short lists: `In` (how users or other code reach this screen) and `Out` (where the screen sends them). Cover route-level navigation (router push/replace, `<Link>` components), URL mutations done from this screen (`window.location.hash`, `history.pushState`, `replaceState`), window-level handoffs (`window.open`, parent-window `postMessage`), and inbound triggers from URL hashes, query strings, or deep links when the screen is no-router. Cite the call sites. Omit either list when there is none.",
    "- Do not add `Inputs`, `Outputs`, `Branches and failure cases`, or `State changes` sections; the shape above replaces them for screen pages. If the discovery entry has `stateChanges`, fold them into the relevant interaction sub-section or the `State surface` table where they fit.",
    "- Add a short `Key source files` section at the end listing each important root-relative file path and its role (route registration, top-level component, child component, store, API client).",
    "- Treat `mustCover` as the list of required topics. Every item in `page.mustCover` must be explained somewhere in the page body, with source-backed detail.",
    "- Use citations sparingly. Cite the main source location for each section, each interaction handler, each API call, and any surprising behavior. Prefer one root-relative inline-code citation per paragraph or bullet such as `src/screens/checkout/page.tsx:42`. Do not use Markdown links for source-file citations.",
    "- Mention important `openQuestions` instead of hiding uncertainty.",
    "",
    "Self-check before finishing:",
    "",
    "1. Re-read the page paragraph by paragraph.",
    "2. For each inline citation like `src/foo.tsx:42` or `src/foo.tsx:10-20`, open the file and confirm the cited range actually contains what the surrounding sentence claims. Fix wrong line numbers from the real source; only remove a citation when no equivalent exists.",
    "3. Confirm every component, hook, store slice, endpoint, and handler you named exists in the referenced source. Replace invented names with the real ones.",
    "4. Confirm each node in the component-tree diagram is a real component reachable from this screen's root, and each interaction sub-section corresponds to a real handler in source. Rewrite or remove nodes and interactions that do not match the code.",
    "5. Confirm the `State surface` and `API surface` tables match what the code actually does: each row is grounded in a real read, write, or request you can point at.",
    "6. For each `mustCover` item, confirm the page explains it from verified source behavior, not from rephrasing the packet summary.",
    "7. Prefer correcting over deleting. Reach for the source first and fix the claim. Delete only when the source shows no matching behavior.",
    "",
    ...sourceFirstSelfCheck(),
  ].join("\n");
}

function writeOverviewPagePrompt(slug: string, kind: string): string {
  const overviewKindDescription: Record<string, string> = {
    "overview:architecture": "the project's components and how they communicate at runtime",
    "overview:data-model": "the project's persistent state, on-disk layout, and storage schema",
    "overview:module-map": "the project's top-level packages or directories, their responsibilities, and the import boundaries between them",
    "overview:runtime-lifecycle": "the project's long-running process from boot through ready, request handling, and shutdown",
    "overview:configuration": "the project's configuration surface: env vars, config files, flag precedence, and defaults",
    "overview:integrations": "the external services this project talks to, including databases, APIs, queues, and model providers",
  };
  const diagramRequired = !OVERVIEW_DIAGRAM_EXEMPT.has(kind);
  return [
    "You are writing one wiki overview page from validated discovery data.",
    "",
    `Assigned page slug: \`${slug}\``,
    `Overview kind: \`${kind}\``,
    "",
    `Your job is to write \`wiki/${slug}.md\`. This is a bird's-eye overview, not a flow page. It should explain ${overviewKindDescription[kind] ?? "a cross-cutting aspect of the project"} by tying together multiple flows.`,
    "",
    "Start here:",
    "",
    "1. Read the page item included in this prompt.",
    "2. Read every file named in `page.primaryFiles`. These are the load-bearing source files for this overview.",
    "3. Read the listed `flows[]` to understand which entry-point behaviors this overview ties together.",
    "4. Use `wiki(prefetch:map:<path>)`, `wiki(prefetch:annotations:<path>)`, `read_relevant`, `search`, `depends_on`, `depended_on_by`, `search_symbols`, and `find_usages` to verify structure before writing.",
    "5. Read the existing flow pages this overview will link to, so the links are accurate and use the right slugs.",
    "",
    ...sourceFirstWritingContract(),
    "For the assigned overview page:",
    "",
    "- Write to `wiki/<slug>.md`.",
    "- Use the page `title` as the H1.",
    "- Open with one paragraph that says what this overview covers and who it helps. Do not repeat the per-flow detail that lives on flow pages.",
    diagramRequired
      ? "- Include at least one diagram. Use `graph` or `flowchart` for component/module/integration relationships, or `erDiagram` for data-model schemas. Sequence diagrams are usually wrong here; they belong on flow pages. In Mermaid labels use `<br>` for line breaks — never `\\n`, which renders literally. Never use a reserved word (`graph`, `subgraph`, `end`, `class`, `state`, `click`) as a node id; suffix it instead."
      : "- Diagrams are optional for configuration overviews. Tables of env vars, config keys, and precedence rules are usually more useful than a diagram.",
    "- Cite at least three source files with root-relative paths and line ranges inline (for example `src/server.ts:42-80`). Spread citations across the body, not in a single dump.",
    "- Link to at least two flow pages by relative markdown link (for example `[mimirs serve](cli/serve.md)`). Only link to flow pages whose subject is structurally connected to this overview's `primaryFiles` or to the kind's topic.",
    "- Cover every item in `page.mustCover` with source-backed explanation.",
    "- Write for a maintainer deciding where to change code. Prefer concrete, actionable specifics over smooth narrative: name the exact seam to edit (for example \"add a tool by adding a `registerX` import plus one call in `src/tools/index.ts`\"), state each invariant and where it is enforced, and reproduce exhaustive reference material where it earns its place — a full config-field table with read sites, every shutdown trigger, the complete schema. Do not abstract a concrete mechanism into a generic description; if a behavior is a specific contract, keep the contract, not a paraphrase of it.",
    "- Explain how the pieces hang together and why. Name the contracts, the boundaries, and the invariants. Do not list symbols, do not dump types, do not paste import statements.",
    "- Add an `Open questions` section only when `openQuestions` is non-empty.",
    "- Add a short `Key source files` section at the end listing each cited root-relative file path and its role in this overview.",
    "- Do not write a sequence-of-events numbered list. That format belongs on flow pages. Use narrative paragraphs grouped by the natural sub-topics of this overview.",
    "- Keep the page focused on its assigned `kind`. Do not drift into flow-level detail; defer to the linked flow pages for that.",
    "",
    "Self-check before finishing:",
    "",
    "1. Re-read the page paragraph by paragraph.",
    "2. Confirm every inline citation `src/foo.ts:42` or `src/foo.ts:10-20` points at code that actually shows what the surrounding sentence claims. Fix wrong line numbers from the real source; only remove a citation when no equivalent exists.",
    "3. Confirm every function, type, table, file path, env var, or service name you named exists in the referenced source.",
    "4. Confirm at least three distinct source files are cited and at least two flow pages are linked. If not, go back and add the missing material from source rather than padding.",
    diagramRequired
      ? "5. Confirm the page has at least one diagram and that every node or relationship in it is grounded in real code."
      : "5. Confirm any tables of config keys, env vars, or precedence rules match the actual loader code.",
    "6. For each `mustCover` item, confirm the explanation comes from verified source behavior, not from rephrasing the packet summary.",
    "7. Prefer correcting over deleting. A shorter accurate overview beats a longer one with invented structure.",
    "",
    ...sourceFirstSelfCheck(),
  ].join("\n");
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

export async function runWikiRebuild(ctx: WikiContext, input: string): Promise<string> {
  const command = parseWikiCommand(input);

  if (command.mode === "shape") {
    const prefetch = await buildPrefetch(ctx);
    await mkdir(wikiDir(ctx.projectDir), { recursive: true });
    await writeJSON(prefetchPath(ctx.projectDir), prefetch);
    const readiness = prefetchReadiness(prefetch);
    return [
      `Wrote \`wiki/${PREFETCH_FILE}\`.`,
      ...(readiness ? ["", readiness] : []),
      "",
      discoveryPrompt(),
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
    if (!selector) return writeCoordinatorPrompt();
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
      writePagePrompt(slug, packet.page.kind),
      "",
      "## Page packet",
      "",
      "```json",
      renderJSON(packet),
      "```",
    ].join("\n");
  }

  throw new Error(`Unknown wiki command '${input}'. Try \`shape\`, \`prefetch\`, \`validate-discovery\`, \`discovery\`, \`write\`, or \`validate-pages\`.`);
}
