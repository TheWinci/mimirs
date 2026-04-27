import { z } from "zod";
import { join, relative, dirname, resolve } from "path";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GetDB, resolveProject } from "./index";
import { findGitRoot, runGit } from "./git-tools";
import {
  runWikiBundling,
  runWikiFinalPlanning,
  getPagePayload,
  renderSynthesisPrompt,
  validateSynthesisPayload,
  requiredSectionsFor,
  clipDocPreview,
} from "../wiki";
import { lintPage, type PageLintWarning, type ChunkRange } from "../wiki/lint-page";
import type { ClusterMode } from "../wiki/community-detection";
import { renderCatalog, paletteForRequired } from "../wiki/section-catalog";
import { classifyStaleness, type StalenessReport } from "../wiki/staleness";
import {
  appendInitLog,
  appendQueueStub,
  appendFallbackLog,
  appendNarrative,
  writeSnapshot,
  readSnapshot,
  deleteSnapshot,
  snapshotPath,
} from "../wiki/update-log";
import { diffPage } from "../wiki/diff-page";
import type {
  PageManifest,
  ContentCache,
  DiscoveryResult,
  ClassifiedInventory,
  CommunityBundle,
  SynthesesFile,
  SynthesisPayload,
  PagePayload,
  PreRegenSnapshot,
  PreRegenSnapshotPage,
  PageDiff,
} from "../wiki/types";
import type { RagDB } from "../db";

const WRITING_RULES = `## Writing Rules

- **Page header is mandatory.** Copy the payload's \`Required page header\` block verbatim as the first content below the H1 title, before any section. It carries the breadcrumb trail (sub-pages only) and the generation stamp (\`> Generated from <ref> · <date>\`). Do not rewrite the stamp — readers use it to tell if a page matches HEAD.
- **Run the semantic queries first.** When the payload lists \`Semantic queries to run before drafting\`, call \`read_relevant(query)\` on each before writing the matching section. Skip a query only when the bundle already covers that angle in the relevant chunks — never skip all three. Queries surface error paths, call sites, and internal constants the bundle misses.
- **Sections come from the synthesis.** The page payload lists the exact sections to write (title + purpose + optional shape). Do not add or drop sections; if the synthesis is wrong, regenerate it, do not improvise. Never stub an empty heading.
- **\`community-file\` sub-pages** (kind in payload): drill-down page for ONE big member of a split community. Payload's \`memberFiles\` always holds exactly one file. Sections are Role / Exports / Internals. Read the file fully before writing. The bundle is already scoped to this file; use it directly. The parent community page owns architecture-level prose and covers all smaller members inline — don't duplicate that here.
- **Shapes are starting points, not templates.** The \`shape\` field (when present) names a structural pattern from the catalog — follow the pattern, do not copy the example body.
- **Links**: Use ONLY the exact relative paths from the "Link map" section of the payload. Never compute relative paths yourself. Never use Obsidian \`[[wikilinks]]\`.
- **File paths in prose — full project-relative form**: Every backticked file reference must match the path shipped in the bundle verbatim (e.g. \`src/cli/index.ts\`, not the shorthand \`cli/index.ts\`). No stripped-prefix paths. The \`missing-file\` lint flags shorthand; regenerate the section if it fires.
- **Filenames**: Kebab-case always. Filenames come from the synthesis slug.
- **Cross-references**: The payload ships a pre-rendered \`## See also\` block under the "Required See also block" heading. Copy it verbatim — do not author a different one. The links are derived from the manifest and are correct by construction.
- **Diagrams — when**: A diagram belongs *inside* a section, not as its own section. If a section's purpose describes a **pipeline, lifecycle, ordered steps, phases, sequence, handshake, state transitions, request flow, or producer → consumer path**, open that section with a Mermaid block and then write the prose. If the section is a static list (entities, config keys, exports) or a single-paragraph definition, skip the diagram.
- **Diagrams — shape (prefer sequenceDiagram)**: Default to \`sequenceDiagram\` whenever the thing has a caller and a callee, a request/response, or any time-ordered interaction between two or more components — pipelines, request flows, indexing runs, and tool calls all qualify. Use \`flowchart LR\` only for static dependency maps or producer → consumer topology where no actor is "calling" another. Use \`flowchart TD\` for trees and hierarchies. Use \`stateDiagram-v2\` for lifecycles with discrete states. If in doubt between flowchart and sequence, pick sequence — it carries more information (who calls whom, in what order, with what payload).
- **Diagrams — budget**: Architecture-style maps: **≤ 12 nodes AND ≤ 18 edges**. In-section diagrams: **≤ 8 nodes**. Subgraphs: **≤ 4 nodes**, **3–5 total**.
- **Diagrams — source-of-truth**: Nodes and edges must come from the bundle (member files, exports, externalConsumers, externalDependencies, pageRank). Never invent a node or edge the bundle doesn't support.
- **Diagrams — cross-cutting**: Pull out modules used by nearly everything into a separate small Mermaid block under \`## Cross-cutting dependencies\`.
- **Mermaid reserved/ambiguous node IDs — rename always**: Never use these as node IDs, even when the concept matches (this is the #1 cause of broken diagrams): \`graph\`, \`subgraph\`, \`end\`, \`start\`, \`style\`, \`classDef\`, \`class\`, \`click\`, \`link\`, \`default\`, \`node\`, \`edge\`, \`flowchart\`, \`state\`, \`direction\`. Rename by role: a node documenting the import graph becomes \`importGraph\`, a node for \`registerGraphTools\` becomes \`graphTools\`, a lifecycle start becomes \`enter\` or \`begin\`. Node IDs are internal handles — they never appear in the rendered output, so rename freely.
- **Mermaid label escaping — no angle brackets, no ampersands**: Inside \`"…"\` labels, never use raw \`<\`, \`>\`, \`&\`, or \`"\`. Mermaid passes labels through HTML, so \`<cmd>\` renders as an empty tag and breaks the node. Rewrite: \`"<cmd>Command"\` → \`"commandFn"\` or \`"&lt;cmd&gt;Command"\`. Prefer rewriting the label to plain words over escaping. Keep labels short; put detail in prose, not on the node.
- **Mermaid \`<br/>\` is HTML — never use it, especially in \`participant X as\` aliases**: \`<br/>\`, \`<b>\`, \`<i>\`, \`&nbsp;\` all break in Mermaid 10+ inside sequenceDiagram participant aliases and generally produce empty or broken renders elsewhere. Do NOT emit them. If a label needs two facts, shorten it to one short phrase (put the rest in prose) or rename the participant entirely. The \`mermaid-html-in-alias\` lint flags any HTML token inside sequenceDiagram alias or bracket labels.
- **Mermaid labels — always quote punctuation**: Wrap in double quotes when labels contain \`/\`, \`.\`, \`(\`, \`)\`, \`<\`, \`>\`, \`|\`, \`:\`, or whitespace. This covers every path (\`"src/search/hybrid.ts"\`), every dotted identifier (\`"db.search"\`), and every \`participant X as "<label>"\` with punctuation. Only bare single-word labels (\`HybridSearch\`, \`cli\`) may stay unquoted. When in doubt, quote. The \`mermaid-unquoted-label\` lint will flag anything risky.
- **Mermaid budget — enforce by counting**: Before emitting the diagram, count nodes and edges. Architecture-style maps: **≤ 12 nodes AND ≤ 18 edges**. In-section diagrams: **≤ 8 nodes**. If the raw data exceeds the cap, (a) group into subgraphs by role (≤ 4 nodes each, 3–5 subgraphs max), or (b) trim to the top-N members by pageRank from the bundle. Never ship an over-budget diagram.
- **Mermaid self-check — read before emit**: After drafting each Mermaid block, re-read it once against this checklist: (1) no reserved word is a bare node ID, (2) every \`"…"\` label contains no raw \`<\`, \`>\`, \`&\`, (3) node and edge counts are within budget, (4) every \`-->\` target is a defined node, (5) every node referenced in \`subgraph\` … \`end\` is declared. Fix before writing the file.
- **Signatures**: Only write what the pre-fetched bundle shows. Never fabricate or paraphrase.
- **Function/type names — verify before citing**: Every backticked function or type name in prose must correspond to a real identifier in the bundle's exports, tunables, or shipped code (\`Top member source\` / relevant chunks). If unsure, \`Read\` the member file first. Do NOT invent verb-style names ("hybridSearch") from the community title.
- **Top member body**: When the bundle ships a \`Top member source\` block, read it before writing about behavior. The signatures block tells you *what* is exported; the source tells you *what it does*. Prose that describes behavior not visible in either is a hallucination.
- **Tunables — verbatim literals**: The bundle's \`Tunables\` block lists constants with their literal values. Quote the literal verbatim in prose (\`DEFAULT_HYBRID_WEIGHT = 0.7\`, \`STOP_WORDS = [...]\`). Never paraphrase ("roughly 70%", "a list of stop words"). Readers tuning behavior scan for the literal number or string.
- **Tunables — cite every one**: Every tunable in the bundle (plus every top-level constant/variable in the community's member files) must appear by name somewhere on the page — prose, tables, or code samples all count. The \`constant-uncited\` lint fails the page if a tunable is declared in source but never mentioned. When the bundle lists more tunables than prose can comfortably absorb, group them into a \`## Tunables\` table with name / value / purpose columns rather than dropping any.
- **Prose**: Paragraphs over bullet lists. Be specific. Lead with what, then how, then why.
- **No guessing**: Skip a section if its data is empty. The synthesis picked it assuming data; if not, note the gap in the writing and remove the heading.
- **Depth contract**:
  - \`brief\` — ~120–250 words total. Lead with purpose, then a single integrated paragraph covering the core mechanism.
  - \`standard\` — ~400–700 words. Expand each section per the synthesis.
  - \`full\` — ~800–1400 words. Add per-file breakdown where the bundle supports it.
- **Do NOT index**: Never call \`index_files()\` on the wiki directory. Wiki pages are generated output, not source code.`;

const WORKFLOW_TIPS = `## Context Management

- **Write each page immediately after fetching its data.** Page N's bundle is noise while writing page N+10.
- **Parallelize across pages.** Each \`generate_wiki(page: N)\` reads pre-built JSON — sibling pages have no runtime dependency. Batch 3–5 in parallel.
- **Architecture and getting-started depend on the community pages being written** (they may cite them). Write community pages first, aggregates last.
- **Synthesis is also parallelizable.** \`generate_wiki(synthesis: "<id>")\` calls can run in parallel for different communities; \`write_synthesis\` back each result as it returns.`;

