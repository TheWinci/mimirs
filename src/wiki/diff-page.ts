import type { PageDiff } from "./types";

/**
 * Pure structural diff between two markdown bodies. No LLM. Output is
 * passed to the narrative LLM as grounding so it leads with what changed
 * on the page rather than which trigger files fired.
 *
 * Returns null only if both sides are missing — caller should treat that
 * as "no diff to narrate".
 */
export function diffPage(
  wikiPath: string,
  meta: { title: string; kind: string; status: "stale" | "added"; triggers: string[] },
  oldBody: string | null,
  newBody: string,
): PageDiff {
  const oldSections = parseSections(oldBody ?? "");
  const newSections = parseSections(newBody);

  const oldHeads = new Set(oldSections.map((s) => s.heading));
  const newHeads = new Set(newSections.map((s) => s.heading));

  const sectionsAdded = [...newHeads].filter((h) => !oldHeads.has(h));
  const sectionsRemoved = [...oldHeads].filter((h) => !newHeads.has(h));

  const sectionsRewritten: string[] = [];
  for (const ns of newSections) {
    const os = oldSections.find((o) => o.heading === ns.heading);
    if (!os) continue;
    const oldBytes = byteLen(os.body);
    const newBytes = byteLen(ns.body);
    if (oldBytes === 0 && newBytes === 0) continue;
    const oldParas = countParagraphs(os.body);
    const newParas = countParagraphs(ns.body);
    const byteDelta = Math.abs(newBytes - oldBytes) / Math.max(oldBytes, 1);
    const paraDelta = Math.abs(newParas - oldParas) / Math.max(oldParas, 1);
    if (byteDelta >= 0.3 || paraDelta >= 0.5) sectionsRewritten.push(ns.heading);
  }

  const oldCites = new Set(extractCitations(oldBody ?? ""));
  const newCites = new Set(extractCitations(newBody));
  const citationsAdded = [...newCites].filter((c) => !oldCites.has(c));
  const citationsRemoved = [...oldCites].filter((c) => !newCites.has(c));

  const oldMermaid = extractMermaid(oldBody ?? "");
  const newMermaid = extractMermaid(newBody);

  const oldLits = new Set(extractNumericLiterals(oldBody ?? ""));
  const newLits = new Set(extractNumericLiterals(newBody));
  const numericLiteralsAdded = [...newLits].filter((l) => !oldLits.has(l));
  const numericLiteralsRemoved = [...oldLits].filter((l) => !newLits.has(l));

  return {
    wikiPath,
    title: meta.title,
    kind: meta.kind,
    status: meta.status,
    triggers: meta.triggers,
    sectionsAdded,
    sectionsRemoved,
    sectionsRewritten,
    citationsAdded,
    citationsRemoved,
    mermaidDelta: {
      oldCount: oldMermaid.length,
      newCount: newMermaid.length,
      oldTypes: dedupe(oldMermaid),
      newTypes: dedupe(newMermaid),
    },
    numericLiteralsAdded,
    numericLiteralsRemoved,
    byteDelta: byteLen(newBody) - byteLen(oldBody ?? ""),
  };
}

interface Section {
  heading: string;
  body: string;
}

/**
 * Parse H2/H3 sections. Headings inside fenced code blocks are ignored —
 * a `### foo` line in a bash example is not a section break. The "preamble"
 * (text before any heading) is dropped; the diff cares about named sections.
 */
function parseSections(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let current: Section | null = null;
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) inFence = !inFence;
    if (!inFence) {
      const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
      if (m) {
        if (current) sections.push(current);
        current = { heading: m[2].trim(), body: "" };
        continue;
      }
    }
    if (current) current.body += line + "\n";
  }
  if (current) sections.push(current);
  return sections;
}

function countParagraphs(body: string): number {
  return body.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

/**
 * Pull backticked path-shaped tokens — anything containing a `/` or a file
 * extension. Filters out plain identifiers so we don't drown in `foo()`
 * matches; the diff cares about *file references*.
 */
function extractCitations(body: string): string[] {
  const out: string[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const tok = m[1];
    if (tok.includes("/") || /\.[a-z0-9]{1,5}$/i.test(tok)) {
      if (!/\s/.test(tok)) out.push(tok);
    }
  }
  return out;
}

/**
 * For each ```mermaid block, extract the diagram type (first significant
 * keyword: sequenceDiagram, flowchart, graph, stateDiagram-v2, etc.).
 * Used to surface "added a sequence diagram" in the narrative.
 */
function extractMermaid(body: string): string[] {
  const out: string[] = [];
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const inner = m[1].trim();
    const firstLine = inner.split("\n")[0]?.trim() ?? "";
    const kind = firstLine.split(/\s+/)[0] ?? "unknown";
    out.push(kind || "unknown");
  }
  return out;
}

/**
 * Capture `NAME = literal` patterns inside backticks — surfaces tunable
 * value changes that readers tuning behavior want to spot in the log
 * ("DEFAULT_HYBRID_WEIGHT = 0.5 → 0.7"). Returns the full token so set-diff
 * works on the (name, value) pair.
 */
function extractNumericLiterals(body: string): string[] {
  const out: string[] = [];
  const re = /`([A-Z][A-Z0-9_]+\s*=\s*[^`]+?)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1].replace(/\s+/g, " ").trim());
  return out;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
