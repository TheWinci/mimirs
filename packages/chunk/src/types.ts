/** Supported languages */
export type Language =
  | "typescript" | "javascript" | "python" | "rust" | "go" | "java"
  | "c" | "cpp" | "csharp" | "ruby" | "php" | "scala"
  | "html" | "css"
  | "kotlin" | "lua" | "zig" | "elixir"
  | "bash" | "toml" | "yaml" | "haskell" | "ocaml"
  | "dart";

/** How a file was chunked. */
export type SourceChunkStrategy = "ast" | "markdown" | "paragraph" | "binary";

/** What a chunk is. Every chunk is either a named semantic entity or an
 *  explicitly-typed non-entity chunk (`gap`, `block`, `comment`, `conditional`,
 *  `directive`, `initializer`, `paragraph`, `section`) — never an anonymous mystery
 *  (INV-C4). `gap` is whitespace-only; `block` is meaningful source without a
 *  more specific semantic kind. */
export type SourceChunkKind =
  | "function" | "method" | "class" | "interface" | "type" | "enum"
  | "struct" | "trait" | "impl" | "module" | "macro" | "record" | "annotation_type"
  | "given"
  | "initializer"
  | "import" | "export" | "package" | "variable" | "constant" | "field"
  | "property" | "event" | "delegate" | "element" | "selector" | "rule" | "block"
  | "section" | "paragraph" | "comment" | "conditional" | "directive" | "gap";

/**
 * A source chunk. Source chunks form a tree (decision 01-D1): a chunk with
 * `children` is a parent whose children — entity chunks plus
 * `gap`/`block`/`comment` filler — partition its span exactly. Leaves (empty
 * `children`) partition
 * the whole file (INV-C2). There are no size limits of any kind (INV-C3).
 *
 * `text` is carried by LEAVES ONLY, and is a verbatim slice of the
 * normalized source (INV-C1): `text === source.slice(startOffset,
 * endOffset)`. Parents don't materialize text — that would duplicate every
 * byte once per nesting level; a parent's text is derivable from its span
 * (`source.slice(...)`) or by gluing its leaves (see `textOf`).
 */
export interface SourceChunk {
  kind: SourceChunkKind;
  /** Entity name when the chunk is a named entity, else null. */
  name: string | null;
  /** Verbatim slice of the normalized source — present on leaves only. */
  text?: string;
  /** Char-offset span into the normalized source: [startOffset, endOffset). */
  startOffset: number;
  endOffset: number;
  /** 1-indexed inclusive line span. */
  startLine: number;
  endLine: number;
  children: SourceChunk[];
}

export interface SourceSpan {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

/** Stable description of the source chunk that owns an observed fact. */
export interface SourceChunkRef extends SourceSpan {
  kind: SourceChunkKind;
  name: string;
}

interface SourceFactBase extends SourceSpan {
  /** Owning named chunk, or null for module-level observations. */
  owner: SourceChunkRef | null;
}

export interface ImportFact extends SourceFactBase {
  kind: "import";
  source: string;
  /** Source-side name: `default`, `*`, or a named export. */
  imported: string | null;
  /** Binding used in this file; null for a side-effect import. */
  local: string | null;
  typeOnly: boolean;
  /** True for language-level static imports/usings. */
  static: boolean;
  /** True when the declaration applies beyond the current source file. */
  global: boolean;
}

export interface ExportFact extends SourceFactBase {
  kind: "export";
  /** Public name: `default`, `*`, or a named export. */
  exported: string;
  /** Local declaration/binding when one exists. */
  local: string | null;
  /** Re-export source, otherwise null. */
  source: string | null;
  typeOnly: boolean;
}

export type CallBindingKind = "source-chunk" | "import" | "local" | "unknown";

export interface CallFact extends SourceFactBase {
  kind: "call";
  /** Source spelling of the callee, such as `load` or `config.load`. */
  callee: string;
  /** Nearest lexical binding for the callee root. */
  binding: CallBindingKind;
  /** Exact local callable when `binding` is `source-chunk`. */
  target: SourceChunkRef | null;
}

export type SourceFact = ImportFact | ExportFact | CallFact;

/** The verbatim text of any chunk — leaf text directly, parent text by
 *  gluing its leaves (equals `source.slice(startOffset, endOffset)`). */
export function textOf(chunk: SourceChunk): string {
  if (chunk.children.length === 0) return chunk.text ?? "";
  let out = "";
  for (const leaf of leaves(chunk.children)) out += leaf.text ?? "";
  return out;
}

export interface SourceChunkOptions {
  /** Override language detection. */
  language?: Language;
}

/** Result of chunking one file. */
export interface SourceChunkResult {
  /** Detected language, or the fallback format that was used. */
  language: Language | "markdown" | "text" | null;
  strategy: SourceChunkStrategy;
  /** True when the input is binary — no chunks are produced. */
  binary: boolean;
  /** Set when the file was detected as machine-generated/pathological
   *  (minified, extreme line lengths). The file is still chunked in full —
   *  the flag is a recorded fact for downstream layers to skip or demote
   *  (decision 01-D2). */
  opaque: string | null;
  /** Top-level chunk tree. */
  chunks: SourceChunk[];
  /** Syntax observations extracted during the same parse. */
  facts: SourceFact[];
}

/** File extension (with dot, lowercase) → language */
export const EXTENSION_MAP: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".scala": "scala",
  ".sc": "scala",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".lua": "lua",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
  ".sh": "bash",
  ".bash": "bash",
  ".toml": "toml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".dart": "dart",
};

/** Depth-first iterator over the leaves of a chunk tree, in source order.
 *  Leaves partition the normalized source byte-for-byte (INV-C2). */
export function* leaves(chunks: SourceChunk[]): Generator<SourceChunk> {
  for (const chunk of chunks) {
    if (chunk.children.length === 0) yield chunk;
    else yield* leaves(chunk.children);
  }
}

/** Depth-first iterator over every chunk in the tree, parents before children. */
export function* walk(chunks: SourceChunk[]): Generator<SourceChunk> {
  for (const chunk of chunks) {
    yield chunk;
    yield* walk(chunk.children);
  }
}