export function registerWikiTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "generate_wiki",
    "Build or update a structured markdown wiki via a Louvain-led pipeline. Flow: (1) `generate_wiki()` with no artifacts → runs discovery + categorization + Louvain + bundle prefetch; returns a list of communities to synthesize and a section catalog. (2) `generate_wiki(synthesis: \"<id>\")` → returns the full per-community bundle and a prompt to name the community and pick sections; call `write_synthesis(communityId, payload)` with the result. (3) `generate_wiki()` after all syntheses are stored → builds the manifest + prefetch, returns the page list. (4) `generate_wiki(page: N)` → returns the page payload (title, purpose, sections, bundle, link map). (5) `generate_wiki(finalize: true)` → validation checklist. (6) `generate_wiki(resume: true)` → shows which page files are missing on disk. (7) `generate_wiki(incremental: true)` → re-runs bundling, diffs against the stored manifest, and reports which pages need regeneration.",
    {
      directory: z.string().optional().describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      page: z.number().int().min(0).optional().describe("Page index to fetch the payload for."),
      synthesis: z.string().optional().describe("Community id. Returns the full synthesis prompt for that community."),
      finalize: z.boolean().optional().describe("Return the validation + index-page instructions."),
      resume: z.boolean().optional().describe("Return which pages are still missing on disk."),
      incremental: z.boolean().optional().describe("Re-run bundling; report which pages need regeneration."),
      cluster: z.enum(["files", "symbols"]).optional().describe("Louvain mode: 'files' (default) or 'symbols'."),
    },
    async ({ directory, page, synthesis, finalize, resume, incremental, cluster }) => {
      const { db: ragDb, projectDir, config } = await resolveProject(directory, getDB);
      const wikiDir = join(projectDir, "wiki");

      if (finalize) {
        return { content: [{ type: "text" as const, text: buildFinalizeInstructions(wikiDir, projectDir, ragDb) }] };
      }
      if (resume) {
        return { content: [{ type: "text" as const, text: buildResumeResponse(wikiDir, projectDir) }] };
      }
      if (incremental) {
        const text = await buildIncrementalResponse(ragDb, projectDir, wikiDir, config, cluster);
        return { content: [{ type: "text" as const, text }] };
      }
      if (synthesis !== undefined) {
        return { content: [{ type: "text" as const, text: buildSynthesisResponse(wikiDir, synthesis) }] };
      }
      if (page !== undefined) {
        return { content: [{ type: "text" as const, text: buildPageResponse(wikiDir, page) }] };
      }

      return {
        content: [{
          type: "text" as const,
          text: await buildRootResponse(ragDb, projectDir, wikiDir, config, cluster),
        }],
      };
    },
  );

  server.tool(
    "write_synthesis",
    "Store the LLM-produced synthesis for one community. Validates the payload (communityId match, slug format, slug uniqueness, non-empty name/purpose/sections) and persists it in wiki/_meta/_syntheses.json. After every pending community has a synthesis, re-run `generate_wiki()` to build the manifest.",
    {
      directory: z.string().optional().describe("Project directory."),
      communityId: z.string().describe("Community id from the synthesis prompt."),
      payload: z.object({
        communityId: z.string().optional(),
        name: z.string(),
        slug: z.string(),
        purpose: z.string(),
        kind: z.string().optional(),
        sections: z.array(z.object({
          title: z.string(),
          purpose: z.string(),
          shape: z.string().optional(),
        })).min(1),
      }).describe("Synthesis payload — see the prompt returned by generate_wiki(synthesis). The outer `communityId` is auto-injected if omitted here."),
    },
    async ({ directory, communityId, payload }) => {
      const { projectDir } = await resolveProject(directory, getDB);
      const wikiDir = join(projectDir, "wiki");
      // Agents routinely pass communityId on the outer arg and omit it from
      // the nested payload. Rather than fail with a validation error on a
      // second 4-agent batch that costs minutes, splice the outer id in.
      const normalizedPayload = { ...payload, communityId: payload.communityId ?? communityId };
      return {
        content: [{ type: "text" as const, text: storeSynthesis(wikiDir, communityId, normalizedPayload) }],
      };
    },
  );

  server.tool(
    "write_synthesis_batch",
    "Store multiple LLM-produced synthesis payloads in one call. Each entry is validated independently and persisted to wiki/_meta/_syntheses.json. Returns a per-entry status summary. Use when a single agent has synthesized 2+ communities and would otherwise chain sequential `write_synthesis` calls. Payloads that fail validation are reported without aborting the rest of the batch.",
    {
      directory: z.string().optional().describe("Project directory."),
      entries: z.array(z.object({
        communityId: z.string(),
        payload: z.object({
          communityId: z.string().optional(),
          name: z.string(),
          slug: z.string(),
          purpose: z.string(),
          kind: z.string().optional(),
          sections: z.array(z.object({
            title: z.string(),
            purpose: z.string(),
            shape: z.string().optional(),
          })).min(1),
        }),
      })).min(1).describe("One entry per community. Same shape as write_synthesis but wrapped in an array."),
    },
    async ({ directory, entries }) => {
      const { projectDir } = await resolveProject(directory, getDB);
      const wikiDir = join(projectDir, "wiki");
      return {
        content: [{ type: "text" as const, text: storeSynthesisBatch(wikiDir, entries) }],
      };
    },
  );

  server.tool(
    "write_flows",
    "Store the LLM-produced flow synthesis payload (Phase A of the data-flows split — see plans/aggregate-page-sharding.md). Validates each flow's slug, trigger kind, and member-community references against the community syntheses. Persists to wiki/_meta/_flows.json. After storing, re-run `generate_wiki()` to regenerate the manifest with per-flow sub-pages.",
    {
      directory: z.string().optional().describe("Project directory."),
      payload: z.object({
        flows: z.array(z.object({
          name: z.string(),
          slug: z.string(),
          purpose: z.string(),
          trigger: z.object({
            kind: z.enum(["http", "queue", "scheduled", "manual"]),
            ref: z.string(),
          }),
          memberCommunities: z.array(z.string()),
        })).min(1),
      }),
    },
    async ({ directory, payload }) => {
      const { projectDir } = await resolveProject(directory, getDB);
      const wikiDir = join(projectDir, "wiki");
      return {
        content: [{ type: "text" as const, text: storeFlows(wikiDir, payload) }],
      };
    },
  );

  server.tool(
    "wiki_lint_page",
    "Lint a single wiki markdown file against path, Mermaid-reserved-id, Mermaid-unquoted-label, and Mermaid-html-in-alias rules. Takes a project-relative or absolute path to a `.md` file; returns structured warnings. Fast pre-finalize feedback loop — call after writing a page to catch render bugs and fabricated paths before running the full `generate_wiki(finalize: true)` sweep.",
    {
      directory: z.string().optional().describe("Project directory."),
      path: z.string().describe("Path to the .md file (project-relative or absolute)."),
    },
    async ({ directory, path: inputPath }) => {
      const { db: ragDb, projectDir } = await resolveProject(directory, getDB);
      return {
        content: [{
          type: "text" as const,
          text: buildLintPageResponse(projectDir, ragDb, inputPath),
        }],
      };
    },
  );

  server.tool(
    "wiki_lint_batch",
    "Lint every .md file under `wiki/` in one call. Returns warnings grouped by page. When `fix: true`, auto-applies the `correctedMatch` replacement for warnings that ship one (currently `line-range-drift`); reports before/after. Use instead of N sequential `wiki_lint_page` calls at finalize time.",
    {
      directory: z.string().optional().describe("Project directory."),
      fix: z.boolean().optional().describe("Apply `correctedMatch` substitutions in place. Off by default."),
    },
    async ({ directory, fix }) => {
      const { db: ragDb, projectDir } = await resolveProject(directory, getDB);
      return {
        content: [{
          type: "text" as const,
          text: buildLintBatchResponse(projectDir, ragDb, fix === true),
        }],
      };
    },
  );

  server.tool(
    "wiki_rewrite_page",
    "Return the payload for a single existing wiki page without touching the manifest, staleness report, or any other artifact. Same shape as `generate_wiki(page: N)` — use this when iterating on one page's prose after a review without the visual/operational overhead of the generate_wiki dispatcher.",
    {
      directory: z.string().optional().describe("Project directory."),
      page: z.number().int().min(0).describe("Page index (same indexing as generate_wiki)."),
    },
    async ({ directory, page }) => {
      const { projectDir } = await resolveProject(directory, getDB);
      const wikiDir = join(projectDir, "wiki");
      return {
        content: [{ type: "text" as const, text: buildPageResponse(wikiDir, page) }],
      };
    },
  );

  server.tool(
    "wiki_finalize_log",
    "Phase-2 of the incremental update log. Loads `wiki/_meta/_pre-regen-snapshot.json` (captured at planning), reads the *new* on-disk markdown for each regenerated page, computes a structural diff (sections added/removed/rewritten, citations, mermaid blocks, numeric literals), and returns a prompt for the calling agent to write a `## What changed in this regen` narrative — one bullet per page, two sentences, grounded in the diffs and commit subjects. Pass the resulting markdown back via `wiki_finalize_log_apply`. No-op when no snapshot exists.",
    {
      directory: z.string().optional().describe("Project directory."),
    },
    async ({ directory }) => {
      const { projectDir } = await resolveProject(directory, getDB);
      const wikiDir = join(projectDir, "wiki");
      return {
        content: [{ type: "text" as const, text: buildFinalizeLogResponse(projectDir, wikiDir) }],
      };
    },
  );

  server.tool(
    "wiki_finalize_log_apply",
    "Append the LLM-produced \"What changed\" narrative to `wiki/_update-log.md` under the queue stub for the current snapshot's `newRef`, then delete the snapshot. Pair with `wiki_finalize_log` — that tool returns the prompt, the agent writes the markdown, this tool persists it. Pass the narrative as project-relative markdown bullets (no surrounding heading; the tool wraps it).",
    {
      directory: z.string().optional().describe("Project directory."),
      narrative: z.string().describe("Markdown bullets returned by the LLM. One bullet per page. The tool wraps it under `### What changed in this regen`."),
    },
    async ({ directory, narrative }) => {
      const { projectDir } = await resolveProject(directory, getDB);
      const wikiDir = join(projectDir, "wiki");
      return {
        content: [{ type: "text" as const, text: applyFinalizeLog(wikiDir, narrative) }],
      };
    },
  );
}

/**
 * Walk every `.md` under `wiki/`, lint it, and return a grouped report.
 * When `applyFixes` is true, substitute the `correctedMatch` token for
 * every warning that ships one (currently only `line-range-drift`) and
 * write the file back. Safe to run repeatedly — warnings without
 * corrections are never touched.
 */
function buildLintBatchResponse(
  projectDir: string,
  ragDb: RagDB,
  applyFixes: boolean,
): string {
  const wikiDir = join(projectDir, "wiki");
  if (!existsSync(wikiDir)) {
    return "No `wiki/` directory yet. Run `generate_wiki()` first.";
  }
  const { knownFilePaths, knownConstants } = buildLintContext(projectDir, ragDb);
  const pages = collectWikiPages(wikiDir);
  if (pages.length === 0) {
    return `No .md files under \`${relative(projectDir, wikiDir)}\`.`;
  }

  interface PageReport {
    wikiPath: string;
    warnings: PageLintWarning[];
    fixedCount: number;
  }
  const reports: PageReport[] = [];
  for (const absPath of pages) {
    let markdown = safeRead(absPath);
    if (markdown === null) continue;
    const wikiPathFromWiki = relative(wikiDir, absPath);
    const expectedConstants = expectedConstantsFor(wikiDir, relative(projectDir, absPath), knownConstants, wikiPathFromWiki);
    const expectedMembers = expectedMembersFor(wikiDir, wikiPathFromWiki);
    const chunkRangesByPath = loadChunkRangesForCitedPaths(markdown, projectDir, ragDb);
    const warnings = lintPage(markdown, {
      knownFilePaths,
      knownConstants,
      expectedConstants,
      expectedMembers,
      chunkRangesByPath,
    });
    let fixedCount = 0;
    if (applyFixes && warnings.length > 0) {
      for (const w of warnings) {
        if (!w.correctedMatch) continue;
        // Substitute every occurrence of the stale token. The match field
        // is a literal path:L1-L2 citation; no regex metachars that would
        // surprise `split`/`join`, so a simple string replace is safe.
        if (!markdown.includes(w.match)) continue;
        markdown = markdown.split(w.match).join(w.correctedMatch);
        fixedCount++;
      }
      if (fixedCount > 0) {
        try {
          writeFileSync(absPath, markdown, "utf-8");
        } catch {
          // Write failure falls back to the unchanged file; surface via
          // `fixedCount = 0` so the report reflects reality.
          fixedCount = 0;
        }
      }
    }
    if (warnings.length === 0 && fixedCount === 0) continue;
    reports.push({ wikiPath: relative(projectDir, absPath), warnings, fixedCount });
  }

  if (reports.length === 0) {
    return `Lint clean — ${pages.length} file${plural(pages.length)} under \`wiki/\`. No path, constant, member, line-range, or Mermaid issues detected.`;
  }

  const totalWarnings = reports.reduce((n, r) => n + r.warnings.length, 0);
  const totalFixed = reports.reduce((n, r) => n + r.fixedCount, 0);
  let text = `# Lint report — ${pages.length} file${plural(pages.length)} scanned\n\n`;
  text += `${totalWarnings} warning${plural(totalWarnings)} across ${reports.length} page${plural(reports.length)}`;
  if (applyFixes) text += ` · ${totalFixed} auto-fix${totalFixed === 1 ? "" : "es"} applied`;
  text += `.\n\n`;
  for (const r of reports) {
    text += `## \`${r.wikiPath}\``;
    if (r.fixedCount > 0) text += ` — ${r.fixedCount} auto-fix${r.fixedCount === 1 ? "" : "es"} applied`;
    text += `\n\n`;
    for (const w of r.warnings) {
      text += `- **${w.kind}** (line ${w.line}) — ${w.message}\n`;
      if (w.correctedMatch) {
        const action = applyFixes ? "applied" : "fix";
        text += `  - ${action}: replace \`${w.match}\` → \`${w.correctedMatch}\`\n`;
      }
    }
    text += `\n`;
  }
  if (!applyFixes && totalWarnings > 0) {
    text += `_Re-run with \`fix: true\` to auto-apply replacements for warnings that list one._\n`;
  }
  return text;
}

function buildLintPageResponse(
  projectDir: string,
  ragDb: RagDB,
  inputPath: string,
): string {
  const abs = inputPath.startsWith("/") ? inputPath : join(projectDir, inputPath);
  if (!existsSync(abs)) {
    return `File not found: \`${inputPath}\`. Pass a path relative to the project root or an absolute path.`;
  }
  const markdown = safeRead(abs);
  if (markdown === null) return `Could not read \`${inputPath}\`.`;

  const { knownFilePaths, knownConstants } = buildLintContext(projectDir, ragDb);
  const wikiDir = join(projectDir, "wiki");
  const expectedConstants = expectedConstantsFor(
    wikiDir,
    relative(projectDir, abs),
    knownConstants,
    relative(wikiDir, abs),
  );
  const expectedMembers = expectedMembersFor(wikiDir, relative(wikiDir, abs));
  const chunkRangesByPath = loadChunkRangesForCitedPaths(markdown, projectDir, ragDb);

  const warnings = lintPage(markdown, {
    knownFilePaths,
    knownConstants,
    expectedConstants,
    expectedMembers,
    chunkRangesByPath,
  });
  if (warnings.length === 0) {
    return `Lint clean — \`${relative(projectDir, abs)}\`. No path or Mermaid issues detected.`;
  }

  let text = `Lint report — \`${relative(projectDir, abs)}\`\n\n`;
  text += `${warnings.length} warning${plural(warnings.length)}:\n\n`;
  for (const w of warnings) {
    text += `- **${w.kind}** (line ${w.line}) — ${w.message}\n`;
    if (w.correctedMatch) {
      text += `  - fix: replace \`${w.match}\` → \`${w.correctedMatch}\`\n`;
    }
  }
  return text;
}

// ── Artifact file paths ──

const META_DIR = "_meta";
const BUNDLES_FILE = "_bundles.json";
const SYNTHESES_FILE = "_syntheses.json";
/** Persisted Phase-A flow synthesis output. See plans/aggregate-page-sharding.md Phase 3. */
const FLOWS_FILE = "_flows.json";
const DISCOVERY_FILE = "_discovery.json";
const CLASSIFIED_FILE = "_classified.json";
const MANIFEST_FILE = "_manifest.json";
const CONTENT_FILE = "_content.json";
const ISOLATE_DOCS_FILE = "_isolate-docs.json";

function p(wikiDir: string, name: string): string {
  return join(wikiDir, META_DIR, name);
}

function readJSON<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Write a JSON file atomically — writes to `${path}.tmp` then renames into
 * place. A crash mid-write leaves the previous version intact instead of
 * truncating the target. `readJSON` silently returns null on parse errors,
 * so a torn write would otherwise erase prior phase output and force a full
 * regen.
 */
function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function loadSyntheses(wikiDir: string): SynthesesFile {
  const existing = readJSON<SynthesesFile>(p(wikiDir, SYNTHESES_FILE));
  if (existing && existing.version === 1) return existing;
  return { version: 1, payloads: {}, memberSets: {} };
}

