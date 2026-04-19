import { z } from "zod";
import { join, relative, dirname, resolve } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GetDB, resolveProject } from "./index";
import { findGitRoot, runGit } from "./git-tools";
import { runWikiPlanning, getPagePayload } from "../wiki";
import { classifyStaleness, type StalenessReport } from "../wiki/staleness";
import { appendInitLog, appendIncrementalLog } from "../wiki/update-log";
import type {
  PageManifest,
  ContentCache,
  ClassifiedInventory,
  DiscoveryResult,
  PagePayload,
  WikiPlanResult,
} from "../wiki/types";
import type { RagDB } from "../db";

const WRITING_RULES = `## Writing Rules

- **Section library, not templates.** Module and file pages are composed from a named section library. Each page payload lists candidate sections with \`matched: true\` (predicate fired on prefetched data) or \`matched: false\` (ineligible or unsupported). Use the matched sections; skip the rest. You may add a section outside the library when the signal is strong and specific, but never stub an empty heading.
- **Aggregate pages use exemplars.** Architecture, data-flows, getting-started, conventions, testing, and index pages each reference a full example page via \`exemplarPath\`. Read it, then adapt — replace \`<!-- adapt ... -->\` comments and angle-bracket placeholders with this project's concrete names. Reuse named sections where the exemplar cites them.
- **Links**: Use ONLY the exact relative paths from the "Link map" section in each page payload. Never compute relative paths yourself. Never use Obsidian \`[[wikilinks]]\`.
- **Filenames**: Kebab-case always (\`hybrid-search.md\`, not \`HybridSearch.md\`).
- **Cross-references**: When the link map contains related pages, add a "See also" section (lowercase "also"). Link module names on first occurrence per section. Always look up the link in the link map.
- **Diagrams — shape**: Use Mermaid fenced blocks. \`flowchart LR\` for pipeline / ingest → service → storage architectures (most system maps land here — multiple orchestrators fanning into shared services produce far fewer crossing edges in LR than in TD). \`flowchart TD\` only for genuinely tree-like hierarchies. \`sequenceDiagram\` for runtime flows. Match the diagram type to the thing being shown.
- **Diagrams — inclusion is required when matched**: If a page's candidate-section list shows \`how-it-works-sequence\` as matched, include a Mermaid \`sequenceDiagram\` in the How it works section — this is not optional, the matcher already confirmed ≥2 files or ≥1 entry point. If \`dependency-graph\` is matched (≥3 edges), include a \`flowchart LR\`. For the architecture page, include both the system map and a Cross-cutting dependencies block (see the existing cross-cutting rule).
- **Diagrams — layout discipline**: Each subgraph should represent one column in the flow (Surface → Pipelines → Services → Storage, or similar). Routing / dispatch nodes (things that fan out to many consumers — e.g. MCP tool registries, CLI dispatchers) belong in the Surface column with their caller, not in a "Shared" bucket downstream; placing a high-fan-out node downstream forces its edges to loop back across the diagram.
- **Diagrams — budget (system maps)**: Architecture-style maps have hard caps of **≤ 12 nodes AND ≤ 18 edges**. Node count alone is not enough; edge density is what kills readability. If the real graph has more edges, draw a slice and name the slice in the caption (e.g. "control flow, excluding cross-cutters").
- **Diagrams — subgraph size**: When grouping, **≤ 4 nodes per subgraph**, **3–5 subgraphs total**. Break or merge if you exceed either.
- **Diagrams — cross-cutting dependencies**: Modules used by nearly everything (logging, config, shared utils) must be **removed from the main system map entirely** — not merely stripped of their edges. Pull them into a **separate small Mermaid block** below the main map, under its own \`## Cross-cutting dependencies\` heading, with edges only from the cross-cutter to its direct consumers. Leaving cross-cutter nodes in the main map without edges still clutters the layout. The main diagram keeps its control-flow shape readable; the secondary diagram preserves the "who uses the cross-cutters" information. Never draw 5+ dotted "used by" lines on the main map.
- **Mermaid reserved words**: Never use as bare node IDs: \`graph\`, \`subgraph\`, \`end\`, \`style\`, \`classDef\`, \`click\`, \`default\`, \`node\`, \`edge\`. Always suffix them.
- **Mermaid edge labels and node text**: Plain text only — Mermaid does not support backslash escaping. If a label contains \`(\`, \`)\`, \`[\`, \`]\`, \`{\`, \`}\`, \`|\`, \`"\`, or spaces that matter, wrap the whole label in double quotes. Examples: \`A -. "server.tool(name, schema, handler)" .-> B\`, \`id["MCP server instance"]\`, \`db[("SQLite + vec0")]\`. Never write \`\\(\` or \`\\)\`.
- **Signatures**: Only write what the pre-fetched data shows. Never fabricate or paraphrase signatures.
- **Prose**: Paragraphs over bullet lists. Be specific ("applies +10% per word match" not "applies boosts"). Lead with what, then how, then why.
- **No guessing, no placeholders**: Skip any section whose data is empty. Never leave a heading followed immediately by another heading.
- **Depth contract**:
  - \`brief\` — the initial payload inlines all signal data. Write a concise narrative around it; do not fetch additional sections.
  - \`standard\` — use 2-4 matched sections whose data supports them.
  - \`full\` — use every matched section that applies, expanded with per-file detail.
- **Do NOT index**: Never call \`index_files()\` on the wiki directory. Wiki pages are generated output, not source code.`;

