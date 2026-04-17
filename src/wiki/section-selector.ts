import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { PageContentCache, PageKind, PageFocus } from "./types";

const SECTIONS_DIR = join(import.meta.dir, "sections");
const EXEMPLARS_DIR = join(import.meta.dir, "exemplars");

export interface CandidateSection {
  /** Stable section identifier (matches the filename without extension). */
  name: string;
  /** Why this section was matched or filtered out. */
  reason: string;
  /** Whether the section's predicate fires for this page's prefetched data. */
  matched: boolean;
  /** The example markdown body (front-matter stripped), read lazily. */
  exampleBody: string;
}

interface SectionDef {
  name: string;
  /** Whether this section is eligible given the page's kind/focus at all. */
  eligibleFor: (kind: PageKind, focus: PageFocus | undefined) => boolean;
  /** Whether the prefetched data supports including this section. */
  applies: (p: PageContentCache, ctx: SelectionContext) => boolean;
  /** Short reason string to attach when matched/skipped. */
  rationale: (p: PageContentCache, ctx: SelectionContext, matched: boolean) => string;
}

export interface SelectionContext {
  relatedPagesCount: number;
  linkMapSize: number;
}

const AGGREGATE_FOCI_WITH_EXEMPLAR = new Set<PageFocus>([
  "architecture",
  "data-flows",
  "getting-started",
  "conventions",
  "testing",
  "index",
]);

const SECTION_DEFS: SectionDef[] = [
  {
    name: "overview",
    eligibleFor: () => true,
    applies: () => true,
    rationale: () => "lead paragraph — always included",
  },
  {
    name: "public-api",
    eligibleFor: (k) => k === "module" || k === "file",
    applies: (p) => (p.exports?.length ?? 0) >= 1,
    rationale: (p, _c, m) => (m ? `${p.exports?.length ?? 0} exports with signatures` : "no exports in prefetch"),
  },
  {
    name: "how-it-works-sequence",
    eligibleFor: (k, f) => k === "module" || f === "data-flows",
    applies: (p) => (p.files?.length ?? 0) >= 2 || (p.entryPoints?.length ?? 0) >= 1,
    rationale: (_p, _c, m) => (m ? "module has multiple files — REQUIRED: include a sequenceDiagram" : "no clear multi-file flow"),
  },
  {
    name: "dependency-graph",
    eligibleFor: (k) => k === "module" || k === "file",
    applies: (p) => (p.dependencies?.length ?? 0) + (p.dependents?.length ?? 0) >= 3,
    rationale: (p, _c, m) => {
      const total = (p.dependencies?.length ?? 0) + (p.dependents?.length ?? 0);
      return m ? `${total} total edges worth visualising` : `only ${total} edges — prefer dependency-table`;
    },
  },
  {
    name: "dependency-table",
    eligibleFor: (k) => k === "module" || k === "file",
    applies: (p) => {
      const total = (p.dependencies?.length ?? 0) + (p.dependents?.length ?? 0);
      return total >= 1 && total < 3;
    },
    rationale: (p, _c, m) => {
      const total = (p.dependencies?.length ?? 0) + (p.dependents?.length ?? 0);
      return m ? `${total} edges — compact table fits` : total === 0 ? "no edges" : "≥3 edges — prefer dependency-graph";
    },
  },
  {
    name: "hub-analysis",
    eligibleFor: (_k, f) => f === "architecture" || f === undefined || f === "module-file",
    applies: (p) => (p.hubs?.length ?? 0) >= 1,
    rationale: (p, _c, m) => (m ? `${p.hubs?.length ?? 0} hub files available` : "no hub data"),
  },
  {
    name: "cross-cutting-inventory",
    eligibleFor: (_k, f) => f === "architecture" || f === "data-flows" || f === undefined,
    applies: (p) => (p.crossCuttingSymbols?.length ?? 0) >= 1,
    rationale: (p, _c, m) => (m ? `${p.crossCuttingSymbols?.length ?? 0} cross-cutting symbols` : "no cross-cutting symbols"),
  },
  {
    name: "entry-points",
    eligibleFor: (_k, f) => f === "architecture" || f === "getting-started",
    applies: (p) => (p.entryPoints?.length ?? 0) >= 1,
    rationale: (p, _c, m) => (m ? `${p.entryPoints?.length ?? 0} entry points (filter noisy ones manually)` : "no entry points"),
  },
  {
    name: "per-file-breakdown",
    eligibleFor: (k) => k === "module",
    applies: (p) => (p.files?.length ?? 0) >= 3 && (p.exports?.length ?? 0) >= 5,
    rationale: (p, _c, m) => {
      const files = p.files?.length ?? 0;
      const exps = p.exports?.length ?? 0;
      return m ? `${files} files × ${exps} exports — per-file sections justified` : `only ${files} files / ${exps} exports — prefer key-exports-table`;
    },
  },
  {
    name: "key-exports-table",
    eligibleFor: (k) => k === "module" || k === "file",
    applies: (p) => {
      const exps = p.exports?.length ?? 0;
      const files = p.files?.length ?? 0;
      return exps >= 3 && !(files >= 3 && exps >= 5);
    },
    rationale: (p, _c, m) => (m ? `${p.exports?.length ?? 0} exports — terse table suffices` : "per-file-breakdown applies instead"),
  },
  {
    name: "usage-examples",
    eligibleFor: (k) => k === "module" || k === "file",
    applies: (p) => (p.usageSites?.length ?? 0) >= 1,
    rationale: (p, _c, m) => (m ? `${p.usageSites?.length ?? 0} usage sites` : "no usage sites"),
  },
  {
    name: "internals",
    eligibleFor: (k) => k === "module",
    applies: (p) => (p.files?.length ?? 0) >= 10 || (p.exports?.length ?? 0) >= 15,
    rationale: (p, _c, m) => {
      const files = p.files?.length ?? 0;
      const exps = p.exports?.length ?? 0;
      return m ? `large module (${files} files, ${exps} exports) — internals worth naming` : "not large enough";
    },
  },
  {
    name: "configuration",
    eligibleFor: (_k, f) => f === "getting-started" || f === undefined,
    applies: (_p, _c) => true,
    rationale: (_p, _c, m) => (m ? "include when config/env/CLI flags exist in source" : ""),
  },
  {
    name: "known-issues",
    eligibleFor: (_k, f) => f === "getting-started" || f === undefined,
    applies: () => true,
    rationale: () => "include only when the code has genuine known issues",
  },
  {
    name: "module-inventory",
    eligibleFor: (_k, f) => f === "architecture" || f === "getting-started" || f === "index",
    applies: (p) => (p.modules?.length ?? 0) >= 1,
    rationale: (p, _c, m) => (m ? `${p.modules?.length ?? 0} modules inventoried` : "no module data"),
  },
  {
    name: "test-structure",
    eligibleFor: (_k, f) => f === "testing",
    applies: (p) => (p.testFiles?.length ?? 0) >= 1,
    rationale: (p, _c, m) => (m ? `${p.testFiles?.length ?? 0} test files` : "no test files"),
  },
  {
    name: "see-also",
    eligibleFor: () => true,
    applies: (_p, ctx) => ctx.relatedPagesCount >= 1 || ctx.linkMapSize >= 1,
    rationale: (_p, _c, m) => (m ? "link map has targets" : "no related pages or links"),
  },
];