// ── Root router ──

async function buildRootResponse(
  ragDb: RagDB,
  projectDir: string,
  wikiDir: string,
  config: import("../config").RagConfig,
  cluster?: ClusterMode,
): Promise<string> {
  const bundles = readJSON<CommunityBundle[]>(p(wikiDir, BUNDLES_FILE));
  const syntheses = loadSyntheses(wikiDir);
  const manifestExists = existsSync(p(wikiDir, MANIFEST_FILE));

  // If a manifest already exists, fall through to incremental.
  if (manifestExists && bundles) {
    return buildIncrementalResponse(ragDb, projectDir, wikiDir, config, cluster);
  }

  // Step 1: if we don't have bundles yet, run bundling.
  if (!bundles) {
    const status = ragDb.getStatus();
    if (status.totalFiles === 0) {
      return "The index is empty — run `index_files()` first, then call `generate_wiki()`.";
    }

    const result = runWikiBundling(ragDb, projectDir, cluster ?? "files");
    writeJSON(p(wikiDir, DISCOVERY_FILE), result.discovery);
    writeJSON(p(wikiDir, CLASSIFIED_FILE), result.classified);
    writeJSON(p(wikiDir, BUNDLES_FILE), result.bundles);
    writeJSON(p(wikiDir, ISOLATE_DOCS_FILE), result.unmatchedDocs);

    return renderBundlingResponse(result.bundles, syntheses);
  }

  // Step 2: we have bundles; check pending syntheses.
  const pending = bundles.filter((b) => !syntheses.payloads[b.communityId]);
  if (pending.length > 0) {
    return renderPendingSynthesisResponse(bundles, pending);
  }

  // Step 3: everything synthesized — build manifest + content.
  return buildManifestAndContent(ragDb, projectDir, wikiDir, bundles, syntheses, config, cluster);
}

function renderBundlingResponse(
  bundles: CommunityBundle[],
  syntheses: SynthesesFile,
): string {
  const pending = bundles.filter((b) => !syntheses.payloads[b.communityId]);
  let text = `# Wiki — Step 1 complete\n\n`;
  text += `Louvain produced **${bundles.length} communities**. Pre-gathered a bundle for each ` +
    `(exports, external deps, annotations, recent commits, PageRank).\n\n`;
  text += renderSynthesisChecklist(bundles, pending);
  text += `\n${WORKFLOW_TIPS}\n`;
  return text;
}

function renderPendingSynthesisResponse(
  bundles: CommunityBundle[],
  pending: CommunityBundle[],
): string {
  let text = `# Wiki — awaiting syntheses\n\n`;
  text += `${pending.length} of ${bundles.length} communities still need a synthesis.\n\n`;
  text += renderSynthesisChecklist(bundles, pending);
  return text;
}

function renderSynthesisChecklist(
  all: CommunityBundle[],
  pending: CommunityBundle[],
): string {
  let text = `## Pending synthesis (${pending.length})\n\n`;
  for (const b of pending) {
    const preview = b.memberFiles.slice(0, 3).join(", ");
    const more = b.memberFiles.length > 3 ? ` … (+${b.memberFiles.length - 3} more)` : "";
    text += `- \`${b.communityId}\` — ${b.memberFiles.length} files: ${preview}${more}\n`;
  }
  text += `\n## Instructions\n\n`;
  text += `For each pending community id:\n`;
  text += `1. Call \`generate_wiki(synthesis: "<id>")\` — returns the full bundle and the section catalog.\n`;
  text += `2. Pick a human name, a kebab-case slug, a 1–2 sentence purpose, and a list of sections (title + purpose + optional \`shape\` from the catalog).\n`;
  text += `3. Call \`write_synthesis(communityId: "<id>", payload: {...})\`.\n`;
  text += `4. When all are stored, call \`generate_wiki()\` with no args — that step builds the manifest and returns the page list.\n\n`;
  text += `Step 1 calls are independent — batch 3–5 in parallel.\n`;
  if (all.length !== pending.length) {
    const done = all.length - pending.length;
    text += `\n${done} already stored.\n`;
  }
  return text;
}

function buildSynthesisResponse(wikiDir: string, communityId: string): string {
  const bundles = readJSON<CommunityBundle[]>(p(wikiDir, BUNDLES_FILE));
  if (!bundles) return "No bundles on disk. Call `generate_wiki()` first.";
  const bundle = bundles.find((b) => b.communityId === communityId);
  if (!bundle) return `No bundle found for community id \`${communityId}\`.`;

  const syntheses = loadSyntheses(wikiDir);
  const usedSlugs = Object.values(syntheses.payloads).map((p) => p.slug);
  // Only ship a palette that doesn't duplicate shapes already rendered in
  // the REQUIRED sections block. Saves a few KB per synthesis prompt
  // versus the old full-catalog dump.
  const requiredIds = requiredSectionsFor(bundle).map((r) => r.entry.id);
  const catalog = renderCatalog(paletteForRequired(requiredIds));
  return renderSynthesisPrompt(bundle, catalog, usedSlugs);
}

/**
 * Persist a batch of synthesis payloads in one pass. Loads bundles and
 * syntheses once, validates each entry against its bundle, then writes
 * the accumulated syntheses file once at the end. A failure on one entry
 * does not block the others — the batch is intentionally tolerant so a
 * single bad payload doesn't force the caller to re-issue the whole run.
 *
 * Slug uniqueness is enforced across the combined set (already-stored +
 * newly-accepted within this batch), so two entries can't both claim the
 * same slug even if neither conflicts with an existing synthesis.
 */
function storeSynthesisBatch(
  wikiDir: string,
  entries: { communityId: string; payload: unknown }[],
): string {
  const bundles = readJSON<CommunityBundle[]>(p(wikiDir, BUNDLES_FILE));
  if (!bundles) return "No bundles on disk. Call `generate_wiki()` first.";
  const bundleById = new Map(bundles.map((b) => [b.communityId, b]));
  const syntheses = loadSyntheses(wikiDir);

  interface Outcome {
    communityId: string;
    ok: boolean;
    message: string;
    slug?: string;
    injected?: string[];
  }
  const outcomes: Outcome[] = [];
  let persistedCount = 0;

  for (const entry of entries) {
    const { communityId, payload } = entry;
    const bundle = bundleById.get(communityId);
    if (!bundle) {
      outcomes.push({
        communityId,
        ok: false,
        message: `No bundle found for community id \`${communityId}\`.`,
      });
      continue;
    }
    // Inject the outer communityId into the nested payload when omitted
    // — mirrors `write_synthesis`' forgiving contract so an agent that
    // batches can use either shape.
    const normalized = {
      ...(payload as Record<string, unknown>),
      communityId: (payload as { communityId?: string }).communityId ?? communityId,
    };
    // Slug uniqueness check covers both on-disk syntheses (minus the one
    // we're about to overwrite) and other syntheses accepted earlier in
    // this same batch.
    const usedSlugs = new Set(
      Object.entries(syntheses.payloads)
        .filter(([id]) => id !== communityId)
        .map(([, p]) => p.slug),
    );
    const required = requiredSectionsFor(bundle);
    const validated = validateSynthesisPayload(normalized, communityId, usedSlugs, required);
    if (!validated.ok) {
      outcomes.push({
        communityId,
        ok: false,
        message: `❌ ${validated.error}`,
      });
      continue;
    }
    syntheses.payloads[communityId] = validated.value;
    syntheses.memberSets[communityId] = bundle.memberFiles;
    persistedCount++;
    outcomes.push({
      communityId,
      ok: true,
      message: `stored with ${validated.value.sections.length} section${validated.value.sections.length === 1 ? "" : "s"}`,
      slug: validated.value.slug,
      injected: validated.injected,
    });
  }

  if (persistedCount > 0) {
    writeJSON(p(wikiDir, SYNTHESES_FILE), syntheses);
  }

  const pending = bundles.filter((b) => !syntheses.payloads[b.communityId]).length;
  let text = `Batch result — ${persistedCount} of ${entries.length} stored`;
  if (persistedCount < entries.length) {
    text += ` (${entries.length - persistedCount} failed)`;
  }
  text += `.\n\n`;
  for (const o of outcomes) {
    if (o.ok) {
      text += `- ✅ \`${o.communityId}\` — slug \`${o.slug}\`, ${o.message}`;
      if (o.injected && o.injected.length > 0) {
        text += ` — injected ${o.injected.length} required section${o.injected.length === 1 ? "" : "s"}`;
      }
      text += `\n`;
    } else {
      text += `- ❌ \`${o.communityId}\` — ${o.message}\n`;
    }
  }
  text += `\n`;
  if (pending === 0) {
    text += `All syntheses captured. Call \`generate_wiki()\` to build the manifest.\n`;
  } else {
    text += `${pending} communit${pending === 1 ? "y" : "ies"} still pending.\n`;
  }
  return text;
}

function storeSynthesis(
  wikiDir: string,
  communityId: string,
  payload: unknown,
): string {
  const bundles = readJSON<CommunityBundle[]>(p(wikiDir, BUNDLES_FILE));
  if (!bundles) return "No bundles on disk. Call `generate_wiki()` first.";
  const bundle = bundles.find((b) => b.communityId === communityId);
  if (!bundle) return `No bundle found for community id \`${communityId}\`.`;

  const syntheses = loadSyntheses(wikiDir);
  const usedSlugs = new Set(
    Object.entries(syntheses.payloads)
      .filter(([id]) => id !== communityId)
      .map(([, p]) => p.slug),
  );

  const required = requiredSectionsFor(bundle);
  const validated = validateSynthesisPayload(payload, communityId, usedSlugs, required);
  if (!validated.ok) {
    return `❌ Synthesis rejected: ${validated.error}`;
  }

  syntheses.payloads[communityId] = validated.value;
  syntheses.memberSets[communityId] = bundle.memberFiles;
  writeJSON(p(wikiDir, SYNTHESES_FILE), syntheses);

  const pending = bundles.filter((b) => !syntheses.payloads[b.communityId]).length;
  let text = `✅ Stored synthesis for \`${communityId}\` — slug \`${validated.value.slug}\`, ${validated.value.sections.length} sections.\n`;
  if (validated.injected.length > 0) {
    text += `Injected ${validated.injected.length} missing required section${validated.injected.length === 1 ? "" : "s"}: ${validated.injected.map((id) => `\`${id}\``).join(", ")}.\n`;
  }
  if (pending === 0) {
    text += `\nAll syntheses captured. Call \`generate_wiki()\` to build the manifest.`;
  } else {
    text += `\n${pending} communit${pending === 1 ? "y" : "ies"} still pending.`;
  }
  return text;
}

/**
 * Validate + persist a Phase-A flow synthesis payload. Cross-references
 * `memberCommunities` against the community syntheses to reject flows
 * that reference unknown community slugs (typos, stale data after a
 * community rename). Fingerprint is computed from the input bundle
 * upstream and re-derived here from current syntheses for parity.
 */
function storeFlows(
  wikiDir: string,
  payload: unknown,
): string {
  const syntheses = loadSyntheses(wikiDir);
  const knownSlugs = new Set(Object.values(syntheses.payloads).map((p) => p.slug));
  if (knownSlugs.size === 0) {
    return "No community syntheses on disk yet. Run `generate_wiki()` and store community syntheses first.";
  }
  const { validateFlowsPayload } = require("../wiki/flow-synthesis") as typeof import("../wiki/flow-synthesis");
  const fingerprint = "<unknown>"; // Set by caller-side build pass; placeholder when called raw.
  const validated = validateFlowsPayload(payload, fingerprint, knownSlugs);
  if (!validated.ok) return `❌ Flows rejected: ${validated.error}`;
  writeJSON(p(wikiDir, FLOWS_FILE), validated.value);
  let text = `✅ Stored ${validated.value.flows.length} flow${validated.value.flows.length === 1 ? "" : "s"}:\n`;
  for (const f of validated.value.flows) {
    text += `- \`${f.slug}\` — ${f.name} (trigger: ${f.trigger.kind} ${f.trigger.ref})\n`;
  }
  text += `\nRun \`generate_wiki()\` to rebuild the manifest with per-flow sub-pages.`;
  return text;
}

async function buildManifestAndContent(
  ragDb: RagDB,
  projectDir: string,
  wikiDir: string,
  bundles: CommunityBundle[],
  syntheses: SynthesesFile,
  config: import("../config").RagConfig,
  clusterOverride?: ClusterMode,
): Promise<string> {
  const discovery = readJSON<DiscoveryResult>(p(wikiDir, DISCOVERY_FILE));
  const classified = readJSON<ClassifiedInventory>(p(wikiDir, CLASSIFIED_FILE));
  if (!discovery || !classified) {
    return "Missing discovery/classified artifacts. Delete the `wiki/` JSON files and re-run `generate_wiki()`.";
  }

  let gitRef = "unknown";
  try {
    gitRef = execSync("git rev-parse --short HEAD", { cwd: projectDir }).toString().trim();
  } catch {
    // not a git repo
  }

  const cluster: ClusterMode = clusterOverride ?? "files";
  const unmatchedDocs =
    readJSON<{ path: string; content: string }[]>(p(wikiDir, ISOLATE_DOCS_FILE)) ?? [];
  const flows = readJSON<import("../wiki/types").FlowsFile>(p(wikiDir, FLOWS_FILE)) ?? undefined;
  const result = await runWikiFinalPlanning(
    ragDb,
    projectDir,
    gitRef,
    discovery,
    classified,
    bundles,
    syntheses,
    unmatchedDocs,
    config,
    cluster,
    flows,
  );
  writeJSON(p(wikiDir, MANIFEST_FILE), result.manifest);
  writeJSON(p(wikiDir, CONTENT_FILE), result.content);
  writeWritingRulesFile(wikiDir);
  appendInitLog(wikiDir, gitRef, result.manifest);

  return buildInitResponse(result.manifest, result.content, result.warnings);
}