const WORKFLOW_TIPS = `## Context Management

- **Write each page immediately after fetching its data.** Do not batch-fetch data for multiple pages before writing. Page N's source code is noise while writing page N+10.
- **Parallelize across independent pages.** Each \`generate_wiki(page: N)\` reads pre-built JSON — no runtime dependency between sibling pages. Process module pages and db sub-pages in batches of 3-5 in parallel: issue the \`page: N\` calls concurrently, compose each page's content independently, and write the files concurrently. Within a single page, still fetch sections in parallel and finish that page before handing it off. Aggregate pages (architecture, data-flows, getting-started, conventions, testing, index) depend on the module pages being on disk, so write aggregate pages *after* the module+sub-page batches complete.
- **Read each exemplar once.** Aggregate pages point to an exemplar file (\`exemplarPath\`). Read each exemplar the first time you encounter that focus, then reuse from memory.
- **Prefetched data already contains source code.** The \`exports\` and \`overview\` sections return full signatures and snippets. Skip reading the source file unless you need context beyond what sections provide.
- **Aggregate pages** (architecture, data-flows, etc.) rely on \`read_relevant\` queries more than structured sections. Lean on the semantic queries listed in the page metadata and the exemplar's shape.
- **Write module pages first, then their sub-pages, then aggregate pages.** This way you build up knowledge of the codebase before writing synthesis pages.`;

export function registerWikiTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "generate_wiki",
    "Generate a structured markdown wiki. Modes: (1) No page arg → runs discovery + planning, writes JSON artifacts, returns page list. (2) page: N → returns lightweight summary with candidate sections, exemplar path (aggregate pages), link map, semantic queries, and a data manifest listing available sections. (3) page: N, section: 'exports' → returns full data for that section. Sections: exports, dependencies, dependents, usages, neighborhood, overview. Use section: 'library:<name>' to fetch a section-library example. (4) finalize: true → validation instructions. (5) resume: true → checks which pages exist on disk and returns remaining work. (6) incremental: true → diffs the working tree against the manifest's lastGitRef, refreshes artifacts, and returns only pages whose sources changed.",
    {
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      page: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Page index to generate. Call without page first to get the page list."),
      section: z
        .string()
        .optional()
        .describe("Section to fetch for the page: exports, dependencies, dependents, usages, neighborhood, overview"),
      finalize: z
        .boolean()
        .optional()
        .describe("Run linking pass, validation, and generate index page"),
      resume: z
        .boolean()
        .optional()
        .describe("Check which pages are already written and return remaining work"),
      incremental: z
        .boolean()
        .optional()
        .describe("Re-plan against the stored lastGitRef; regenerate only pages whose source files changed. Requires an existing manifest."),
    },
    async ({ directory, page, section, finalize, resume, incremental }) => {
      const { db: ragDb, projectDir } = await resolveProject(directory, getDB);
      const wikiDir = join(projectDir, "wiki");

      // ── Finalize mode ──
      if (finalize) {
        return {
          content: [{
            type: "text" as const,
            text: buildFinalizeInstructions(),
          }],
        };
      }

      // ── Resume mode ──
      if (resume) {
        return {
          content: [{
            type: "text" as const,
            text: buildResumeResponse(wikiDir, projectDir),
          }],
        };
      }

      // ── Incremental mode ──
      if (incremental) {
        const text = await buildIncrementalResponse(ragDb, projectDir, wikiDir);
        return { content: [{ type: "text" as const, text }] };
      }

      // ── Page mode ──
      if (page !== undefined) {
        return {
          content: [{
            type: "text" as const,
            text: buildPageResponse(wikiDir, page, section),
          }],
        };
      }

      // ── Init mode ──
      // If a manifest already exists, route to incremental instead of re-planning.
      // A bare `generate_wiki()` call used to silently overwrite `lastGitRef`,
      // clobbering the incremental baseline for any commits since the last init.
      if (existsSync(join(wikiDir, "_manifest.json"))) {
        const text = await buildIncrementalResponse(ragDb, projectDir, wikiDir);
        return { content: [{ type: "text" as const, text }] };
      }

      const status = ragDb.getStatus();
      if (status.totalFiles === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "The index is empty — run `index_files()` first, then call `generate_wiki()` again.",
          }],
        };
      }

      // Get git ref
      let gitRef = "unknown";
      try {
        gitRef = execSync("git rev-parse --short HEAD", { cwd: projectDir })
          .toString()
          .trim();
      } catch {
        // Not a git repo or git not available
      }

      // Run phases 1-3 + pre-fetch
      const result = runWikiPlanning(ragDb, projectDir, gitRef);

      // Write artifacts
      mkdirSync(wikiDir, { recursive: true });
      writeFileSync(
        join(wikiDir, "_discovery.json"),
        JSON.stringify(result.discovery, null, 2),
      );
      writeFileSync(
        join(wikiDir, "_classified.json"),
        JSON.stringify(result.classified, null, 2),
      );
      writeFileSync(
        join(wikiDir, "_manifest.json"),
        JSON.stringify(result.manifest, null, 2),
      );
      writeFileSync(
        join(wikiDir, "_content.json"),
        JSON.stringify(result.content, null, 2),
      );

      appendInitLog(wikiDir, gitRef, result.manifest);

      return {
        content: [{
          type: "text" as const,
          text: buildInitResponse(result.manifest, result.warnings),
        }],
      };
    },
  );
}

