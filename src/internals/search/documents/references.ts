import {
  extname,
  posix,
} from "node:path";
import type {
  SearchHit,
} from "../search.ts";
import {
  SourceIndex,
} from "../../storage/source-index.ts";
import {
  SEARCH_DOCUMENTS_INSPECTED,
  SEARCH_DOCUMENT_WINDOWS,
  SEARCH_DOCUMENT_REFERENCES,
  SEARCH_DOCUMENT_REFERENCES_PER_FILE,
  DOCUMENT_EXTENSION,
  EXPLICIT_PATH,
  MARKDOWN_LINK,
  QUALIFIED_SYMBOL,
} from "./config.ts";
import type {
  DocumentReferenceKind,
  ExtractedReference,
  Definition,
  PendingReference,
  ResolvedReference,
} from "./types.ts";

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}
export function isDocumentationPath(path: string): boolean {
  return DOCUMENT_EXTENSION.test(path);
}
function addReference(
  values: ExtractedReference[],
  seen: Set<string>,
  value: string,
  kind: DocumentReferenceKind,
): void {
  const cleaned = value.trim().replace(/^~+/, "").replace(/[),.;:]+$/, "");
  if (cleaned === "") return;
  const key = `${kind}:${cleaned}`;
  if (seen.has(key)) return;
  seen.add(key);
  values.push({ value: cleaned, kind });
}
/** Extract only the two reference forms that passed the three-corpus study. */
export function extractStrictDocumentReferences(
  text: string,
): ExtractedReference[] {
  const values: ExtractedReference[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(EXPLICIT_PATH)) {
    addReference(values, seen, match[1]!, "path");
  }
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const target = match[1]!.split("#", 1)[0]!;
    if (posix.basename(target).includes(".")) {
      addReference(values, seen, target, "path");
    }
  }
  for (const match of text.matchAll(QUALIFIED_SYMBOL)) {
    addReference(values, seen, match[0], "qualified-symbol");
  }
  return values;
}
export function pendingReferences(
  index: SourceIndex,
  hits: readonly SearchHit[],
  documents: readonly SearchHit[],
): PendingReference[] {
  const selectedDocuments = documents.slice(0, SEARCH_DOCUMENTS_INSPECTED);
  const selectedWindows = new Map<string, SearchHit["windows"]>();
  for (const document of selectedDocuments) {
    const primary = document.windows.find((window) =>
      window.id === document.windowId
    );
    const candidates = [
      ...(primary ? [primary] : []),
      ...document.windows.filter((window) => window.id !== document.windowId),
      ...hits.filter((hit) => hit.path === document.path)
        .flatMap((hit) => hit.windows),
    ];
    const unique = new Map<number, SearchHit["windows"][number]>();
    for (const window of candidates) {
      if (!unique.has(window.id)) unique.set(window.id, window);
    }
    const ordered = [...unique.values()].slice(0, SEARCH_DOCUMENT_WINDOWS);
    selectedWindows.set(document.path, ordered);
  }
  const selectedWindowIds = [...selectedWindows.values()]
    .flatMap((windows) => windows.map((window) => window.id));
  const fullText = new Map<number, string>();
  if (selectedWindowIds.length > 0) {
    const rows = index.database.query<{ id: number; text: string }, [string]>(
      `SELECT id, text
       FROM source_windows
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(selectedWindowIds));
    for (const row of rows) fullText.set(row.id, row.text);
  }
  const pending: PendingReference[] = [];
  for (const document of selectedDocuments) {
    let accepted = 0;
    const seen = new Set<string>();
    for (const window of selectedWindows.get(document.path) ?? []) {
      for (
        const reference of extractStrictDocumentReferences(
          fullText.get(window.id) ??
            (window.id === document.windowId ? document.preview : ""),
        )
      ) {
        const key = `${reference.kind}:${reference.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pending.push({
          document: {
            ...document,
            windowId: window.id,
            window: {
              startOffset: window.startOffset,
              endOffset: window.endOffset,
              startLine: window.startLine,
              endLine: window.endLine,
            },
          },
          documentScore: document.score,
          reference,
        });
        accepted++;
        if (
          accepted >= SEARCH_DOCUMENT_REFERENCES_PER_FILE ||
          pending.length >= SEARCH_DOCUMENT_REFERENCES
        ) break;
      }
      if (
        accepted >= SEARCH_DOCUMENT_REFERENCES_PER_FILE ||
        pending.length >= SEARCH_DOCUMENT_REFERENCES
      ) break;
    }
    if (pending.length >= SEARCH_DOCUMENT_REFERENCES) break;
  }
  return pending;
}
export function definitions(
  index: SourceIndex,
  names: readonly string[],
  projectPaths: ReadonlySet<string>,
): Map<string, Definition[]> {
  const normalized = [...new Set(names.map((name) => name.toLowerCase()))];
  if (normalized.length === 0) return new Map();
  const rows = index.database.query<Definition, [string]>(
    `SELECT f.path, c.name,
            c.start_offset AS startOffset, c.end_offset AS endOffset,
            c.start_line AS startLine, c.end_line AS endLine
     FROM source_chunks c
     JOIN files f ON f.id = c.file_id
     WHERE c.name IS NOT NULL
       AND c.name COLLATE NOCASE IN (SELECT value FROM json_each(?))
     ORDER BY c.name COLLATE NOCASE, f.path, c.start_offset, c.id`,
  ).all(JSON.stringify(normalized)).filter((row) => projectPaths.has(row.path));
  const values = new Map<string, Definition[]>();
  for (const row of rows) {
    const entries = values.get(row.name.toLowerCase()) ?? [];
    entries.push(row);
    values.set(row.name.toLowerCase(), entries);
  }
  return values;
}
export function modulePaths(projectPaths: ReadonlySet<string>): Map<string, string[]> {
  const modules = new Map<string, string[]>();
  for (const path of [...projectPaths].sort()) {
    if (isDocumentationPath(path)) continue;
    const extension = extname(path);
    const stem = extension === "" ? path : path.slice(0, -extension.length);
    const keys = new Set([stem, stem.replaceAll("/", ".")]);
    if (stem.endsWith("/index")) {
      const parent = stem.slice(0, -"/index".length);
      keys.add(parent);
      keys.add(parent.replaceAll("/", "."));
    }
    for (const key of keys) {
      const values = modules.get(key) ?? [];
      values.push(path);
      modules.set(key, values);
    }
  }
  return modules;
}
function resolvePath(
  value: string,
  documentPath: string,
  projectPaths: ReadonlySet<string>,
): string | null {
  const withoutAnchor = value.split("#", 1)[0]!;
  const candidates = [normalizePath(withoutAnchor)];
  if (withoutAnchor.startsWith("./") || withoutAnchor.startsWith("../")) {
    candidates.unshift(posix.normalize(
      posix.join(posix.dirname(documentPath), withoutAnchor),
    ));
  }
  return candidates.find((candidate) =>
    candidate !== ".." && !candidate.startsWith("../") &&
    projectPaths.has(candidate) && !isDocumentationPath(candidate)
  ) ?? null;
}
export function resolveReference(
  pending: PendingReference,
  projectPaths: ReadonlySet<string>,
  pathsByModule: ReadonlyMap<string, readonly string[]>,
  definitionsByName: ReadonlyMap<string, readonly Definition[]>,
): ResolvedReference | null {
  if (pending.reference.kind === "path") {
    const path = resolvePath(
      pending.reference.value,
      pending.document.path,
      projectPaths,
    );
    return path ? { path, definition: null } : null;
  }
  const parts = pending.reference.value.split(".");
  const symbol = parts.at(-1)!;
  const module = parts.slice(0, -1).join(".");
  const paths = pathsByModule.get(module) ?? [];
  const candidates = definitionsByName.get(symbol.toLowerCase()) ?? [];
  if (paths.length === 1) {
    const matching = candidates.filter((definition) =>
      definition.path === paths[0]
    );
    return matching.length > 0
      ? { path: paths[0]!, definition: matching[0]! }
      : { path: paths[0]!, definition: null };
  }
  const uniquePaths = new Set(candidates.map((definition) => definition.path));
  if (uniquePaths.size !== 1) return null;
  const definition = candidates[0]!;
  const stem = definition.path.slice(0, -extname(definition.path).length)
    .replaceAll("/", ".");
  return module.endsWith(stem)
    ? { path: definition.path, definition }
    : null;
}