/**
 * Path (relative to the project root) where writing rules live. Project-
 * local deliberately — no harness-specific location — so any LLM or
 * wrapper (Claude, Cursor, Aider, a CI bot) sees the same file.
 */
const WRITING_RULES_PROJECT_PATH = "wiki/_meta/writing-rules.md";

/**
 * Persist the writing rules to `wiki/_meta/writing-rules.md` once per
 * planning pass. Writer agents read the file via the standard `Read`
 * tool instead of receiving the full 2 KB rules blob inlined into every
 * init / finalize / incremental response. Orchestrator prompts shrink;
 * per-agent Reads are the same shape as any other project file lookup.
 */
function writeWritingRulesFile(wikiDir: string): void {
  const rulesPath = join(wikiDir, "_meta", "writing-rules.md");
  const body = `# Wiki writing rules\n\nFollow these when writing or editing a wiki page returned by \`generate_wiki(page: N)\` / \`wiki_rewrite_page\`. Re-read when guidance looks stale or you're unsure.\n\n${WRITING_RULES}\n`;
  try {
    mkdirSync(dirname(rulesPath), { recursive: true });
    writeFileSync(rulesPath, body, "utf-8");
  } catch {
    // Non-fatal: the init/finalize responses carry a fallback inline
    // mention of the rules location so a missing file is still
    // recoverable.
  }
}

/** Parallelism default for the Agent-batch planner. 4 balances Claude Code
 *  rate limits vs. sub-linear scaling past 6. */
const WRITER_PARALLELISM = 4;

/** Wave 2 kinds — aggregate pages that link into community pages, so they
 *  must run after Wave 1. */
const AGGREGATE_KINDS = new Set(["architecture", "getting-started", "data-flows"]);

interface SizedPage {
  idx: number;
  path: string;
  title: string;
  kind: string;
  depth: string;
  bytes: number;
}

function buildInitResponse(
  manifest: PageManifest,
  content: ContentCache,
  warnings: string[],
): string {
  const pages = Object.entries(manifest.pages).sort(([, a], [, b]) => a.order - b.order);
  const counts: Record<string, number> = {};
  for (const [, p] of pages) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  const summary = Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(", ");

  const sized: SizedPage[] = pages.map(([path, page], idx) => {
    const cached = content[path];
    return {
      idx,
      path,
      title: page.title,
      kind: page.kind,
      depth: page.depth,
      bytes: cached ? JSON.stringify(cached).length : 0,
    };
  });
  const totalBytes = sized.reduce((n, p) => n + p.bytes, 0);

  let text = `# Wiki Generation Plan\n\n`;
  text += `Computed ${pages.length} pages: ${summary}\n\n`;

  if (warnings.length > 0) {
    text += `**Warnings:**\n`;
    for (const w of warnings) text += `- ${w}\n`;
    text += `\n`;
  }

  text += `## Page list (generation order)\n\n`;
  text += `\`bytes\` = rendered payload size from \`_content.json\` — longer payload, slower write. The batch plan below uses this to balance parallel load (longest-processing-time scheduling), so the heaviest pages naturally land in their own bins.\n\n`;
  text += `| # | path | kind | depth | bytes |\n`;
  text += `|---|------|------|-------|-------|\n`;
  for (const p of sized) {
    text += `| ${p.idx} | \`${p.path}\` | ${p.kind} | ${p.depth} | ${p.bytes.toLocaleString()} |\n`;
  }
  text += `\n**Total payload bytes:** ${totalBytes.toLocaleString()}\n\n`;

  const wave1 = sized.filter((p) => !AGGREGATE_KINDS.has(p.kind));
  const wave2 = sized.filter((p) => AGGREGATE_KINDS.has(p.kind));
  const wave1Batches = packBatches(wave1, WRITER_PARALLELISM);
  const wave2Batches = packBatches(wave2, Math.min(WRITER_PARALLELISM, wave2.length || 1));

  text += `\n## Writing rules\n\nRules live at \`${WRITING_RULES_PROJECT_PATH}\`. Every writer must Read that file once before drafting its first page. The file is regenerated at planning time; re-read if it looks stale.\n\n`;

  text += `## Parallel writing plan\n\n`;
  text += `Two waves. Wave 2 waits for Wave 1 because aggregate pages link into community pages. Within each wave, fire ALL Agent calls in a SINGLE message (multiple Agent tool calls in one assistant turn) — sequential calls serialize.\n\n`;
  text += renderWave("Wave 1 — community + community-file pages", wave1Batches);
  if (wave2.length > 0) {
    text += renderWave("Wave 2 — aggregate pages (architecture, getting-started, data-flows)", wave2Batches);
  }
  text += `\n**Each Agent prompt template:**\n\n`;
  text += "```\nYou are writing wiki pages. For each page index in your batch [LIST]:\n";
  text += `  1. Read ${WRITING_RULES_PROJECT_PATH} once — the authoritative rules for diagram, link, and prose conventions.\n`;
  text += "  2. Call generate_wiki(page: i) — returns the payload (title, purpose, sections, bundle, link map).\n";
  text += "  3. Write the page at the path returned by the payload. Follow the writing rules exactly.\n";
  text += "  4. Call wiki_lint_page(path) after writing. If it reports issues, fix in place.\n";
  text += "Report 'done' with the list of files written when complete.\n```\n\n";
  text += `**After all waves complete:** call \`generate_wiki(finalize: true)\`.\n`;
  text += `\n${WORKFLOW_TIPS}\n`;

  return text;
}

/**
 * Longest-processing-time (LPT) bin-packing: sort pages by bytes desc, then
 * assign each to the lightest-loaded bin. Minimises max-bin total, which is
 * the parallel wall-clock lower bound for N agents. Heaviest pages naturally
 * end up in their own bins because each bin starts empty.
 */
function packBatches(pages: SizedPage[], n: number): SizedPage[][] {
  if (pages.length === 0) return [];
  const bins: { pages: SizedPage[]; total: number }[] = Array.from(
    { length: Math.max(1, n) },
    () => ({ pages: [], total: 0 }),
  );
  const sorted = [...pages].sort((a, b) => b.bytes - a.bytes);
  for (const p of sorted) {
    const target = bins.reduce((min, cur) => (cur.total < min.total ? cur : min), bins[0]);
    target.pages.push(p);
    target.total += p.bytes;
  }
  return bins
    .filter((b) => b.pages.length > 0)
    .map((b) => b.pages.sort((a, b) => a.idx - b.idx));
}

function renderWave(label: string, batches: SizedPage[][]): string {
  if (batches.length === 0) return "";
  let text = `### ${label}\n\n`;
  text += `Spawn ${batches.length} Agent${batches.length === 1 ? "" : "s"} in parallel. Batches balanced by payload bytes (LPT).\n\n`;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const total = batch.reduce((n, p) => n + p.bytes, 0);
    const ids = batch.map((p) => p.idx).join(", ");
    text += `- **Agent ${i + 1}** — pages \`[${ids}]\` (${total.toLocaleString()} bytes)\n`;
    for (const p of batch) {
      text += `  - ${p.idx}: \`${p.path}\` (${p.bytes.toLocaleString()} bytes)\n`;
    }
  }
  text += `\n`;
  return text;
}

// ── Page payload rendering ──

function buildPageResponse(wikiDir: string, pageIndex: number): string {
  const manifest = readJSON<PageManifest>(p(wikiDir, MANIFEST_FILE));
  const content = readJSON<ContentCache>(p(wikiDir, CONTENT_FILE));
  if (!manifest || !content) {
    return "No manifest on disk. Call `generate_wiki()` to finish planning first.";
  }

  let payload: PagePayload;
  try {
    payload = getPagePayload(pageIndex, manifest, content);
  } catch (e: any) {
    return e.message;
  }
  return renderPagePayload(payload);
}

/**
 * Per-member `Read` breadcrumbs for community pages. The bundle inlines
 * only the top-PageRank file's body; per-file prose about other members
 * would otherwise be written from signatures alone (the v73 failure mode
 * — generic prose with fabricated behavior).
 *
 * Scope: only the top-PageRank `MAX_READ_BREADCRUMBS` non-top members.
 * Beyond that the token cost of listing every small member outweighs the
 * value — the writer can still Read any file on demand, but we stop
 * pushing them to do so for a 50-LOC leaf.
 *
 * Reason strings are deliberately bounded: "preview covers it" (the
 * writer doesn't need to Read unless citing a non-previewed symbol),
 * versus "Read before citing behavior" (no preview shipped). The earlier
 * wording "Read if deeper detail needed" read as mandatory.
 */
interface ReadBreadcrumb {
  path: string;
  reason: string;
}

const MAX_READ_BREADCRUMBS = 8;

export function communityReadBreadcrumbs(
  payload: PagePayload,
): ReadBreadcrumb[] {
  const bundle = payload.prefetched.community;
  if (!bundle) return [];
  const top = bundle.topRankedFile;
  const previewedFiles = new Set(bundle.memberPreviews?.map((p) => p.file) ?? []);
  const pageRank = bundle.pageRank ?? {};
  const candidates = bundle.memberFiles
    .filter((f) => f !== top)
    .sort((a, b) => (pageRank[b] ?? 0) - (pageRank[a] ?? 0) || a.localeCompare(b))
    .slice(0, MAX_READ_BREADCRUMBS);
  return candidates.map((file) => ({
    path: file,
    reason: previewedFiles.has(file)
      ? "preview covers it — Read only if prose cites a non-previewed symbol"
      : "no preview shipped — Read before citing behavior or per-file prose",
  }));
}

/**
 * Page-kind-specific semantic queries. Mirrors the v1.1.6 `buildSemanticQueries`
 * dispatch — the writer gets 2-3 queries matched to the page's role so it
 * doesn't have to invent search terms. Queries run through `read_relevant`,
 * which returns actual source chunks ranked by relevance.
 */
interface SuggestedQuery {
  tool: "read_relevant" | "find_usages" | "search_symbols" | "Read";
  query: string;
  reason: string;
}

/**
 * Non-semantic follow-up suggestions for a page — anything that isn't
 * already covered by `payload.semanticQueries` (the canonical
 * `read_relevant` list defined in `src/wiki/semantic-queries.ts`).
 *
 * Current scope is just `community-file` sub-pages: the writer needs a
 * full `Read` of each scoped member before writing Role/Exports/Internals
 * prose, which semantic queries can't replace. All other kinds rely on
 * the semantic-queries list alone — the prior "read_relevant <kind
 * boilerplate>" entries duplicated that list and were dropped.
 */
export function suggestedQueriesFor(payload: PagePayload): SuggestedQuery[] {
  if (payload.kind !== "community-file") return [];
  const files = payload.prefetched.community?.memberFiles ?? [];
  const out: SuggestedQuery[] = [];
  for (const f of files) {
    out.push({
      tool: "Read",
      query: f,
      reason:
        "read the whole file — the scoped bundle gives signatures, the file tells you what the exports actually do",
    });
  }
  if (files.length === 0) {
    out.push({
      tool: "Read",
      query: payload.title,
      reason: "read the member file",
    });
  }
  return out;
}

function renderAssistBlock(payload: PagePayload): string {
  const breadcrumbs = communityReadBreadcrumbs(payload);
  const queries = suggestedQueriesFor(payload);
  if (breadcrumbs.length === 0 && queries.length === 0) return "";

  let text = `## When you need more context\n\n`;
  text += `The bundle above is a starting point, not the full picture. When a section needs behavior-level detail beyond what's inlined, use these tools. Never describe a file's behavior from its signatures alone.\n\n`;

  if (breadcrumbs.length > 0) {
    text += `**Member files you may need to Read** — top-PageRank ${breadcrumbs.length} non-top member${breadcrumbs.length === 1 ? "" : "s"}. The bundle already inlines the top-PageRank member's body and previews for most others; "Read" here is a pointer, not a requirement.\n\n`;
    for (const b of breadcrumbs) {
      text += `- \`Read ${b.path}\` — ${b.reason}\n`;
    }
    text += `\n`;
  }

  if (queries.length > 0) {
    text += `**Suggested queries when the bundle leaves a gap:**\n\n`;
    for (const q of queries) {
      text += `- \`${q.tool}\` with \`"${q.query}"\` — ${q.reason}\n`;
    }
    text += `\n`;
  }

  return text;
}