const bodyCache = new Map<string, string>();

function loadSectionBody(name: string): string {
  const cached = bodyCache.get(name);
  if (cached !== undefined) return cached;
  const path = join(SECTIONS_DIR, `${name}.md`);
  if (!existsSync(path)) {
    bodyCache.set(name, "");
    return "";
  }
  const raw = readFileSync(path, "utf-8");
  const body = stripFrontMatter(raw);
  bodyCache.set(name, body);
  return body;
}

function stripFrontMatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return raw;
  const afterClose = raw.indexOf("\n", end + 4);
  return afterClose >= 0 ? raw.slice(afterClose + 1) : "";
}

/**
 * Select candidate sections for a page. Sections for which the predicate
 * fires are `matched: true`; ineligible sections are dropped entirely.
 * Sections eligible-but-skipped (predicate false) are returned with
 * matched: false and a reason, so agents see the shape and know why.
 */
export function selectSections(
  kind: PageKind,
  focus: PageFocus | undefined,
  prefetched: PageContentCache,
  ctx: SelectionContext,
): CandidateSection[] {
  const out: CandidateSection[] = [];
  for (const def of SECTION_DEFS) {
    if (!def.eligibleFor(kind, focus)) continue;
    const matched = def.applies(prefetched, ctx);
    out.push({
      name: def.name,
      reason: def.rationale(prefetched, ctx, matched),
      matched,
      exampleBody: loadSectionBody(def.name),
    });
  }
  return out;
}

/** Return the absolute path to an aggregate-focus exemplar, or undefined. */
export function exemplarPathFor(kind: PageKind, focus: PageFocus | undefined): string | undefined {
  if (kind !== "aggregate" || !focus) return undefined;
  if (!AGGREGATE_FOCI_WITH_EXEMPLAR.has(focus)) return undefined;
  const path = join(EXEMPLARS_DIR, `${focus}.md`);
  return existsSync(path) ? path : undefined;
}