function buildInitResponse(manifest: PageManifest, warnings: string[]): string {
  const pages = Object.entries(manifest.pages).sort(([, a], [, b]) => a.order - b.order);
  const pageCount = pages.length;

  // Count by tier
  const counts: Record<string, number> = {};
  for (const [, p] of pages) {
    counts[p.tier] = (counts[p.tier] ?? 0) + 1;
  }

  const summary = Object.entries(counts)
    .map(([tier, count]) => `${count} ${tier}`)
    .join(", ");

  let text = `# Wiki Generation Plan\n\n`;
  text += `Computed ${pageCount} pages: ${summary}\n\n`;

  if (warnings.length > 0) {
    text += `**Warnings:**\n`;
    for (const w of warnings) text += `- ${w}\n`;
    text += `\n`;
  }

  text += `## Page list (generation order)\n\n`;
  for (let i = 0; i < pages.length; i++) {
    const [path, page] = pages[i];
    const kindLabel = page.focus ?? page.kind;
    text += `${i}. \`${path}\` — ${page.title} (${kindLabel}, ${page.depth})\n`;
  }

  text += `\n${WRITING_RULES}\n\n`;

  // Split wave boundaries by tier: module/sub-pages first, aggregates last.
  const lastModuleIdx = (() => {
    for (let i = pages.length - 1; i >= 0; i--) {
      if (pages[i][1].tier === "module") return i;
    }
    return -1;
  })();
  const firstAggregateIdx = (() => {
    for (let i = 0; i < pages.length; i++) {
      if (pages[i][1].tier === "aggregate") return i;
    }
    return pages.length;
  })();

  text += `## Instructions\n\n`;
  text += `Process pages in three waves; within each wave, parallelize:\n\n`;
  text += `**Wave 1 — module and sub-pages (indexes 0 to ${lastModuleIdx}).**\n`;
  text += `For each batch of 3–5 pages:\n`;
  text += `1. Issue \`generate_wiki(page: N)\` calls concurrently for every page in the batch.\n`;
  text += `2. For each returned payload: if \`exemplarPath\` is set, read it; fetch any needed \`section: "…"\` payloads in parallel; then run the listed \`read_relevant\` queries.\n`;
  text += `3. Compose each page and write it — all writes in the batch can run concurrently.\n\n`;
  text += `**Wave 2 — aggregate pages (indexes ${firstAggregateIdx} to ${pageCount - 1}).**\n`;
  text += `Same shape, but wait for Wave 1 to finish first so aggregate pages can reference written module pages.\n\n`;
  text += `**Wave 3 — finalize.** Call \`generate_wiki(finalize: true)\`.\n`;

  text += `\n${WORKFLOW_TIPS}\n`;

  return text;
}

function buildPageResponse(wikiDir: string, pageIndex: number, section?: string): string {
  const manifestPath = join(wikiDir, "_manifest.json");
  const contentPath = join(wikiDir, "_content.json");
  const classifiedPath = join(wikiDir, "_classified.json");

  if (!existsSync(manifestPath)) {
    return "No manifest found. Call `generate_wiki()` first to run the planning phase.";
  }

  const manifest: PageManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const content: ContentCache = JSON.parse(readFileSync(contentPath, "utf-8"));
  const classified: ClassifiedInventory = JSON.parse(readFileSync(classifiedPath, "utf-8"));

  let payload: PagePayload;
  try {
    payload = getPagePayload(pageIndex, manifest, content, classified);
  } catch (e: any) {
    return e.message;
  }

  // Brief pages: inline all data in one response to avoid round-trips
  if (payload.depth === "brief" && !section) {
    return formatBriefInline(payload);
  }

  // Aggregate pages: inline structured data to reduce ad-hoc queries
  if (payload.kind === "aggregate" && payload.focus !== "index" && !section) {
    return formatAggregateInline(payload);
  }

  if (section) {
    return formatSection(payload, section);
  }
  return formatSummary(payload);
}

const VALID_SECTIONS = ["exports", "dependencies", "dependents", "usages", "neighborhood", "overview", "modules", "hubs", "entry-points", "cross-cutting-symbols", "test-files"] as const;
const BATCH_SIZE = 20;