function renderPagePayload(payload: PagePayload): string {
  let text = `# Page: ${payload.title}\n\n`;
  text += `**Path:** \`${payload.wikiPath}\`\n`;
  text += `**Kind:** ${payload.kind} | **Depth:** ${payload.depth}\n`;
  text += `**Slug:** \`${payload.slug}\`\n\n`;
  text += `**Purpose:** ${payload.purpose}\n\n`;

  text += renderPageHeaderBlock(payload);
  text += renderSeeAlsoDirective(payload);

  text += `## Sections to write\n\n`;
  for (let i = 0; i < payload.sections.length; i++) {
    const s = payload.sections[i];
    text += `${i + 1}. **${s.title}** — ${s.purpose}\n`;
    if (s.shape) text += `   - shape: ${s.shape}\n`;
  }
  text += `\n`;

  if (payload.prefetchedQueries.length > 0) {
    text += `## Pre-run semantic queries\n\n`;
    text += `These were run with \`read_relevant\` at planning time — results below. **Do not re-run** unless a section needs an angle the pre-run missed; in that case call \`read_relevant\` with a different query.\n\n`;
    for (const block of payload.prefetchedQueries) {
      text += `### Query: \`${block.query}\`\n\n`;
      if (block.results.length === 0) {
        text += `_(no chunks above the relevance threshold)_\n\n`;
        continue;
      }
      for (const r of block.results) {
        const range = r.startLine != null && r.endLine != null ? `:${r.startLine}-${r.endLine}` : "";
        const entity = r.entityName ? ` • ${r.entityName}` : "";
        text += `**[${r.score.toFixed(2)}] \`${r.path}${range}\`**${entity}\n`;
        const fence = inferFence(r.path);
        text += `\`\`\`${fence}\n${r.snippet}\n\`\`\`\n\n`;
      }
    }
  } else if (payload.semanticQueries.length > 0) {
    text += `## Semantic queries to run before drafting\n\n`;
    text += `Run each with \`read_relevant\` to surface dimensions the bundle may miss. `;
    text += `Results ground the matching section; skip when the bundle already covers it.\n\n`;
    for (const q of payload.semanticQueries) {
      text += `- \`${q}\`\n`;
    }
    text += `\n`;
  }

  if (payload.prefetched.community) {
    text += renderCommunityBundle(payload.prefetched.community, payload.depth);
  } else if (payload.prefetched.architecture) {
    text += renderArchitectureBundle(payload.prefetched.architecture);
  } else if (payload.prefetched.gettingStarted) {
    text += renderGettingStartedBundle(payload.prefetched.gettingStarted);
  } else if (payload.prefetched.queueDetail) {
    text += renderQueueDetailBundle(payload.prefetched.queueDetail);
  } else if (payload.prefetched.endpointGroup) {
    text += renderEndpointGroupBundle(payload.prefetched.endpointGroup);
  } else if (payload.prefetched.dataFlow) {
    text += renderDataFlowBundle(payload.prefetched.dataFlow);
  } else if (payload.prefetched.serviceAggregate) {
    text += renderServiceAggregateBundle(payload.prefetched.serviceAggregate);
  }

  text += renderAssistBlock(payload);

  if (payload.relatedPages.length > 0) {
    text += `## Related pages\n\n`;
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

  if (Object.keys(payload.linkMap).length > 0) {
    text += `## Link map\n\n`;
    for (const [title, relPath] of Object.entries(payload.linkMap)) {
      text += `- **${title}**: \`[${title}](${relPath})\`\n`;
    }
    text += `\n`;
  }

  return text;
}

/**
 * Render the required per-page header block — the breadcrumb (if any) and
 * the generation stamp. Writers copy this verbatim as the first content
 * below the H1 so every page carries a ref-and-date marker and sub-pages
 * link back up the tree.
 *
 * Breadcrumb text comes from `payload.preRendered.breadcrumb` so the tool
 * and writer can't drift on how the trail is assembled. The stamp is
 * appended here because its date is "time the writer ran", not a property
 * of the manifest.
 */
function renderPageHeaderBlock(payload: PagePayload): string {
  const stampDate = new Date().toISOString().slice(0, 10);
  let text = `## Required page header\n\n`;
  text += `Emit this verbatim as the first content below the H1 title, before any section:\n\n`;
  text += "```markdown\n";
  if (payload.preRendered.breadcrumb) {
    text += `${payload.preRendered.breadcrumb}\n>\n`;
  }
  text += `> Generated from \`${payload.generatedFrom}\` · ${stampDate}\n`;
  text += "```\n\n";
  return text;
}

/**
 * Render the required "See also" block. Writers copy it verbatim as the
 * last section on the page. Pre-rendering (versus telling the writer to
 * author one) was added after 0/12 community pages in the v2 run produced
 * a "See also" section from prose rules alone. Empty string when the page
 * has no related pages so the caller can concatenate unconditionally.
 */
function renderSeeAlsoDirective(payload: PagePayload): string {
  if (!payload.preRendered.seeAlso) return "";
  let text = `## Required "See also" block\n\n`;
  text += `Emit this verbatim as the last section on the page, after every other section. Do NOT author a different See also — the links here are derived from the manifest and are correct by construction:\n\n`;
  text += "````markdown\n";
  text += `${payload.preRendered.seeAlso}\n`;
  text += "````\n\n";
  return text;
}

/**
 * Map a file extension to a Markdown code-fence language hint so the top-
 * member source block renders with syntax highlighting in whatever viewer
 * reads it. Falls back to plain text for extensions we don't recognize.
 */
function inferFence(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = filePath.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    php: "php", swift: "swift", kt: "kotlin", scala: "scala",
    c: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", h: "c", hpp: "cpp",
    cs: "csharp", md: "md", sh: "bash", bash: "bash", zsh: "bash",
    sql: "sql", json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  };
  return map[ext] ?? "";
}

/**
 * Byte caps for nearby-docs in community page payloads. Matches the cap used
 * in the synthesis prompt; together they prevent large READMEs/design notes
 * from dominating token spend.
 */
const NEARBY_DOC_BYTES_CAP = 2 * 1024;
const NEARBY_DOCS_TOTAL_BYTES_CAP = 12 * 1024;

/**
 * Sample size for externalConsumers / externalDependencies inlined in the
 * page payload. Previously we shipped up to 30 each; downstream links are
 * lazy (writer calls read_relevant / depends_on when needed), so a small
 * head sample plus a count is enough for orientation.
 */
const EXTERNAL_DEP_SAMPLE = 5;

/**
 * Per-file edge attribution caps. Render the importer/dependency map only
 * for bundles with ≤ PER_FILE_EDGES_MAX_MEMBERS members — typical sub-pages
 * (1–5 files) — so the writer doesn't re-grep `depended_on_by`. Parent
 * community pages keep the flat aggregate to stay compact. Per-direction
 * cap keeps a hub file's 50 importers from dominating the prompt.
 */
const PER_FILE_EDGES_MAX_MEMBERS = 5;
const PER_FILE_EDGE_SAMPLE = 8;

function renderExportsByFile(b: import("../wiki/types").CommunityBundle): string {
  const byFile = new Map<string, typeof b.exports>();
  for (const e of b.exports) {
    const arr = byFile.get(e.file) ?? [];
    arr.push(e);
    byFile.set(e.file, arr);
  }
  let text = `**Exports (${b.exports.length}) — grouped by file for per-file prose:**\n\n`;
  const sortedFiles = [...byFile.keys()].sort();
  for (const file of sortedFiles) {
    const exports = byFile.get(file)!;
    text += `### \`${file}\`\n\n`;
    text += `| Name | Kind | Signature |\n|------|------|-----------|\n`;
    for (const e of exports) {
      const sig = e.signature
        .split("\n")[0]
        .replace(/\|/g, "\\|")
        .trim();
      text += `| \`${e.name}\` | ${e.type} | \`${sig}\` |\n`;
    }
    text += `\n`;
  }
  return text;
}

function renderCommunityBundle(
  b: import("../wiki/types").CommunityBundle,
  depth: import("../wiki/types").PageDepth = "standard",
): string {
  let text = `## Community bundle\n\n`;
  text += `**Member files (${b.memberFiles.length}):**\n`;
  for (const f of b.memberFiles) text += `- \`${f}\`\n`;
  text += `\n`;
  if (b.topRankedFile) {
    text += `**Top PageRank member:** \`${b.topRankedFile}\`\n`;
    text += `_Read this file before writing about behavior. Signatures tell you what is exported; the source tells you what it does. Any behavior you describe must be visible in a file you Read yourself._\n\n`;
  }

  const previews = b.memberPreviews ?? [];
  if (previews.length > 0) {
    text += `**Member previews (rank 2..N) — first lines of each non-top member, highest PageRank first.**\n`;
    text += `Use these for context; Read the full file only when deeper detail is needed.\n\n`;
    for (const p of previews) {
      const fence = inferFence(p.file);
      text += `### \`${p.file}\` (${p.loc} LOC)\n\n`;
      text += `\`\`\`${fence}\n${p.firstLines}\n\`\`\`\n\n`;
    }
  } else if (depth !== "full" && b.memberFiles.length > 1) {
    text += `**Member previews not shipped at depth=\`${depth}\`.** Signatures above cover the API surface; Read a member file directly when prose needs to ground in its code.\n\n`;
  }

  if (b.tunables.length > 0) {
    const total = b.tunableCount;
    const shown = b.tunables.length;
    const header = shown < total
      ? `**Tunables (${shown} shown of ${total}) — quote literals verbatim in prose:**`
      : `**Tunables (${shown}) — quote literals verbatim in prose:**`;
    text += `${header}\n\n`;
    for (const t of b.tunables) {
      text += `- **${t.name}** (${t.type}) — \`${t.file}\`\n`;
      text += "  ```\n";
      for (const l of t.snippet.split("\n")) text += `  ${l}\n`;
      text += "  ```\n";
    }
    text += `\n`;
  }

  if (b.exports.length > 0) {
    // Full depth + large community → render a per-file table the writer can
    // transcribe almost verbatim into the per-file breakdown. Lower depths
    // keep the flat bullet-per-export form so the writer has room for
    // narrative over reference.
    if (depth === "full" && b.memberFiles.length >= 10) {
      text += renderExportsByFile(b);
    } else {
      const total = b.exportCount ?? b.exports.length;
      const shown = b.exports.length;
      const header = shown < total
        ? `**Exports (${shown} shown of ${total} — top by per-file PageRank):**\n\n`
        : `**Exports (${shown}):**\n\n`;
      text += header;
      for (const e of b.exports) {
        text += `- **${e.name}** (${e.type}) — \`${e.file}\`\n`;
        text += "  ```\n";
        for (const l of e.signature.split("\n").slice(0, 6)) text += `  ${l}\n`;
        text += "  ```\n";
      }
      text += `\n`;
    }
  }

  if (b.externalConsumers.length > 0) {
    text += `**External consumers (${b.externalConsumers.length}) — sample; call \`depended_on_by\` on a member for the full list:**\n`;
    for (const f of b.externalConsumers.slice(0, EXTERNAL_DEP_SAMPLE)) text += `- \`${f}\`\n`;
    if (b.externalConsumers.length > EXTERNAL_DEP_SAMPLE) {
      text += `- … (+${b.externalConsumers.length - EXTERNAL_DEP_SAMPLE} more — use \`depended_on_by\` if needed)\n`;
    }
    text += `\n`;
  }

  if (b.externalDependencies.length > 0) {
    text += `**External dependencies (${b.externalDependencies.length}) — sample; call \`depends_on\` on a member for the full list:**\n`;
    for (const f of b.externalDependencies.slice(0, EXTERNAL_DEP_SAMPLE)) text += `- \`${f}\`\n`;
    if (b.externalDependencies.length > EXTERNAL_DEP_SAMPLE) {
      text += `- … (+${b.externalDependencies.length - EXTERNAL_DEP_SAMPLE} more — use \`depends_on\` if needed)\n`;
    }
    text += `\n`;
  }

  // Per-file edge attribution — render for small bundles (typical sub-page).
  // Lets the writer cite "X imports `path`" without a `depended_on_by` round
  // trip per member. Capped at PER_FILE_EDGE_SAMPLE per direction so a hub
  // file with 50 importers doesn't blow up the prompt.
  if (b.memberFiles.length > 0 && b.memberFiles.length <= PER_FILE_EDGES_MAX_MEMBERS) {
    const cm = b.consumersByFile ?? {};
    const dm = b.dependenciesByFile ?? {};
    const hasAny = b.memberFiles.some((f) => (cm[f]?.length ?? 0) + (dm[f]?.length ?? 0) > 0);
    if (hasAny) {
      text += `**Edges per file (importers ↑ / dependencies ↓):**\n`;
      for (const f of b.memberFiles) {
        const cs = cm[f] ?? [];
        const ds = dm[f] ?? [];
        if (cs.length === 0 && ds.length === 0) continue;
        text += `- \`${f}\`\n`;
        if (cs.length > 0) {
          const shown = cs.slice(0, PER_FILE_EDGE_SAMPLE).map((p) => `\`${p}\``).join(", ");
          const tail = cs.length > PER_FILE_EDGE_SAMPLE ? ` … (+${cs.length - PER_FILE_EDGE_SAMPLE})` : "";
          text += `  - ↑ imported by: ${shown}${tail}\n`;
        }
        if (ds.length > 0) {
          const shown = ds.slice(0, PER_FILE_EDGE_SAMPLE).map((p) => `\`${p}\``).join(", ");
          const tail = ds.length > PER_FILE_EDGE_SAMPLE ? ` … (+${ds.length - PER_FILE_EDGE_SAMPLE})` : "";
          text += `  - ↓ depends on: ${shown}${tail}\n`;
        }
      }
      text += `\n`;
    }
  }

  if (b.annotations.length > 0) {
    text += `**Annotations:**\n`;
    for (const a of b.annotations) text += `- \`${a.file}:${a.line}\` — ${a.note}\n`;
    text += `\n`;
  }

  const ss = b.serviceSignals;
  if (ss) {
    const header = (label: string, shown: number, total: number | undefined): string => {
      const count = total !== undefined && total > shown ? `${shown} shown of ${total}` : `${shown}`;
      return `**${label} (${count}):**\n`;
    };
    const overflow = (shown: number, total: number | undefined): string => {
      if (total === undefined || total <= shown) return "";
      return `- … (+${total - shown} more — call \`find_usages\` on a member symbol to surface the rest)\n`;
    };
    text += `## Service signals\n\n`;
    text += `_Role: \`${ss.role}\`. Use these to ground service-flavored sections (endpoint-catalog, queue-topology, data-stores, etc.). Cite file:line verbatim — do not paraphrase._\n\n`;
    if (ss.routes.length > 0) {
      text += header("Routes", ss.routes.length, ss.totals?.routes);
      for (const r of ss.routes) {
        const handler = r.handlerSymbol ? ` → \`${r.handlerSymbol}\`` : "";
        text += `- \`${r.method} ${r.path}\`${handler} — \`${r.file}:${r.line}\`\n`;
      }
      text += overflow(ss.routes.length, ss.totals?.routes);
      text += `\n`;
    }
    if (ss.queueOps.length > 0) {
      text += header("Queue ops", ss.queueOps.length, ss.totals?.queueOps);
      for (const q of ss.queueOps) {
        text += `- ${q.kind} \`${q.topic}\` — \`${q.file}:${q.line}\`\n`;
      }
      text += overflow(ss.queueOps.length, ss.totals?.queueOps);
      text += `\n`;
    }
    if (ss.dataOps.length > 0) {
      text += header("Data ops", ss.dataOps.length, ss.totals?.dataOps);
      for (const d of ss.dataOps) {
        const model = d.model ? ` \`${d.model}\`` : "";
        text += `- ${d.op}${model} (${d.store}) — \`${d.file}:${d.line}\`\n`;
      }
      text += overflow(ss.dataOps.length, ss.totals?.dataOps);
      text += `\n`;
    }
    if (ss.externalCalls.length > 0) {
      text += header("External calls", ss.externalCalls.length, ss.totals?.externalCalls);
      for (const e of ss.externalCalls) {
        const sdk = e.sdk ? `[${e.sdk}] ` : "";
        const host = e.host ? `\`${e.host}\` ` : "";
        text += `- ${sdk}${host}— \`${e.file}:${e.line}\`\n`;
      }
      text += overflow(ss.externalCalls.length, ss.totals?.externalCalls);
      text += `\n`;
    }
    if (ss.scheduledJobs.length > 0) {
      text += header("Scheduled jobs", ss.scheduledJobs.length, ss.totals?.scheduledJobs);
      for (const j of ss.scheduledJobs) {
        const handler = j.handler ? ` → \`${j.handler}\`` : "";
        text += `- \`${j.schedule}\`${handler} — \`${j.file}:${j.line}\`\n`;
      }
      text += overflow(ss.scheduledJobs.length, ss.totals?.scheduledJobs);
      text += `\n`;
    }
  }

  if (b.recentCommits.length > 0) {
    text += `**Recent commits:**\n`;
    for (const c of b.recentCommits) text += `- \`${c.sha.slice(0, 8)}\` (${c.date}) — ${c.message.split("\n")[0]}\n`;
    text += `\n`;
  }

  if (b.nearbyDocs.length > 0) {
    text += `**Nearby docs (${b.nearbyDocs.length}):**\n`;
    text += `_Markdown/text files co-located with this community — treat as source material, not inspiration. Previews are capped; Read the path for full content._\n\n`;
    let totalBytes = 0;
    let shown = 0;
    for (const d of b.nearbyDocs) {
      if (totalBytes >= NEARBY_DOCS_TOTAL_BYTES_CAP) {
        text += `- … (+${b.nearbyDocs.length - shown} more — Read the path when relevant)\n\n`;
        break;
      }
      const { preview, truncated } = clipDocPreview(d.content, NEARBY_DOC_BYTES_CAP);
      text += `### ${d.path}${truncated ? " (truncated — Read full doc if needed)" : ""}\n\n\`\`\`md\n${preview}\n\`\`\`\n\n`;
      totalBytes += Buffer.byteLength(preview, "utf-8");
      shown++;
    }
  }

  return text;
}

