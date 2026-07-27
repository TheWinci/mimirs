import type { ProjectSearchResponse } from
  "../../internals/search/project-search.ts";
import type { SearchHit, SearchResponse } from "../../internals/search/search.ts";

function lines(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

function renderHit(hit: SearchHit): string {
  const name = hit.sourceChunk.name
    ? ` ${hit.sourceChunk.name.replace(/\s+/g, " ").trim()}`
    : "";
  const mergedChunks = hit.sourceChunks.length > 1
    ? `matched chunks ${hit.sourceChunks.map((chunk) =>
      lines(chunk.startLine, chunk.endLine)
    ).join(", ")}`
    : null;
  const mergedWindows = hit.windows.length > 1
    ? `matched windows ${hit.windows.map((window) =>
      lines(window.startLine, window.endLine)
    ).join(", ")}`
    : null;
  return [
    `${hit.path}:${lines(hit.window.startLine, hit.window.endLine)}  ` +
      `${hit.sourceChunk.kind}${name}  score ${hit.score.toFixed(4)} ` +
      `(semantic ${hit.semanticScore.toFixed(4)}, ` +
      `lexical ${hit.lexicalScore.toFixed(4)})`,
    `parent ${lines(hit.sourceChunk.startLine, hit.sourceChunk.endLine)}; ` +
      `window offsets [${hit.window.startOffset},${hit.window.endOffset}); ` +
      `parent offsets [${hit.sourceChunk.startOffset},${hit.sourceChunk.endOffset})`,
    mergedWindows,
    mergedChunks,
    hit.preview,
  ].filter((line): line is string => line !== null).join("\n");
}

export function renderSearchResults(results: readonly SearchHit[]): string {
  if (results.length === 0) return "No indexed source matched the query.";
  return results.map(renderHit).join("\n\n---\n\n");
}

function renderRelations(response: SearchResponse): string | null {
  if (response.relations.length === 0) return null;
  return response.relations.map((relation) => {
    const document = `${relation.documentPath}:` +
      lines(relation.documentRange.startLine, relation.documentRange.endLine);
    const source = relation.sourceRange
      ? `${relation.sourcePath}:` +
        lines(relation.sourceRange.startLine, relation.sourceRange.endLine)
      : relation.sourcePath;
    return `${document} -> ${source}  ${relation.kind} ` +
      `${relation.reference}  inherited ${relation.inheritedScore.toFixed(4)}`;
  }).join("\n");
}

/** Human projection of the segmented search response used by the CLI. */
export function renderSegmentedSearchResults(response: SearchResponse): string {
  const sections: string[] = [];
  if (response.source.length > 0) {
    sections.push(`Source\n\n${renderSearchResults(response.source)}`);
  }
  if (response.docs.length > 0) {
    sections.push(`Documentation\n\n${renderSearchResults(response.docs)}`);
  }
  const relations = renderRelations(response);
  if (relations) sections.push(`References\n\n${relations}`);
  return sections.join("\n\n===\n\n") ||
    "No indexed source or documentation matched the query.";
}

export function searchWarnings(response: ProjectSearchResponse): string[] {
  const warnings = response.preparation.index.failed.map((failure) =>
    `could not index ${failure.path}: ${failure.message}`
  );
  const diagnostics = response.diagnostics;
  for (const [count, label] of [
    [diagnostics.missingEmbedding, "missing embeddings"],
    [diagnostics.incompleteEmbedding, "incomplete embedding metadata"],
    [diagnostics.incompatibleEmbedding, "incompatible embeddings"],
    [diagnostics.malformedEmbedding, "malformed embeddings"],
    [diagnostics.orphaned, "orphaned windows"],
    [diagnostics.unscorableCandidates, "unscorable vectors"],
  ] as const) {
    if (count > 0) warnings.push(`${count} ${label} omitted from search`);
  }
  return warnings;
}