function formatSummary(payload: PagePayload): string {
  let text = `# Page: ${payload.title}\n\n`;
  text += `**Path:** \`${payload.wikiPath}\`\n`;
  const kindLabel = payload.focus ?? payload.kind;
  text += `**Kind:** ${kindLabel} | **Depth:** ${payload.depth}\n`;
  text += `**Source:** \`${payload.sourceFile}\`\n`;
  if (payload.exemplarPath) {
    text += `**Exemplar:** \`${payload.exemplarPath}\` — read this, then adapt to this project.\n`;
  }
  text += `\n`;

  // Candidate sections (section library for module/file pages, named references for aggregates)
  if (payload.candidateSections.length > 0) {
    const matched = payload.candidateSections.filter((s) => s.matched);
    const skipped = payload.candidateSections.filter((s) => !s.matched);
    text += `## Candidate sections\n\n`;
    text += `Matched sections have prefetched data to support them. Skipped sections are listed with reasons so you see the shape without stubbing them.\n\n`;
    if (matched.length > 0) {
      text += `**Matched (${matched.length}):**\n`;
      for (const s of matched) text += `- \`${s.name}\` — ${s.reason}\n`;
    }
    if (skipped.length > 0) {
      text += `\n**Skipped (${skipped.length}):**\n`;
      for (const s of skipped) text += `- \`${s.name}\` — ${s.reason}\n`;
    }
    text += `\nFetch a section's example markdown with \`generate_wiki(page: N, section: "library:<name>")\`.\n\n`;
  }

  // Connectivity (always lightweight)
  if (payload.prefetched.fanIn !== undefined || payload.prefetched.fanOut !== undefined) {
    text += `**Connectivity:** fanIn: ${payload.prefetched.fanIn ?? 0} | fanOut: ${payload.prefetched.fanOut ?? 0}\n\n`;
  }

  // Files list (lightweight, useful context)
  if (payload.prefetched.files && payload.prefetched.files.length > 0) {
    text += `**Files:** ${payload.prefetched.files.join(", ")}\n\n`;
  }

  // Data manifest — what sections are available
  text += `## Available sections\n\n`;
  text += `Fetch what you need with \`generate_wiki(page: N, section: "name")\`.\n`;
  text += `Large sections are batched (${BATCH_SIZE} items each): use \`section: "name:0"\`, \`section: "name:1"\`, etc.\n\n`;

  const p = payload.prefetched;
  if (p.exports && p.exports.length > 0)
    text += sectionEntry("exports", p.exports.length, "full signatures for all exports");
  if (p.dependencies && p.dependencies.length > 0)
    text += sectionEntry("dependencies", p.dependencies.length);
  if (p.dependents && p.dependents.length > 0)
    text += sectionEntry("dependents", p.dependents.length);
  if (p.usageSites && p.usageSites.length > 0)
    text += sectionEntry("usages", p.usageSites.length);
  if (p.neighborhood)
    text += `- **neighborhood** — dependency graph\n`;
  if (p.overview)
    text += `- **overview** — primary symbol source/snippet\n`;
  if (p.modules && p.modules.length > 0)
    text += sectionEntry("modules", p.modules.length, "module inventory with fan-in/out and file counts");
  if (p.hubs && p.hubs.length > 0)
    text += sectionEntry("hubs", p.hubs.length, "high-connectivity files with their bridges");
  if (p.entryPoints && p.entryPoints.length > 0)
    text += sectionEntry("entry-points", p.entryPoints.length, "entry files with their exports");
  if (p.crossCuttingSymbols && p.crossCuttingSymbols.length > 0)
    text += sectionEntry("cross-cutting-symbols", p.crossCuttingSymbols.length, "symbols used across 3+ modules");
  if (p.testFiles && p.testFiles.length > 0)
    text += sectionEntry("test-files", p.testFiles.length, "test/spec files in the project");
  text += `\n`;

  // Semantic queries
  if (payload.semanticQueries.length > 0) {
    text += `## Semantic queries\n\n`;
    text += `Make these \`read_relevant\` calls for content not covered by sections:\n\n`;
    for (const q of payload.semanticQueries) {
      text += `- \`read_relevant("${q.query}", top: ${q.top})\` — ${q.reason}\n`;
    }
    text += `\n`;
  }

  // Related pages — pre-resolved with correct relative links
  if (payload.relatedPages.length > 0) {
    text += `## Related pages (for See Also section)\n\n`;
    for (const r of payload.relatedPages) {
      const match = Object.entries(payload.linkMap).find(([, relPath]) => {
        return relPath === relative(dirname(payload.wikiPath), r);
      });
      if (match) {
        text += `- [${match[0]}](${match[1]})\n`;
      } else {
        const rel = relative(dirname(payload.wikiPath), r);
        text += `- [${r}](${rel})\n`;
      }
    }
    text += `\n`;
  }

  // Link map
  if (Object.keys(payload.linkMap).length > 0) {
    text += `## Link map\n\n`;
    for (const [title, relPath] of Object.entries(payload.linkMap)) {
      text += `- **${title}**: \`[${title}](${relPath})\`\n`;
    }
    text += `\n`;
  }

  // Breadcrumbs
  if (payload.additionalTools.length > 0) {
    text += `## Need more?\n\n`;
    for (const b of payload.additionalTools) {
      const args = Object.entries(b.args)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(", ");
      text += `- \`${b.tool}(${args})\` — ${b.reason}\n`;
    }
    text += `\n`;
  }

  return text;
}

/** Format a reference-module list: cap at 8, then "+N more". */
function formatReferenceModules(modules: string[]): string {
  if (!modules || modules.length === 0) return "—";
  const cap = 8;
  if (modules.length <= cap) return modules.map((m) => `\`${m}\``).join(", ");
  const head = modules.slice(0, cap).map((m) => `\`${m}\``).join(", ");
  return `${head} (+${modules.length - cap} more)`;
}

/** Format a section manifest entry, showing batch info for large sections. */
function sectionEntry(name: string, count: number, desc?: string): string {
  const batches = Math.ceil(count / BATCH_SIZE);
  const descStr = desc ? ` — ${desc}` : "";
  if (batches <= 1) {
    return `- **${name}** (${count} items${descStr})\n`;
  }
  return `- **${name}** (${count} items, ${batches} batches: "${name}:0" … "${name}:${batches - 1}"${descStr})\n`;
}