function renderArchitectureBundle(b: import("../wiki/types").ArchitectureBundle): string {
  let text = `## Architecture bundle\n\n`;
  text += `**Communities (${b.communities.length}):**\n`;
  for (const c of b.communities) {
    const rank = b.communityPageRank[c.slug]?.toFixed(4) ?? "—";
    text += `- **${c.name}** (\`${c.slug}\`, PR=${rank}) — ${c.purpose}\n`;
  }
  text += `\n`;

  if (b.metaEdges.length > 0) {
    text += `**Community meta-graph edges (${b.metaEdges.length}):**\n`;
    for (const e of b.metaEdges.slice(0, 40)) {
      text += `- \`${e.from}\` → \`${e.to}\` (weight ${e.weight})\n`;
    }
    if (b.metaEdges.length > 40) text += `- … (+${b.metaEdges.length - 40} more)\n`;
    text += `\n`;
  }

  if (b.topHubs.length > 0) {
    const totalCommunities = b.communities.length;
    text += `**Top hubs (${b.topHubs.length}) — cite fan-in / fan-out as raw integers in prose.** PageRank ranks; fanIn/fanOut are the citable counts a reader can verify with \`depended_on_by\` / \`depends_on\`. `;
    text += `Importing-community count phrases as a ready sentence: _"imported by N of ${totalCommunities} communities"_. `;
    text += `Bridges name the 2–4 communities that sit at the hub's boundary, useful when explaining why the hub is load-bearing.\n`;
    for (const h of b.topHubs.slice(0, 20)) {
      const bridges = h.bridges.length > 0 ? ` — bridges: ${h.bridges.slice(0, 4).join(", ")}` : "";
      const imports = h.importingCommunities.length > 0
        ? ` — imported by ${h.importingCommunities.length} of ${totalCommunities} communities: ${h.importingCommunities.slice(0, 6).join(", ")}${h.importingCommunities.length > 6 ? ", …" : ""}`
        : "";
      text += `- \`${h.path}\` (fanIn=${h.fanIn}, fanOut=${h.fanOut}, PR=${h.pageRank.toFixed(4)})${imports}${bridges}\n`;
    }
    text += `\n`;
  }

  if (b.entryPoints.length > 0) {
    text += `**Entry points (${b.entryPoints.length}):**\n`;
    for (const ep of b.entryPoints.slice(0, 10)) {
      const names = ep.exports.slice(0, 4).map((e) => `${e.type} ${e.name}`).join(", ");
      text += `- \`${ep.path}\` — ${names || "(no exports)"}\n`;
    }
    text += `\n`;
  }

  if (b.crossCuttingFiles.length > 0) {
    text += `**Cross-cutting test infrastructure (${b.crossCuttingFiles.length}) — high-fanIn files Louvain excludes from communities. Surface as a brief footnote ("test fixtures: \`tests/helpers.ts\` is imported by N test files"); do not give them their own section.**\n`;
    for (const f of b.crossCuttingFiles) {
      text += `- \`${f.path}\` (fanIn=${f.fanIn}, fanOut=${f.fanOut}, ${f.reason})\n`;
    }
    text += `\n`;
  }

  if (b.rootDocs.length > 0) {
    text += `**Root docs — preview only. Read the full file when relevant.**\n\n`;
    for (const d of b.rootDocs) {
      text += `### \`${d.path}\` (${d.byteSize} bytes)\n\n`;
      text += "```md\n";
      text += d.firstLines;
      text += "\n```\n\n";
    }
  }

  if (b.architecturalNotes.length > 0) {
    text += `**Architectural notes:**\n`;
    for (const n of b.architecturalNotes.slice(0, 30)) {
      text += `- \`${n.file}:${n.line}\` — ${n.note}\n`;
    }
    text += `\n`;
  }

  if (b.supplementaryDocs.length > 0) {
    text += `**Supplementary docs (${b.supplementaryDocs.length}) — preview only. Read the full file when relevant.**\n`;
    text += `_Project-wide markdown/text not pinned to any community._\n\n`;
    for (const d of b.supplementaryDocs) {
      text += `### \`${d.path}\` (${d.byteSize} bytes)\n\n`;
      text += "```md\n";
      text += d.firstLines;
      text += "\n```\n\n";
    }
  }

  return text;
}

function renderGettingStartedBundle(b: import("../wiki/types").GettingStartedBundle): string {
  let text = `## Getting-started bundle\n\n`;
  if (b.readme) {
    text += `**README:**\n\n\`\`\`md\n${b.readme}\n\`\`\`\n\n`;
  } else {
    text += `_No README found._\n\n`;
  }

  if (b.packageManifest) {
    text += `**package.json (or equivalent):**\n\n\`\`\`json\n${JSON.stringify(b.packageManifest, null, 2)}\n\`\`\`\n\n`;
  }

  if (b.topCommunity) {
    text += `**Top community:** ${b.topCommunity.name} (\`${b.topCommunity.slug}\`) — ${b.topCommunity.purpose}\n\n`;
  }

  if (b.cliEntryPoints.length > 0) {
    text += `**CLI entry points:**\n`;
    for (const cp of b.cliEntryPoints) {
      const names = cp.exports.slice(0, 4).map((e) => `${e.type} ${e.name}`).join(", ");
      text += `- \`${cp.path}\` — ${names || "(no exports)"}\n`;
    }
    text += `\n`;
  }

  if (b.configFiles.length > 0) {
    text += `**Config files:**\n`;
    for (const c of b.configFiles) {
      text += `\n### ${c.path}\n\n\`\`\`\n${c.content}\n\`\`\`\n`;
    }
    text += `\n`;
  }

  if (b.originCommits.length > 0) {
    text += `**Origin commits:**\n`;
    for (const c of b.originCommits) {
      text += `- \`${c.sha.slice(0, 8)}\` (${c.date}) — ${c.message.split("\n")[0]}\n`;
    }
    text += `\n`;
  }

  return text;
}

function renderServiceAggregateBundle(
  b: import("../wiki/types").ServiceAggregateBundle,
): string {
  let text = `## Service aggregate bundle\n\n`;
  text += `**Project kind:** \`${b.profile.kind}\``;
  if (b.profile.framework) text += ` (${b.profile.framework})`;
  text += `\n\n`;
  text += `_${b.profile.summary}_\n\n`;

  if (b.routes.length > 0) {
    text += `**Routes (${b.routes.length}) — across all communities:**\n`;
    for (const r of b.routes) {
      const handler = r.handlerSymbol ? ` → \`${r.handlerSymbol}\`` : "";
      text += `- \`${r.method} ${r.path}\`${handler} — \`${r.file}:${r.line}\` (community: \`${r.communitySlug}\`)\n`;
    }
    text += `\n`;
  }

  if (b.queueOps.length > 0) {
    text += `**Queue ops (${b.queueOps.length}):**\n`;
    for (const q of b.queueOps) {
      text += `- ${q.kind} \`${q.topic}\` — \`${q.file}:${q.line}\` (community: \`${q.communitySlug}\`)\n`;
    }
    text += `\n`;
  }

  if (b.dataOps.length > 0) {
    text += `**Data ops (${b.dataOps.length}):**\n`;
    for (const d of b.dataOps) {
      const model = d.model ? ` \`${d.model}\`` : "";
      text += `- ${d.op}${model} (${d.store}) — \`${d.file}:${d.line}\` (community: \`${d.communitySlug}\`)\n`;
    }
    text += `\n`;
  }

  if (b.externalCalls.length > 0) {
    text += `**External calls (${b.externalCalls.length}):**\n`;
    for (const e of b.externalCalls) {
      const sdk = e.sdk ? `[${e.sdk}] ` : "";
      const host = e.host ? `\`${e.host}\` ` : "";
      text += `- ${sdk}${host}— \`${e.file}:${e.line}\` (community: \`${e.communitySlug}\`)\n`;
    }
    text += `\n`;
  }

  if (b.scheduledJobs.length > 0) {
    text += `**Scheduled jobs (${b.scheduledJobs.length}):**\n`;
    for (const j of b.scheduledJobs) {
      const handler = j.handler ? ` → \`${j.handler}\`` : "";
      text += `- \`${j.schedule}\`${handler} — \`${j.file}:${j.line}\` (community: \`${j.communitySlug}\`)\n`;
    }
    text += `\n`;
  }

  return text;
}

function renderQueueDetailBundle(
  b: import("../wiki/types").QueueDetailBundle,
): string {
  let text = `## Queue detail bundle\n\n`;
  text += `**Topic:** \`${b.topic}\`\n\n`;
  text += `**Producers (${b.producers.length}):**\n`;
  for (const p of b.producers) {
    text += `- \`${p.file}:${p.line}\` (community: \`${p.communitySlug}\`)\n`;
  }
  text += `\n**Consumers (${b.consumers.length}):**\n`;
  for (const c of b.consumers) {
    text += `- \`${c.file}:${c.line}\` (community: \`${c.communitySlug}\`)\n`;
  }
  if (b.callingRoutes.length > 0) {
    text += `\n**Calling routes (${b.callingRoutes.length}):**\n`;
    for (const r of b.callingRoutes) {
      text += `- \`${r.method} ${r.path}\` (community: \`${r.communitySlug}\`)\n`;
    }
  }
  if (b.payloadHints.length > 0) {
    text += `\n**Payload hints (${b.payloadHints.length}) — type/interface/dataclass evidence near producer call sites:**\n`;
    for (const p of b.payloadHints) {
      text += `\n### \`${p.file}:${p.line}\`\n\n\`\`\`\n${p.snippet}\n\`\`\`\n`;
    }
  }
  if (b.failureConfig.length > 0) {
    text += `\n**Failure-handling evidence (${b.failureConfig.length}):**\n`;
    for (const f of b.failureConfig) {
      text += `- ${f.kind}: \`${f.file}:${f.line}\`\n`;
    }
  }
  return text + "\n";
}

function renderEndpointGroupBundle(
  b: import("../wiki/types").EndpointGroupBundle,
): string {
  let text = `## Endpoint group bundle\n\n`;
  text += `**Group:** \`${b.groupSlug}\` — prefix \`${b.pathPrefix}\`\n\n`;
  text += `**Routes (${b.routes.length}):**\n`;
  for (const r of b.routes) {
    const handler = r.handlerSymbol ? ` → \`${r.handlerSymbol}\`` : "";
    text += `- \`${r.method} ${r.path}\`${handler} — \`${r.file}:${r.line}\` (community: \`${r.communitySlug}\`)\n`;
  }
  if (b.middleware.length > 0) {
    text += `\n**Middleware (${b.middleware.length}):**\n`;
    for (const m of b.middleware) {
      text += `- \`${m.name}\` — \`${m.file}:${m.line}\`\n`;
    }
  }
  if (b.dataStoresTouched.length > 0) {
    text += `\n**Data stores touched (${b.dataStoresTouched.length}):**\n`;
    for (const d of b.dataStoresTouched) {
      const model = d.model ? ` \`${d.model}\`` : "";
      text += `- ${d.store}${model}\n`;
    }
  }
  if (b.owningCommunities.length > 0) {
    text += `\n**Owning communities:** ${b.owningCommunities.map((c) => `\`${c}\``).join(", ")}\n`;
  }
  return text + "\n";
}

function renderDataFlowBundle(
  b: import("../wiki/types").DataFlowBundle,
): string {
  let text = `## Data flow bundle\n\n`;
  text += `**Flow:** ${b.name} — \`${b.slug}\`\n`;
  text += `**Trigger:** \`${b.trigger.kind}\` ${b.trigger.ref}\n`;
  text += `**Purpose:** ${b.purpose}\n\n`;
  if (b.memberCommunities.length > 0) {
    text += `**Member communities:** ${b.memberCommunities.map((c) => `\`${c}\``).join(" → ")}\n\n`;
  }
  if (b.callChain.length > 0) {
    text += `**Call chain (${b.callChain.length} hops):**\n`;
    for (const c of b.callChain) {
      const calls = c.calls.length > 0 ? ` → ${c.calls.map((s) => `\`${s}\``).join(", ")}` : "";
      text += `- depth ${c.depth}: \`${c.symbol}\` (\`${c.file}:${c.line}\`)${calls}\n`;
    }
  }
  if (b.annotations.length > 0) {
    text += `\n**Annotations (${b.annotations.length}):**\n`;
    for (const a of b.annotations) {
      text += `- \`${a.file}:${a.line}\` — ${a.note}\n`;
    }
  }
  return text + "\n";
}

