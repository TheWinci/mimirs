

import type {
  SearchHit,
  SearchSourceChunk,
} from "./search.ts";
import {
  sourceTextPreview,
} from "../source/windows.ts";
import {
  SourceIndex,
} from "../storage/source-index.ts";
import {
  SEARCH_DOCUMENT_LIMIT,
  SEARCH_DOCUMENTS_INSPECTED,
  SEARCH_DOCUMENT_WINDOWS,
  SEARCH_DOCUMENT_REFERENCES,
  SEARCH_DOCUMENT_REFERENCES_PER_FILE,
  SEARCH_DOCUMENT_INHERITED_SCORE,
} from "./documents/config.ts";
import type {
  DocumentReferenceKind,
  DocumentSearchRelation,
  SegmentedSearchResults,
  CitedSourceWindow,
} from "./documents/types.ts";
import {
  isDocumentationPath,
  pendingReferences,
  definitions,
  modulePaths,
  resolveReference,
} from "./documents/references.ts";
import {
  overlaps,
  citedWindows,
} from "./documents/citations.ts";
export {
  isDocumentationPath,
  extractStrictDocumentReferences,
} from "./documents/references.ts";
export type {
  DocumentReferenceKind,
  DocumentSearchRelation,
  SegmentedSearchResults,
} from "./documents/types.ts";
export {
  SEARCH_DOCUMENT_LIMIT,
  SEARCH_DOCUMENTS_INSPECTED,
  SEARCH_DOCUMENT_WINDOWS,
  SEARCH_DOCUMENT_REFERENCES,
  SEARCH_DOCUMENT_REFERENCES_PER_FILE,
  SEARCH_DOCUMENT_INHERITED_SCORE,
} from "./documents/config.ts";

function bestDocumentHits(hits: readonly SearchHit[]): SearchHit[] {
  const files = new Map<string, SearchHit>();
  for (const hit of hits) {
    if (isDocumentationPath(hit.path) && !files.has(hit.path)) {
      files.set(hit.path, hit);
    }
  }
  return [...files.values()];
}

function inheritedHit(
  window: CitedSourceWindow,
  score: number,
  previewCharacters: number,
): SearchHit {
  return {
    windowId: window.id,
    path: window.path,
    score,
    semanticScore: 0,
    lexicalScore: 0,
    preview: sourceTextPreview(window.text, previewCharacters),
    windows: [{
      id: window.id,
      startOffset: window.startOffset,
      endOffset: window.endOffset,
      startLine: window.startLine,
      endLine: window.endLine,
    }],
    window: {
      startOffset: window.startOffset,
      endOffset: window.endOffset,
      startLine: window.startLine,
      endLine: window.endLine,
    },
    sourceChunks: [window.sourceChunk],
    sourceChunk: window.sourceChunk,
  };
}

function mergeFileHits(left: SearchHit, right: SearchHit): SearchHit {
  const best = compareHits(left, right) <= 0 ? left : right;
  const windows = new Map<number, SearchHit["windows"][number]>();
  const chunks = new Map<number, SearchSourceChunk>();
  for (const hit of [left, right]) {
    for (const window of hit.windows) windows.set(window.id, window);
    for (const chunk of hit.sourceChunks) chunks.set(chunk.id, chunk);
  }
  return {
    ...best,
    windows: [...windows.values()].sort((first, second) =>
      first.startOffset - second.startOffset ||
      first.endOffset - second.endOffset ||
      first.id - second.id
    ),
    sourceChunks: [...chunks.values()].sort((first, second) =>
      first.startOffset - second.startOffset ||
      first.endOffset - second.endOffset ||
      first.id - second.id
    ),
  };
}

function compareHits(left: SearchHit, right: SearchHit): number {
  return right.score - left.score ||
    right.semanticScore - left.semanticScore ||
    left.path.localeCompare(right.path) ||
    left.window.startOffset - right.window.startOffset ||
    left.windowId - right.windowId;
}

/** Split retrieval and expand source citations through strict doc references. */
export function segmentSearchResults(
  index: SourceIndex,
  hits: readonly SearchHit[],
  projectPaths: ReadonlySet<string>,
  sourceLimit: number,
  previewCharacters: number,
): SegmentedSearchResults {
  const projectHits = hits.filter((hit) => projectPaths.has(hit.path));
  const documents = bestDocumentHits(projectHits);
  const pending = pendingReferences(index, projectHits, documents);
  const qualifiedNames = pending.flatMap(({ reference }) =>
    reference.kind === "qualified-symbol"
      ? [reference.value.split(".").at(-1)!]
      : []
  );
  const definitionsByName = definitions(index, qualifiedNames, projectPaths);
  const pathsByModule = modulePaths(projectPaths);
  const resolved = pending.flatMap((value) => {
    const reference = resolveReference(
      value,
      projectPaths,
      pathsByModule,
      definitionsByName,
    );
    return reference ? [{ value, reference }] : [];
  });
  const windowsByPath = citedWindows(
    index,
    resolved.map(({ reference }) => reference.path),
  );
  const source = new Map<string, SearchHit>();
  for (const hit of projectHits) {
    if (isDocumentationPath(hit.path)) continue;
    const existing = source.get(hit.path);
    source.set(hit.path, existing ? mergeFileHits(existing, hit) : hit);
  }
  const relations: DocumentSearchRelation[] = [];
  const relationKeys = new Set<string>();
  for (const { value, reference } of resolved) {
    const key = `${value.document.path}:${reference.path}:` +
      `${reference.definition?.name ?? ""}`;
    if (relationKeys.has(key)) continue;
    const windows = windowsByPath.get(reference.path) ?? [];
    const window = (reference.definition
      ? windows.find((candidate) => overlaps(candidate, reference.definition!))
      : windows[0]) ?? windows[0] ?? null;
    if (!window) continue;
    relationKeys.add(key);
    const inheritedScore = value.documentScore *
      SEARCH_DOCUMENT_INHERITED_SCORE;
    const inherited = inheritedHit(window, inheritedScore, previewCharacters);
    const existing = source.get(window.path);
    if (!existing) {
      source.set(window.path, inherited);
    } else {
      source.set(window.path, mergeFileHits(existing, inherited));
    }
    relations.push({
      documentWindowId: value.document.windowId,
      documentPath: value.document.path,
      documentRange: value.document.window,
      sourceWindowId: window.id,
      sourcePath: reference.path,
      sourceRange: reference.definition
        ? {
            startOffset: reference.definition.startOffset,
            endOffset: reference.definition.endOffset,
            startLine: reference.definition.startLine,
            endLine: reference.definition.endLine,
          }
        : null,
      reference: value.reference.value,
      symbol: reference.definition?.name ?? null,
      kind: value.reference.kind,
      inheritedScore,
    });
    if (relations.length >= SEARCH_DOCUMENT_REFERENCES) break;
  }
  const rankedSource = [...source.values()].sort(compareHits).slice(0, sourceLimit);
  const returnedPaths = new Set(rankedSource.map((hit) => hit.path));
  return {
    source: rankedSource,
    docs: documents.slice(0, SEARCH_DOCUMENT_LIMIT),
    relations: relations.filter((relation) =>
      returnedPaths.has(relation.sourcePath)
    ),
  };
}