function formatSection(payload: PagePayload, section: string): string {
  const p = payload.prefetched;

  // Library section: "library:<name>" → return example body from the section library
  if (section.startsWith("library:")) {
    const libName = section.slice("library:".length);
    const candidate = payload.candidateSections.find((s) => s.name === libName);
    if (!candidate) {
      const available = payload.candidateSections.map((s) => s.name).join(", ");
      return `Unknown library section "${libName}". Eligible for this page: ${available}`;
    }
    const matchedNote = candidate.matched ? "✓ matched" : "✗ skipped";
    return `# Library section: ${libName}\n\n_${matchedNote} — ${candidate.reason}_\n\n${candidate.exampleBody}`;
  }

  // Parse batch index: "exports:2" → name="exports", batch=2
  const colonIdx = section.indexOf(":");
  const sectionName = colonIdx >= 0 ? section.slice(0, colonIdx) : section;
  const batchIdx = colonIdx >= 0 ? parseInt(section.slice(colonIdx + 1), 10) : 0;

  switch (sectionName) {
    case "exports":
      if (!p.exports || p.exports.length === 0) return "No exports available for this page.";
      return formatBatchedExports(p.exports, batchIdx);

    case "dependencies":
      if (!p.dependencies || p.dependencies.length === 0) return "No dependencies available for this page.";
      return formatBatchedList("Dependencies", p.dependencies, batchIdx);

    case "dependents":
      if (!p.dependents || p.dependents.length === 0) return "No dependents available for this page.";
      return formatBatchedList("Dependents", p.dependents, batchIdx);

    case "usages":
      if (!p.usageSites || p.usageSites.length === 0) return "No usage sites available for this page.";
      return formatBatchedUsages(p.usageSites, batchIdx);

    case "neighborhood":
      if (!p.neighborhood) return "No neighborhood graph available for this page.";
      return `# Neighborhood\n\n\`\`\`json\n${JSON.stringify(p.neighborhood, null, 2)}\n\`\`\`\n`;

    case "overview":
      if (!p.overview) return "No overview available for this page.";
      return `# Overview\n\n\`\`\`\n${p.overview}\n\`\`\`\n`;

    case "modules":
      if (!p.modules || p.modules.length === 0) return "No module data available for this page.";
      return `# Modules (${p.modules.length})\n\n` +
        `| Module | Files | Exports | Fan-in | Fan-out | Entry file |\n` +
        `|--------|-------|---------|--------|---------|------------|\n` +
        p.modules.map((m) => `| ${m.name} | ${m.fileCount} | ${m.exportCount} | ${m.fanIn} | ${m.fanOut} | ${m.entryFile ?? "—"} |`).join("\n") + "\n";

    case "hubs":
      if (!p.hubs || p.hubs.length === 0) return "No hub data available for this page.";
      return `# Hub files (${p.hubs.length})\n\n` +
        `| File | Fan-in | Fan-out | Bridges |\n` +
        `|------|--------|---------|----------|\n` +
        p.hubs.map((h) => `| ${h.path} | ${h.fanIn} | ${h.fanOut} | ${h.bridges.join(", ") || "—"} |`).join("\n") + "\n";

    case "entry-points":
      if (!p.entryPoints || p.entryPoints.length === 0) return "No entry point data available for this page.";
      return `# Entry points (${p.entryPoints.length})\n\n` +
        p.entryPoints.map((ep) => `## ${ep.path}\n\n${ep.exports.map((e) => `- \`${e.type} ${e.name}\``).join("\n")}`).join("\n\n") + "\n";

    case "cross-cutting-symbols":
      if (!p.crossCuttingSymbols || p.crossCuttingSymbols.length === 0) return "No cross-cutting symbol data available for this page.";
      return `# Cross-cutting symbols (${p.crossCuttingSymbols.length})\n\n` +
        `| Symbol | Type | Defined in | Used in |\n` +
        `|--------|------|------------|---------|\n` +
        p.crossCuttingSymbols.map((s) => `| \`${s.name}\` | ${s.type} | \`${s.file}\` | ${formatReferenceModules(s.referenceModules)} |`).join("\n") + "\n";

    case "test-files":
      if (!p.testFiles || p.testFiles.length === 0) return "No test file data available for this page.";
      return `# Test files (${p.testFiles.length})\n\n` + p.testFiles.map((f) => `- ${f}`).join("\n") + "\n";

    default:
      return `Unknown section "${sectionName}". Valid sections: ${VALID_SECTIONS.join(", ")}`;
  }
}