// ── Resume / incremental ──

function buildResumeResponse(wikiDir: string, projectDir: string): string {
  const manifest = readJSON<PageManifest>(p(wikiDir, MANIFEST_FILE));
  if (!manifest) {
    return "No manifest on disk. Call `generate_wiki()` first.";
  }
  const pages = Object.entries(manifest.pages).sort(([, a], [, b]) => a.order - b.order);

  const done: string[] = [];
  const remaining: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const [wikiPath, page] = pages[i];
    if (existsSync(join(projectDir, wikiPath))) {
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
  text += `\n## Writing rules\n\nRules live at \`${WRITING_RULES_PROJECT_PATH}\`. Read the file before drafting any page; re-read when guidance looks stale.\n\n`;
  text += `## Instructions\n\n`;
  text += `For each remaining page: call \`generate_wiki(page: N)\`, write the markdown, save.\n`;
  text += `\n${WORKFLOW_TIPS}\n`;
  return text;
}

async function buildIncrementalResponse(
  ragDb: RagDB,
  projectDir: string,
  wikiDir: string,
  config: import("../config").RagConfig,
  clusterOverride?: ClusterMode,
): Promise<string> {
  const oldManifest = readJSON<PageManifest>(p(wikiDir, MANIFEST_FILE));
  if (!oldManifest) {
    return "No manifest on disk. Call `generate_wiki()` for a full planning pass first.";
  }

  const gitRoot = await findGitRoot(resolve(projectDir));
  if (!gitRoot) {
    return "Not a git repository — incremental mode requires git.";
  }
  const sinceRef = oldManifest.lastGitRef;
  const cluster: ClusterMode = clusterOverride ?? oldManifest.cluster ?? "files";

  const currentHead = await runGit(["rev-parse", "--short", "HEAD"], gitRoot);
  if (!currentHead) return "Could not read current HEAD.";

  const sinceReachable = await runGit(["rev-parse", "--verify", `${sinceRef}^{commit}`], gitRoot);
  if (!sinceReachable) {
    return `Manifest's lastGitRef \`${sinceRef}\` is not reachable (force-pushed, rebased, or shallow clone). Delete wiki/ JSON files and re-run \`generate_wiki()\`.`;
  }

  const changedFiles = await getChangedFiles(gitRoot, sinceRef);

  const status = ragDb.getStatus();
  if (status.totalFiles === 0) {
    return "The index is empty — run `index_files()` first.";
  }

  // Re-bundle against current DB state.
  const bundling = runWikiBundling(ragDb, projectDir, cluster);
  writeJSON(p(wikiDir, DISCOVERY_FILE), bundling.discovery);
  writeJSON(p(wikiDir, CLASSIFIED_FILE), bundling.classified);
  writeJSON(p(wikiDir, BUNDLES_FILE), bundling.bundles);
  writeJSON(p(wikiDir, ISOLATE_DOCS_FILE), bundling.unmatchedDocs);

  const syntheses = loadSyntheses(wikiDir);

  // Drop stale syntheses: any stored synthesis whose community id is no
  // longer in the bundles set is obsolete (member set changed → new id).
  const newIds = new Set(bundling.bundles.map((b) => b.communityId));
  const staleIds = Object.keys(syntheses.payloads).filter((id) => !newIds.has(id));
  for (const id of staleIds) {
    delete syntheses.payloads[id];
    delete syntheses.memberSets[id];
  }
  if (staleIds.length > 0) writeJSON(p(wikiDir, SYNTHESES_FILE), syntheses);

  const pending = bundling.bundles.filter((b) => !syntheses.payloads[b.communityId]);
  if (pending.length > 0) {
    let text = `# Wiki Incremental — new/changed communities\n\n`;
    text += `${changedFiles.size} file${plural(changedFiles.size)} changed since \`${sinceRef}\`. ` +
      `${pending.length} new or shifted communit${pending.length === 1 ? "y" : "ies"} need synthesis ` +
      `before the manifest can be rebuilt.\n\n`;
    if (staleIds.length > 0) {
      text += `(Dropped ${staleIds.length} obsolete synthes${staleIds.length === 1 ? "is" : "es"}.)\n\n`;
    }
    text += renderSynthesisChecklist(bundling.bundles, pending);
    return text;
  }

  // All syntheses present — build the new manifest and diff against the old.
  const incrementalFlows = readJSON<import("../wiki/types").FlowsFile>(p(wikiDir, FLOWS_FILE)) ?? undefined;
  const result = await runWikiFinalPlanning(
    ragDb,
    projectDir,
    currentHead,
    bundling.discovery,
    bundling.classified,
    bundling.bundles,
    syntheses,
    bundling.unmatchedDocs,
    config,
    cluster,
    incrementalFlows,
  );
  writeJSON(p(wikiDir, MANIFEST_FILE), result.manifest);
  writeJSON(p(wikiDir, CONTENT_FILE), result.content);

  const topHubPaths = new Set(result.classified.files.filter((f) => f.isTopHub).map((f) => f.path));
  const entryPoints = new Set(
    result.discovery.graphData.fileLevel.nodes.filter((n) => n.isEntryPoint).map((n) => n.path),
  );

  const report = classifyStaleness(
    oldManifest,
    result.manifest,
    bundling.bundles,
    syntheses,
    topHubPaths,
    entryPoints,
    changedFiles,
  );

  const dirty = report.stale.length + report.added.length;
  const shouldFallBack = dirty > result.manifest.pageCount * 0.5;
  const commits = await getCommitsInRange(gitRoot, sinceRef, currentHead);
  if (shouldFallBack) {
    appendFallbackLog(
      wikiDir,
      sinceRef,
      currentHead,
      dirty,
      result.manifest.pageCount,
      commits.length,
    );
    captureFallbackSnapshot(projectDir, wikiDir, sinceRef, currentHead, commits, result.manifest);
    let response = buildInitResponse(result.manifest, result.content, [
      ...result.warnings,
      `Fell back to forced full regen: ${dirty}/${result.manifest.pageCount} pages dirty (>50%).`,
    ]);
    response += `\n## Update log narrative\n\n` +
      `A pre-regen snapshot was captured for this fallback. After all writers finish ` +
      `(and before \`generate_wiki(finalize: true)\`), call \`wiki_finalize_log\` to fetch ` +
      `the per-page diff prompt, run it, then \`wiki_finalize_log_apply(narrative: ...)\` ` +
      `to append the "What changed" block to \`wiki/_update-log.md\`.\n`;
    return response;
  }

  appendQueueStub(
    wikiDir,
    sinceRef,
    currentHead,
    changedFiles.size,
    report.stale.length,
    report.added.length,
    report.removed.length,
    commits.length,
  );
  // Snapshot old page content so finalize can diff against the writers'
  // output. Skip when no pages need writing — nothing to narrate.
  if (report.stale.length + report.added.length > 0) {
    captureSnapshot(projectDir, wikiDir, sinceRef, currentHead, commits, report);
  } else {
    deleteSnapshot(wikiDir);
  }
  return renderIncrementalResponse(sinceRef, currentHead, changedFiles.size, report);
}

/**
 * Persist `_pre-regen-snapshot.json` capturing the on-disk markdown of
 * every stale page (added pages get oldContent: null). Finalize loads
 * this and runs `diffPage` against the writers' new output to produce
 * the "What changed" narrative grounding.
 */
function captureSnapshot(
  projectDir: string,
  wikiDir: string,
  sinceRef: string,
  newRef: string,
  commits: { hash: string; message: string }[],
  report: StalenessReport,
): void {
  const pages: Record<string, PreRegenSnapshotPage> = {};
  for (const d of report.stale) {
    const abs = join(projectDir, d.wikiPath);
    const old = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    pages[d.wikiPath] = {
      title: d.page.title,
      kind: d.page.kind,
      depth: d.page.depth,
      triggers: d.triggers,
      oldContent: old,
    };
  }
  for (const d of report.added) {
    pages[d.wikiPath] = {
      title: d.page.title,
      kind: d.page.kind,
      depth: d.page.depth,
      triggers: d.triggers,
      oldContent: null,
    };
  }
  const snap: PreRegenSnapshot = {
    version: 1,
    sinceRef,
    newRef,
    capturedAt: new Date().toISOString(),
    commits,
    removed: report.removed.map((r) => ({ wikiPath: r.wikiPath, title: r.page.title })),
    pages,
  };
  writeSnapshot(wikiDir, snap);
}

/**
 * Snapshot every page in the manifest for the >50%-dirty fallback. The
 * staleness report is irrelevant here — the response forces the agent to
 * regenerate everything, so the snapshot must hold every page's old
 * content, not just the flagged subset. Same shape as `captureSnapshot`
 * so finalize can diff uniformly.
 */
function captureFallbackSnapshot(
  projectDir: string,
  wikiDir: string,
  sinceRef: string,
  newRef: string,
  commits: { hash: string; message: string }[],
  manifest: PageManifest,
): void {
  const pages: Record<string, PreRegenSnapshotPage> = {};
  for (const [wikiPath, page] of Object.entries(manifest.pages)) {
    const abs = join(projectDir, wikiPath);
    const old = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    pages[wikiPath] = {
      title: page.title,
      kind: page.kind,
      depth: page.depth,
      triggers: ["incremental fallback (>50% pages dirty)"],
      oldContent: old,
    };
  }
  const snap: PreRegenSnapshot = {
    version: 1,
    sinceRef,
    newRef,
    capturedAt: new Date().toISOString(),
    commits,
    removed: [],
    pages,
  };
  writeSnapshot(wikiDir, snap);
}

async function getChangedFiles(gitRoot: string, sinceRef: string): Promise<Set<string>> {
  const out = await runGit(["diff", "--name-only", sinceRef], gitRoot);
  if (out === null) return new Set();
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

/**
 * Fetch commit hash + subject for the `sinceRef..newRef` window. Used to
 * narrate the incremental update log — gives readers the "why" without
 * forcing them to `git log`. Excludes merge commits since their subjects
 * are typically uninformative ("Merge branch …"). Hashes are short form
 * to match the rest of the log.
 */
async function getCommitsInRange(
  gitRoot: string,
  sinceRef: string,
  newRef: string,
): Promise<{ hash: string; message: string }[]> {
  const out = await runGit(
    ["log", "--no-merges", "--pretty=format:%h %s", `${sinceRef}..${newRef}`],
    gitRoot,
  );
  if (!out) return [];
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(" ");
      if (sp < 0) return { hash: line, message: "" };
      return { hash: line.slice(0, sp), message: line.slice(sp + 1) };
    });
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
    text += `## Regenerate these\n\n`;
    for (const d of [...stale].sort(byOrder)) {
      text += `- page **${d.order}** — \`${d.wikiPath}\` — ${d.page.title} (${d.page.kind}, ${d.page.depth})\n`;
      text += `  trigger: ${d.triggers.join(", ")}\n`;
    }
    text += `\n`;
  }

  if (added.length > 0) {
    text += `## New pages\n\n`;
    for (const d of [...added].sort(byOrder)) {
      text += `- page **${d.order}** — \`${d.wikiPath}\` — ${d.page.title} (${d.page.kind}, ${d.page.depth})\n`;
    }
    text += `\n`;
  }

  if (removed.length > 0) {
    text += `## Delete these files\n\n`;
    for (const r of removed) text += `- \`${r.wikiPath}\`\n`;
    text += `\n`;
  }

  text += `## Writing rules\n\nRules live at \`${WRITING_RULES_PROJECT_PATH}\`. Read the file before drafting any page; re-read when guidance looks stale.\n\n`;
  text += `## Instructions\n\n`;
  const steps: string[] = [];
  if (stale.length > 0 || added.length > 0) {
    steps.push(`For each page index above: call \`generate_wiki(page: N)\` and write the markdown. Batch 3–5 in parallel.`);
  }
  if (removed.length > 0) {
    steps.push(`Delete the files under "Delete these files".`);
  }
  if (stale.length > 0 || added.length > 0) {
    steps.push(
      `Call \`wiki_finalize_log\` once every page above is written — it returns a prompt with per-page diffs (old vs new) and the commit window. ` +
      `Run that prompt yourself and pass the resulting markdown bullets to \`wiki_finalize_log_apply(narrative: ...)\`. ` +
      `This appends the "What changed in this regen" narrative to \`wiki/_update-log.md\` and clears the snapshot. ` +
      `Skipping it leaves the log stuck on the bare queue stub.`,
    );
  }
  steps.push(`Call \`generate_wiki(finalize: true)\` last for the lint sweep.`);
  steps.forEach((s, i) => { text += `${i + 1}. ${s}\n`; });
  text += `\n${WORKFLOW_TIPS}\n${INDEX_FRESHNESS_NOTE}\n`;
  return text;
}