function formatBriefInline(payload: PagePayload): string {
  let text = formatSummary(payload);
  const p = payload.prefetched;

  if (p.exports && p.exports.length > 0) {
    text += `\n## Exports (${p.exports.length})\n\n`;
    for (const exp of p.exports) {
      text += `### ${exp.name} (${exp.type})\n\n\`\`\`\n${exp.signature}\n\`\`\`\n\n`;
    }
  }

  if (p.dependencies && p.dependencies.length > 0) {
    text += `## Dependencies (${p.dependencies.length})\n\n`;
    text += p.dependencies.map((d) => `- ${d}`).join("\n") + "\n\n";
  }

  if (p.dependents && p.dependents.length > 0) {
    text += `## Dependents (${p.dependents.length})\n\n`;
    text += p.dependents.map((d) => `- ${d}`).join("\n") + "\n\n";
  }

  if (p.usageSites && p.usageSites.length > 0) {
    text += `## Usage sites (${p.usageSites.length})\n\n`;
    text += p.usageSites.map((u) => `- ${u.path}:${u.line}`).join("\n") + "\n\n";
  }

  if (p.overview) {
    text += `## Overview\n\n\`\`\`\n${p.overview}\n\`\`\`\n\n`;
  }

  if (p.neighborhood) {
    const trimmed = trimTo1Hop(p.neighborhood as any, payload.sourceFile);
    if (trimmed) {
      text += `## Neighborhood (1-hop)\n\n\`\`\`json\n${JSON.stringify(trimmed, null, 2)}\n\`\`\`\n\n`;
    }
  }

  return text;
}

function formatAggregateInline(payload: PagePayload): string {
  let text = formatSummary(payload);
  const p = payload.prefetched;

  if (p.modules && p.modules.length > 0) {
    text += `## Modules (${p.modules.length})\n\n`;
    text += `| Module | Files | Exports | Fan-in | Fan-out | Entry file |\n`;
    text += `|--------|-------|---------|--------|---------|------------|\n`;
    for (const m of p.modules) {
      text += `| ${m.name} | ${m.fileCount} | ${m.exportCount} | ${m.fanIn} | ${m.fanOut} | ${m.entryFile ?? "—"} |\n`;
    }
    text += `\n`;
  }

  if (p.entryPoints && p.entryPoints.length > 0) {
    text += `## Entry points (${p.entryPoints.length})\n\n`;
    for (const ep of p.entryPoints) {
      text += `### ${ep.path}\n\n`;
      if (ep.exports.length > 0) {
        text += ep.exports.map((e) => `- \`${e.type} ${e.name}\``).join("\n") + "\n";
      }
      text += `\n`;
    }
  }

  if (p.hubs && p.hubs.length > 0) {
    text += `## Hub files (${p.hubs.length})\n\n`;
    text += `| File | Fan-in | Fan-out | Bridges |\n`;
    text += `|------|--------|---------|----------|\n`;
    for (const h of p.hubs) {
      text += `| ${h.path} | ${h.fanIn} | ${h.fanOut} | ${h.bridges.join(", ") || "—"} |\n`;
    }
    text += `\n`;
  }

  if (p.crossCuttingSymbols && p.crossCuttingSymbols.length > 0) {
    text += `## Cross-cutting symbols (${p.crossCuttingSymbols.length})\n\n`;
    text += `| Symbol | Type | Defined in | Used in |\n`;
    text += `|--------|------|------------|---------|\n`;
    for (const s of p.crossCuttingSymbols) {
      text += `| \`${s.name}\` | ${s.type} | \`${s.file}\` | ${formatReferenceModules(s.referenceModules)} |\n`;
    }
    text += `\n`;
  }

  if (p.testFiles && p.testFiles.length > 0) {
    text += `## Test files (${p.testFiles.length})\n\n`;
    text += p.testFiles.map((f) => `- ${f}`).join("\n") + "\n\n";
  }

  if (p.neighborhood) {
    text += `## Neighborhood\n\n`;
    text += `Available via \`generate_wiki(page: N, section: "neighborhood")\` — ${payload.focus === "architecture" ? "directory-level" : "file-level"} dependency graph.\n\n`;
  }

  return text;
}

function trimTo1Hop(
  graph: { nodes?: any[]; directories?: any[]; edges?: any[] },
  focusPath: string,
): Record<string, unknown> | null {
  const nodes = graph.nodes ?? graph.directories ?? [];
  const edges = graph.edges ?? [];
  if (!focusPath || nodes.length === 0) return null;

  const directEdges = edges.filter(
    (e: any) => e.from === focusPath || e.to === focusPath,
  );

  const neighborPaths = new Set<string>([focusPath]);
  for (const e of directEdges) {
    neighborPaths.add(e.from);
    neighborPaths.add(e.to);
  }
  const directNodes = nodes.filter((n: any) => neighborPaths.has(n.path));

  return {
    ...graph,
    [graph.nodes ? "nodes" : "directories"]: directNodes,
    edges: directEdges,
  };
}

function batchSlice<T>(items: T[], batchIdx: number): { batch: T[]; header: string } {
  const total = items.length;
  const totalBatches = Math.ceil(total / BATCH_SIZE);
  const start = batchIdx * BATCH_SIZE;
  const end = Math.min(start + BATCH_SIZE, total);
  const batch = items.slice(start, end);
  const header = totalBatches > 1 ? ` (batch ${batchIdx + 1}/${totalBatches}, items ${start + 1}-${end} of ${total})` : ` (${total})`;
  return { batch, header };
}

function formatBatchedExports(exports: { name: string; type: string; signature: string }[], batchIdx: number): string {
  const { batch, header } = batchSlice(exports, batchIdx);
  if (batch.length === 0) return `No exports in batch ${batchIdx}.`;
  let text = `# Exports${header}\n\n`;
  for (const exp of batch) {
    text += `## ${exp.name} (${exp.type})\n\n\`\`\`\n${exp.signature}\n\`\`\`\n\n`;
  }
  return text;
}

function formatBatchedList(title: string, items: string[], batchIdx: number): string {
  const { batch, header } = batchSlice(items, batchIdx);
  if (batch.length === 0) return `No ${title.toLowerCase()} in batch ${batchIdx}.`;
  return `# ${title}${header}\n\n${batch.map((d) => `- ${d}`).join("\n")}\n`;
}

function formatBatchedUsages(usages: { path: string; line: number }[], batchIdx: number): string {
  const { batch, header } = batchSlice(usages, batchIdx);
  if (batch.length === 0) return `No usages in batch ${batchIdx}.`;
  return `# Usage sites${header}\n\n${batch.map((u) => `- ${u.path}:${u.line}`).join("\n")}\n`;
}

function buildResumeResponse(wikiDir: string, projectDir: string): string {
  const manifestPath = join(wikiDir, "_manifest.json");
  if (!existsSync(manifestPath)) {
    return "No manifest found. Call `generate_wiki()` first to run the planning phase.";
  }

  const manifest: PageManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const pages = Object.entries(manifest.pages).sort(([, a], [, b]) => a.order - b.order);

  const done: string[] = [];
  const remaining: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    const [wikiPath, page] = pages[i];
    const filePath = join(projectDir, wikiPath);
    if (existsSync(filePath)) {
      done.push(`${i}. \`${wikiPath}\``);
    } else {
      remaining.push(`${i}. \`${wikiPath}\` — ${page.title}`);
    }
  }

  let text = `# Wiki Resume\n\n`;
  text += `**${done.length} of ${pages.length} pages written.**\n\n`;

  if (remaining.length === 0) {
    text += `All pages are written. Nothing to do.\n`;
    return text;
  }

  text += `## Remaining (${remaining.length})\n\n`;
  for (const r of remaining) text += `${r}\n`;

  text += `\n${WRITING_RULES}\n\n`;

  text += `## Instructions\n\n`;
  text += `For each remaining page:\n`;
  text += `1. Call \`generate_wiki(page: N)\` — returns summary, candidate sections, exemplar path, link map, and semantic queries\n`;
  text += `2. If \`exemplarPath\` is set, read it; otherwise compose from matched candidate sections. Fetch data sections you need; write the page\n`;

  text += `\n${WORKFLOW_TIPS}\n`;

  return text;
}

async function buildIncrementalResponse(
  ragDb: RagDB,
  projectDir: string,
  wikiDir: string,
): Promise<string> {
  const manifestPath = join(wikiDir, "_manifest.json");
  if (!existsSync(manifestPath)) {
    return "No manifest found. Call `generate_wiki()` first to run a full planning pass, then re-run with `incremental: true` on subsequent updates.";
  }

  const gitRoot = await findGitRoot(resolve(projectDir));
  if (!gitRoot) {
    return "Not a git repository — incremental mode requires git. Re-run `generate_wiki()` without `incremental` for a full regen.";
  }

  const oldManifest: PageManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const sinceRef = oldManifest.lastGitRef;

  const currentHead = await runGit(["rev-parse", "--short", "HEAD"], gitRoot);
  if (!currentHead) {
    return "Could not read current HEAD. Is this a fresh repo with no commits?";
  }

  // Verify old ref is reachable before diffing
  const sinceReachable = await runGit(["rev-parse", "--verify", `${sinceRef}^{commit}`], gitRoot);
  if (!sinceReachable) {
    return `Manifest's lastGitRef \`${sinceRef}\` is not reachable from this checkout (force-pushed, rebased, or shallow clone). Re-run \`generate_wiki()\` without \`incremental\` for a full regen.`;
  }

  const changedFiles = await getChangedFiles(gitRoot, sinceRef);

  if (changedFiles.size === 0 && currentHead === sinceRef) {
    return `# Wiki Up To Date\n\nNo file changes since \`${sinceRef}\`. Nothing to regenerate.`;
  }

  const status = ragDb.getStatus();
  if (status.totalFiles === 0) {
    return "The index is empty — run `index_files()` first, then re-run incremental.";
  }

  // Re-run full planning against the fresh DB state
  const result = runWikiPlanning(ragDb, projectDir, currentHead);

  // Build entry-point set from fresh discovery for aggregate staleness checks
  const newEntryPoints = new Set(
    result.discovery.graphData.fileLevel.nodes
      .filter((n) => n.isEntryPoint)
      .map((n) => n.path),
  );

  const report = classifyStaleness(
    oldManifest,
    result.manifest,
    result.classified,
    newEntryPoints,
    changedFiles,
  );

  const dirty = report.stale.length + report.added.length;
  const shouldFallBack = dirty > result.manifest.pageCount * 0.5;

  // Always persist the fresh artifacts so page: N calls see the new manifest
  writeArtifacts(wikiDir, result);

  if (shouldFallBack) {
    appendInitLog(wikiDir, currentHead, result.manifest);
    return buildInitResponse(result.manifest, [
      ...result.warnings,
      `Fell back to full init: ${dirty}/${result.manifest.pageCount} pages would need regeneration (>50% threshold).`,
    ]);
  }

  appendIncrementalLog(wikiDir, sinceRef, currentHead, changedFiles.size, report);

  return renderIncrementalResponse(sinceRef, currentHead, changedFiles.size, report);
}