const INDEX_FRESHNESS_NOTE =
  `> **Note:** incremental planning reads the code index, not the filesystem. ` +
  `If a change is missing, run \`index_files()\` and call \`generate_wiki(incremental: true)\` again.`;

function buildFinalizeInstructions(wikiDir: string, projectDir: string, ragDb: RagDB): string {
  const lintReport = runWikiLint(wikiDir, projectDir, ragDb);

  let text = `# Finalization\n\n`;

  if (lintReport.length > 0) {
    const totalIssues = lintReport.reduce((n, p) => n + p.warnings.length, 0);
    text += `## Automated lint — ${totalIssues} issue${plural(totalIssues)} across ${lintReport.length} page${plural(lintReport.length)}\n\n`;
    text += `Fix these before proceeding. Each entry: \`wiki-path:line\` — kind — detail.\n\n`;
    for (const { wikiPath, warnings } of lintReport) {
      text += `### \`${wikiPath}\`\n\n`;
      for (const w of warnings) {
        text += `- \`${wikiPath}:${w.line}\` — **${w.kind}** — ${w.message}\n`;
        if (w.correctedMatch) {
          text += `  - fix: replace \`${w.match}\` → \`${w.correctedMatch}\`\n`;
        }
      }
      text += `\n`;
    }
  } else {
    text += `## Automated lint — clean\n\nNo path/Mermaid issues detected. Proceed to manual review.\n\n`;
  }

  text += `## Signal-coverage validation

Spot-check 3–5 pages:

- **H1 heading** exists and matches the page title.
- **Sections match the synthesis** — no added or dropped sections.
- **No empty sections** — a heading followed immediately by another heading is a bug.
- **Links** resolve against the page's link map.
- **Mermaid blocks** use valid diagram types and no reserved words as bare node IDs.
- **Signatures** match the bundle (no paraphrasing, no fabrication).

Fix issues in place.

## Update log narrative

If a pre-regen snapshot exists (incremental flow only), call \`wiki_finalize_log\` to fetch the prompt + per-page diffs, run that prompt, and pass the result to \`wiki_finalize_log_apply\`. Skip when the tool reports no snapshot — that means this was a full init or finalize already ran.

## Generate index page

Write \`wiki/index.md\` as the landing page: one-line summary of each page grouped by kind (architecture, getting-started, then communities).

**Do NOT call \`index_files()\` on the wiki — wiki pages are generated output, not source code.**
`;
  return text;
}

interface LintedPage {
  wikiPath: string;
  warnings: PageLintWarning[];
}

/**
 * Walk every `.md` file under `wikiDir` (skipping `_*.json` artifacts) and lint
 * against the project's indexed file set. Returns only pages with ≥1 warning.
 */
function runWikiLint(wikiDir: string, projectDir: string, ragDb: RagDB): LintedPage[] {
  if (!existsSync(wikiDir)) return [];

  const { knownFilePaths, knownConstants } = buildLintContext(projectDir, ragDb);

  const pages = collectWikiPages(wikiDir);
  const out: LintedPage[] = [];
  for (const absPath of pages) {
    const markdown = safeRead(absPath);
    if (markdown === null) continue;
    const wikiRel = relative(projectDir, absPath);
    const wikiPathFromWiki = relative(wikiDir, absPath);
    const expectedConstants = expectedConstantsFor(
      wikiDir,
      wikiRel,
      knownConstants,
      wikiPathFromWiki,
    );
    const expectedMembers = expectedMembersFor(wikiDir, wikiPathFromWiki);
    const chunkRangesByPath = loadChunkRangesForCitedPaths(markdown, projectDir, ragDb);
    const warnings = lintPage(markdown, {
      knownFilePaths,
      knownConstants,
      expectedConstants,
      expectedMembers,
      chunkRangesByPath,
    });
    if (warnings.length === 0) continue;
    out.push({
      wikiPath: wikiRel,
      warnings,
    });
  }
  return out;
}

/**
 * Build the set of constants a wiki page is expected to cite. Resolves the
 * page through the persisted manifest to a set of member files, then selects
 * the constants declared in those files from the project-wide constant
 * index. Returns an empty list for aggregate pages (no memberFiles) and for
 * community pages in repos where manifest hasn't been written yet.
 *
 * Manifest page keys are `wikiDir`-relative (e.g. `communities/db-layer.md`),
 * which is what `wikiPathFromWiki` supplies. `wikiProjectRel` is included
 * for symmetry with callers that already hold the project-relative form.
 */
function expectedConstantsFor(
  wikiDir: string,
  _wikiProjectRel: string,
  knownConstants: Map<string, { name: string; value: string; file: string }>,
  wikiPathFromWiki: string,
): { name: string; value: string; file: string }[] {
  const manifest = readJSON<PageManifest>(p(wikiDir, MANIFEST_FILE));
  if (!manifest) return [];

  const page = manifest.pages[wikiPathFromWiki];
  if (!page || !page.communityId || page.memberFiles.length === 0) return [];

  const memberSet = new Set(page.memberFiles);
  const out: { name: string; value: string; file: string }[] = [];
  for (const c of knownConstants.values()) {
    if (memberSet.has(c.file)) out.push(c);
  }
  return out;
}

/**
 * Resolve the wiki page through the persisted manifest to its
 * `memberFiles` list. Feeds the `member-uncited` lint: every member file
 * must appear at least once as a backticked citation on the page. Empty
 * for aggregate pages (no memberFiles) and for repos without a manifest
 * yet on disk.
 */
function expectedMembersFor(
  wikiDir: string,
  wikiPathFromWiki: string,
): string[] {
  const manifest = readJSON<PageManifest>(p(wikiDir, MANIFEST_FILE));
  if (!manifest) return [];
  const page = manifest.pages[wikiPathFromWiki];
  if (!page || page.memberFiles.length === 0) return [];
  return [...page.memberFiles];
}

/**
 * Build the common lint context (known paths, file symbols, known constants)
 * from the index. Shared by the per-page lint tool and the full finalize
 * sweep so both run against identical inputs. Paths in the DB are absolute;
 * everything is rekeyed to project-relative form here so the lint matches
 * the backticked paths writers emit in prose.
 */
function buildLintContext(projectDir: string, ragDb: RagDB): {
  knownFilePaths: Set<string>;
  knownConstants: Map<string, { name: string; value: string; file: string }>;
} {
  const knownFilePaths = new Set<string>();
  for (const f of ragDb.getAllFilePaths()) {
    knownFilePaths.add(relative(projectDir, f.path));
  }
  const rawConstants = ragDb.getProjectConstants();
  const knownConstants = new Map<string, { name: string; value: string; file: string }>();
  for (const [name, entry] of rawConstants) {
    knownConstants.set(name, { ...entry, file: relative(projectDir, entry.file) });
  }
  return { knownFilePaths, knownConstants };
}

/**
 * Pattern used by `loadChunkRangesForCitedPaths` to find `path:N-M`
 * citations in a markdown body. Mirrors (but does not share) the regex
 * inside `lint-page.ts`; duplicated deliberately so the wiki-tools helper
 * stays self-contained.
 */
const CITED_RANGE_RE = /\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}):\d+(?:-\d+)?\b/g;

/**
 * Scan markdown for every distinct `path:L1-L2` citation, then load the
 * tree-sitter chunk ranges for each cited path via the symbol DB. Returns
 * a map keyed by project-relative path, ready for
 * `lintPage({ chunkRangesByPath: … })`.
 *
 * Lazy-loads per path (not for every indexed file) so a lint run on one
 * page stays cheap even on large projects. Paths absent from the DB are
 * silently skipped — `lintPathRefs` already emits `missing-file` for them
 * so there's no gap in coverage.
 */
function loadChunkRangesForCitedPaths(
  markdown: string,
  projectDir: string,
  ragDb: RagDB,
): Map<string, ChunkRange[]> {
  const out = new Map<string, ChunkRange[]>();
  const seen = new Set<string>();
  for (const m of markdown.matchAll(CITED_RANGE_RE)) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    const absPath = path.startsWith("/") ? path : join(projectDir, path);
    let ranges: ChunkRange[];
    try {
      ranges = ragDb.getFileChunkRanges(absPath);
    } catch {
      continue;
    }
    if (ranges.length > 0) out.set(path, ranges);
  }
  return out;
}

function collectWikiPages(wikiDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (entry.name.startsWith("_")) continue;
      out.push(full);
    }
  };
  walk(wikiDir);
  return out;
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/**
 * Build the prompt the orchestrator agent runs to write the per-regen
 * narrative. Loads the snapshot, reads each page's current on-disk
 * content, runs `diffPage`, and ships the diff bundle + commits.
 *
 * Failure modes follow the plan: missing snapshot → friendly no-op
 * stub written to the log; stale snapshot (newRef no longer matches the
 * manifest's lastGitRef) → reject with an explanation.
 */
function buildFinalizeLogResponse(projectDir: string, wikiDir: string): string {
  const snap = readSnapshot(wikiDir);
  if (!snap) {
    return `No pre-regen snapshot found at \`${snapshotPath(wikiDir)}\`. Either ` +
      `(a) no incremental regen has been queued, or (b) finalize already ran. ` +
      `Skipping narrative.`;
  }

  const manifest = readJSON<PageManifest>(p(wikiDir, MANIFEST_FILE));
  if (manifest && manifest.lastGitRef !== snap.newRef) {
    return `Snapshot is stale: snapshot.newRef=\`${snap.newRef}\` but ` +
      `manifest.lastGitRef=\`${manifest.lastGitRef}\`. Re-run ` +
      `\`generate_wiki(incremental: true)\` to capture a fresh snapshot.`;
  }

  const diffs: PageDiff[] = [];
  const missingNew: string[] = [];
  for (const [wikiPath, snapPage] of Object.entries(snap.pages)) {
    const abs = join(projectDir, wikiPath);
    const newBody = safeRead(abs);
    if (newBody === null) {
      missingNew.push(wikiPath);
      continue;
    }
    diffs.push(
      diffPage(
        wikiPath,
        {
          title: snapPage.title,
          kind: snapPage.kind,
          status: snapPage.oldContent === null ? "added" : "stale",
          triggers: snapPage.triggers,
        },
        snapPage.oldContent,
        newBody,
      ),
    );
  }

  let prompt = `# Wiki finalize-log prompt\n\n`;
  prompt += `Run: \`${snap.sinceRef}\` → \`${snap.newRef}\` (captured ${snap.capturedAt}).\n\n`;
  prompt += `## Instructions\n\n`;
  prompt += `Write the \`### What changed in this regen\` block for the wiki update log. `;
  prompt += `One bullet per page, two sentences max each.\n\n`;
  prompt += `- First sentence: what's visible on the page now (cite specific section names, counts, tunables).\n`;
  prompt += `- Second sentence: *why*, inferred from the trigger files and commit subjects.\n`;
  prompt += `- Lead with what's on the page, not the trigger files.\n`;
  prompt += `- No hedge words (basically, simply, just, really). No marketing words (powerful, robust, seamless).\n`;
  prompt += `- For pages with only structural rewrites and no new content, say so explicitly: ` +
    `"Tightened the \`X\` section without adding material."\n`;
  prompt += `- Pages flagged \`status: "added"\` had no prior version — describe what they cover, not a delta.\n`;
  if (snap.removed.length > 0) {
    prompt += `- The "Removed pages" list ships separately; do not duplicate.\n`;
  }
  prompt += `\nAfter drafting, call \`wiki_finalize_log_apply(narrative: "<your markdown>")\` to persist.\n\n`;

  if (snap.commits.length > 0) {
    prompt += `## Commits in this window\n\n`;
    const COMMIT_CAP = 30;
    for (const c of snap.commits.slice(0, COMMIT_CAP)) {
      prompt += `- \`${c.hash}\` ${c.message}\n`;
    }
    if (snap.commits.length > COMMIT_CAP) {
      prompt += `- … (+${snap.commits.length - COMMIT_CAP} more)\n`;
    }
    prompt += `\n`;
  }

  if (snap.removed.length > 0) {
    prompt += `## Removed pages (mention as a closing line, not per-bullet)\n\n`;
    for (const r of snap.removed) {
      prompt += `- \`${r.wikiPath}\` — ${r.title}\n`;
    }
    prompt += `\n`;
  }

  prompt += `## Per-page diffs (JSON)\n\n`;
  prompt += "```json\n";
  prompt += JSON.stringify(diffs, null, 2);
  prompt += "\n```\n";

  if (missingNew.length > 0) {
    prompt += `\n## Pages missing on disk\n\n`;
    prompt += `These were flagged for regen but no file exists. Note them in the narrative as "skipped — writer did not produce output":\n\n`;
    for (const m of missingNew) prompt += `- \`${m}\`\n`;
    prompt += `\n`;
  }

  return prompt;
}

/**
 * Persist the LLM-produced narrative under the queue stub for this
 * snapshot's newRef, then delete the snapshot file. Idempotency is the
 * caller's problem — if the agent calls this twice, two narratives end
 * up in the log under the same stub. Acceptable trade-off for a
 * single-user tool.
 */
function applyFinalizeLog(wikiDir: string, narrative: string): string {
  const snap = readSnapshot(wikiDir);
  if (!snap) {
    return `No pre-regen snapshot to apply against. Run \`wiki_finalize_log\` first ` +
      `or skip — there is nothing to narrate.`;
  }
  const trimmed = narrative.trim();
  if (!trimmed) {
    return `Empty narrative — refusing to write an empty "What changed" block. ` +
      `Snapshot left in place; re-run with content.`;
  }
  const result = appendNarrative(wikiDir, snap.newRef, trimmed);
  deleteSnapshot(wikiDir);
  const where = result.mode === "inserted"
    ? `inserted under queue stub for \`${snap.newRef}\``
    : `appended (no matching stub found for \`${snap.newRef}\`)`;
  return `Narrative ${where}. Snapshot deleted.`;
}