async function getChangedFiles(gitRoot: string, sinceRef: string): Promise<Set<string>> {
  // `git diff --name-only <ref>` compares the working tree (tracked files,
  // staged + unstaged) against the ref. That's committed + uncommitted in
  // one call, which is what we want for incremental staleness.
  const out = await runGit(["diff", "--name-only", sinceRef], gitRoot);
  if (out === null) return new Set();
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

function writeArtifacts(wikiDir: string, result: WikiPlanResult): void {
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(join(wikiDir, "_discovery.json"), JSON.stringify(result.discovery, null, 2));
  writeFileSync(join(wikiDir, "_classified.json"), JSON.stringify(result.classified, null, 2));
  writeFileSync(join(wikiDir, "_manifest.json"), JSON.stringify(result.manifest, null, 2));
  writeFileSync(join(wikiDir, "_content.json"), JSON.stringify(result.content, null, 2));
}

function renderIncrementalResponse(
  sinceRef: string,
  newRef: string,
  changedFileCount: number,
  report: StalenessReport,
): string {
  const { stale, added, removed } = report;
  let text = `# Wiki Incremental Update\n\n`;
  text += `${stale.length} stale, ${added.length} new, ${removed.length} removed since \`${sinceRef}\`..\`${newRef}\` (${changedFileCount} files changed).\n\n`;

  if (stale.length === 0 && added.length === 0 && removed.length === 0) {
    text += `Changed files did not invalidate any wiki page. Artifacts refreshed; nothing to regenerate.\n\n`;
    text += INDEX_FRESHNESS_NOTE + "\n";
    return text;
  }

  const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;

  if (stale.length > 0) {
    text += `## Regenerate these (call \`generate_wiki(page: N)\` for each)\n\n`;
    for (const d of [...stale].sort(byOrder)) {
      const kindLabel = d.page.focus ?? d.page.kind;
      text += `- page **${d.order}** — \`${d.wikiPath}\` — ${d.page.title} (${kindLabel}, ${d.page.depth})\n`;
      text += `  trigger: ${d.triggers.join(", ")}\n`;
    }
    text += `\n`;
  }

  if (added.length > 0) {
    text += `## New pages\n\n`;
    for (const d of [...added].sort(byOrder)) {
      const kindLabel = d.page.focus ?? d.page.kind;
      text += `- page **${d.order}** — \`${d.wikiPath}\` — ${d.page.title} (${kindLabel}, ${d.page.depth})\n`;
    }
    text += `\n`;
  }

  if (removed.length > 0) {
    text += `## Delete these files\n\n`;
    for (const r of removed) {
      text += `- \`${r.wikiPath}\`\n`;
    }
    text += `\n`;
  }

  text += `${WRITING_RULES}\n\n`;

  text += `## Instructions\n\n`;
  const steps: string[] = [];
  if (stale.length > 0 || added.length > 0) {
    steps.push(
      `For each page index listed above: call \`generate_wiki(page: N)\`, apply the writing rules, and write the file. Batch 3–5 pages in parallel.`,
    );
  }
  if (removed.length > 0) {
    steps.push(
      `Delete the files under "Delete these files" (they were removed from the manifest).`,
    );
  }
  if (stale.length > 0 || added.length > 0) {
    steps.push(
      `Append a \`### Narrative\` section to the end of \`wiki/_update-log.md\` under the current update block. One bullet per page you changed, formatted like \`- <backtick>wiki/path.md<backtick>: <one sentence naming what substantively changed — new export, removed API, refactored flow>\` (use literal backticks around the path). Skip cosmetic-only changes (whitespace, renames that don't shift semantics). Keep each bullet a single sentence.`,
    );
  }
  steps.push(
    `Call \`generate_wiki(finalize: true)\` once all pages are written.`,
  );
  steps.forEach((s, i) => {
    text += `${i + 1}. ${s}\n`;
  });

  text += `\n${WORKFLOW_TIPS}\n`;
  text += `\n${INDEX_FRESHNESS_NOTE}\n`;

  return text;
}

const INDEX_FRESHNESS_NOTE =
  `> **Note:** incremental planning reads the code index, not the filesystem directly. ` +
  `If any change you expected to show up in the wiki is missing (or a regenerated page still reflects old code), run \`index_files()\` and call \`generate_wiki(incremental: true)\` again.`;

function buildFinalizeInstructions(): string {
  return `# Finalization

Run these steps to complete the wiki:

## 1. Signal-coverage validation

Spot-check 3-5 pages. Audit for signal coverage, not a fixed section list:

- **H1 heading** exists and matches the page title.
- **Overview** present and specific (names actual abstractions, not "this module contains…").
- **No empty sections** — any heading followed immediately by another heading is a bug; the section should have been omitted, not stubbed.
- **Links** resolve — check against the page's link map, not arbitrary paths.
- **Mermaid blocks** use valid diagram types and no reserved words as bare node IDs.
- **Diagrams where applicable** — module and data-flows pages benefit from a sequence diagram when a runtime flow exists. A page without a flow does not need one.
- **Signatures** match the prefetched data (no paraphrasing, no fabrication).

Fix issues in-place. If a section has no supporting data, remove the heading rather than writing filler.

## 2. Generate index page

Write \`wiki/index.md\` as the landing page linking to every generated page, grouped by kind (aggregate pages, modules, guides) with one-line descriptions. Omit group headings when no pages qualify for them. Adapt from the index exemplar.

**Do NOT call \`index_files()\` on the wiki — wiki pages are generated output, not source code.**
`;
}
