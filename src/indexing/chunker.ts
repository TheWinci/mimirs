import { chunk as astChunk, chunkFile as astChunkFile } from "@winci/bun-chunk";
import type { ChunkImport, ChunkExport } from "@winci/bun-chunk";
import { log } from "../utils/log";

export type { ChunkImport, ChunkExport };

export interface Chunk {
  text: string;
  index: number;
  startLine?: number;
  endLine?: number;
  imports?: ChunkImport[];
  exports?: ChunkExport[];
  parentName?: string;
  /** Symbol name from AST (e.g. "emit", "constructor") — available even without exports */
  name?: string;
  /** AST chunk type (e.g. "method", "field", "class") — available even without exports */
  chunkType?: string;
  hash?: string;
}

const DEFAULT_CHUNK_SIZE = 512; // in characters
const DEFAULT_CHUNK_OVERLAP = 50;

// Extensions that bun-chunk supports via tree-sitter
const AST_SUPPORTED = new Set([
  // Original
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  // bun-chunk Phase 2 additions
  ".c", ".h",
  ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
  ".cs",
  ".rb",
  ".php",
  ".scala", ".sc",
  ".html", ".htm",
  ".css", ".scss", ".less",
]);

// Code-like extensions handled by blank-line heuristic splitting
const HEURISTIC_CODE = new Set([
  ".swift",
  ".sh", ".bash", ".zsh", ".fish",
  ".tf", ".proto", ".graphql", ".gql",
  ".mod", ".xml",
  ".jenkinsfile", ".vagrantfile", ".gemfile", ".rakefile", ".brewfile", ".procfile",
]);

/**
 * Every extension (real or virtual) that chunkText knows how to handle.
 * Files with extensions outside this set are skipped by the indexer so
 * binaries and other unrecognised formats never enter the DB.
 */
export const KNOWN_EXTENSIONS = new Set([
  // Markdown
  ".md", ".mdx", ".markdown",
  // Plain text
  ".txt",
  // AST-aware code
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
  ".cs", ".rb", ".php", ".scala", ".sc",
  ".html", ".htm", ".css", ".scss", ".less",
  // Heuristic code (blank-line blocks)
  ".swift",
  ".sh", ".bash", ".zsh", ".fish",
  ".tf", ".proto", ".graphql", ".gql",
  ".mod",
  ".xml",
  // Virtual extensions for basename-detected files
  ".makefile", ".dockerfile", ".jenkinsfile",
  ".vagrantfile", ".gemfile", ".rakefile", ".brewfile", ".procfile",
  // Structured data
  ".yaml", ".yml", ".json", ".toml",
  // Query / schema languages
  ".sql",
  // API collections
  ".bru",
]);

export interface ChunkTextResult {
  chunks: Chunk[];
  fileImports?: ChunkImport[];
  fileExports?: ChunkExport[];
}

/**
 * Split text into chunks. Strategy depends on content type:
 * - Code (supported languages): AST-aware chunking via tree-sitter
 * - Markdown: split on headings first, then by size
 * - Code (unsupported): split on blank-line-separated blocks, then by size
 * - Other: split on paragraphs, then by size
 */
export async function chunkText(
  text: string,
  extension: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP,
  filePath?: string
): Promise<ChunkTextResult> {
  const result = await _chunkText(text, extension, chunkSize, chunkOverlap, filePath);
  assignLineNumbers(result.chunks, text);
  return result;
}

async function _chunkText(
  text: string,
  extension: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP,
  filePath?: string
): Promise<ChunkTextResult> {
  // Try AST-aware chunking for supported code files (even small ones, for import/export extraction)
  if (AST_SUPPORTED.has(extension)) {
    try {
      const astOpts = { includeContext: true, includeMetadata: true };
      let result;
      if (filePath) {
        try {
          result = await astChunkFile(filePath, astOpts);
        } catch {
          // File may not exist on disk (e.g. tests with inline code) — fall back to text-based AST
          result = await astChunk(`file${extension}`, text, astOpts);
        }
      } else {
        result = await astChunk(`file${extension}`, text, astOpts);
      }

      if (result.chunks.length > 0) {
        const chunks = result.chunks.map((c, i) => {
          const chunk: Chunk = {
            text: c.text,
            index: i,
            startLine: c.startLine + 1, // bun-chunk is 0-indexed, local-rag is 1-indexed
            endLine: c.endLine + 1,
          };
          if (c.imports?.length) chunk.imports = c.imports;
          if (c.exports?.length) chunk.exports = c.exports;
          if (c.parentName) chunk.parentName = c.parentName;
          if (c.name) chunk.name = c.name;
          if (c.type) chunk.chunkType = c.type;
          if (c.hash) chunk.hash = c.hash;
          return chunk;
        });
        return {
          chunks,
          fileImports: result.fileImports,
          fileExports: result.fileExports,
        };
      }
    } catch (err) {
      log.debug(`AST chunking failed for ${filePath || extension}, using heuristic: ${err instanceof Error ? err.message : err}`, "chunker");
    }
  }

  if (text.length <= chunkSize) {
    return { chunks: [{ text, index: 0 }] };
  }

  const isMarkdown = [".md", ".mdx", ".markdown"].includes(extension);
  // Code-like files: split on blank-line-separated blocks as a heuristic.
  // Includes AST-supported languages plus shell, HCL, proto, GraphQL, etc.
  const isCode = AST_SUPPORTED.has(extension) || HEURISTIC_CODE.has(extension);

  let sections: string[];

  if (isMarkdown) {
    sections = splitMarkdown(text);
  } else if (extension === ".makefile") {
    sections = splitMakefile(text);
  } else if (extension === ".dockerfile") {
    sections = splitDockerfile(text);
  } else if (extension === ".yaml" || extension === ".yml") {
    sections = splitYAML(text);
  } else if (extension === ".json") {
    sections = splitJSON(text);
  } else if (extension === ".toml") {
    sections = splitTOML(text);
  } else if (extension === ".bru") {
    sections = splitBru(text);
  } else if (extension === ".sql") {
    sections = splitSQL(text);
  } else if (isCode) {
    sections = splitCode(text);
  } else {
    sections = splitParagraphs(text);
  }

  // Further split any section that exceeds chunkSize
  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of sections) {
    if (section.length <= chunkSize) {
      chunks.push({ text: section, index: index++ });
    } else {
      const subChunks = splitBySize(section, chunkSize, chunkOverlap);
      for (const sub of subChunks) {
        chunks.push({ text: sub, index: index++ });
      }
    }
  }

  return { chunks };
}

/**
 * Assign startLine/endLine to each chunk by locating the chunk text in the
 * original file source. Uses indexOf with a forward cursor so overlapping or
 * repeated text still resolves in order. Chunks whose text is not a verbatim
 * substring (e.g. JSON-reformatted chunks) are left without line numbers.
 */
function assignLineNumbers(chunks: Chunk[], fullText: string): void {
  const lineOffsets = [0];
  for (let i = 0; i < fullText.length; i++) {
    if (fullText[i] === "\n") lineOffsets.push(i + 1);
  }

  function offsetToLine(offset: number): number {
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineOffsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  }

  let cursor = 0;
  for (const chunk of chunks) {
    const idx = fullText.indexOf(chunk.text, cursor);
    if (idx >= 0) {
      chunk.startLine = offsetToLine(idx);
      chunk.endLine = offsetToLine(idx + Math.max(chunk.text.length - 1, 0));
      cursor = idx + chunk.text.length;
    }
  }
}

function splitMarkdown(text: string): string[] {
  // Split on heading boundaries (## or ###)
  const parts = text.split(/(?=^#{1,3}\s)/m);
  return parts.filter((p) => p.trim().length > 0);
}

function splitDockerfile(text: string): string[] {
  // Each FROM instruction starts a new build stage — use that as the primary
  // boundary. Within a single-stage file this produces one section, which the
  // size-based fallback will further split if needed.
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^FROM\s+/i.test(line) && current.length > 0) {
      const section = current.join("\n").trim();
      if (section) sections.push(section);
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const section = current.join("\n").trim();
    if (section) sections.push(section);
  }

  return mergeTinyParts(sections.length > 0 ? sections : [text], 100);
}

function splitBru(text: string): string[] {
  // Each top-level block in the Bru Markup Language starts at column 0 with
  // `keyword {` (keyword may contain colons/hyphens, e.g. `body:json`, `vars:pre-request`).
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^[a-zA-Z][a-zA-Z0-9:_-]*\s*\{/.test(line) && current.length > 0) {
      const section = current.join("\n").trim();
      if (section) sections.push(section);
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const section = current.join("\n").trim();
    if (section) sections.push(section);
  }

  return mergeTinyParts(sections, 100);
}

function splitTOML(text: string): string[] {
  // Split on [section] and [[array-of-tables]] headers.
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^\s*\[\[?[\w.]/.test(line) && current.length > 0) {
      const section = current.join("\n").trim();
      if (section) sections.push(section);
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const section = current.join("\n").trim();
    if (section) sections.push(section);
  }

  return mergeTinyParts(sections, 100);
}

function splitSQL(text: string): string[] {
  // Split on semicolons that terminate statements. Preserves the semicolon
  // so each chunk reads as a complete statement.
  const statements = text
    .split(/(?<=;)\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return mergeTinyParts(statements, 100);
}

function splitMakefile(text: string): string[] {
  // Each Makefile target (and its recipe) becomes its own chunk.
  // A target line starts at column 0, is not a comment or blank, and has
  // a colon that is NOT part of := or ::= (variable assignment operators).
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const isTarget =
      line.length > 0 &&
      !line.startsWith("\t") &&
      !line.startsWith(" ") &&
      !line.startsWith("#") &&
      /^[A-Za-z0-9_./%$()-][^=\n]*:(?!=)/.test(line);

    if (isTarget && current.length > 0) {
      const section = current.join("\n").trim();
      if (section) sections.push(section);
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const section = current.join("\n").trim();
    if (section) sections.push(section);
  }

  return mergeTinyParts(sections, 100);
}

function splitYAML(text: string): string[] {
  // Split on top-level YAML keys (lines at column 0 matching `key:`).
  // For OpenAPI files (detected by a top-level `paths:` key), further split
  // the paths section on individual path entries (e.g. `  /users:`).
  const lines = text.split("\n");
  const topSections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const isTopKey =
      !line.startsWith(" ") &&
      !line.startsWith("\t") &&
      !line.startsWith("#") &&
      /^[a-zA-Z_$][a-zA-Z0-9_$-]*\s*:/.test(line);

    if (isTopKey && current.length > 0) {
      const section = current.join("\n").trim();
      if (section) topSections.push(section);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    const section = current.join("\n").trim();
    if (section) topSections.push(section);
  }

  // OpenAPI: further split the `paths:` section on individual path entries
  const result: string[] = [];
  for (const section of topSections) {
    if (/^paths\s*:/.test(section)) {
      result.push(...splitOpenAPIPathsYAML(section));
    } else {
      result.push(section);
    }
  }

  return mergeTinyParts(result, 100);
}

function splitOpenAPIPathsYAML(pathsSection: string): string[] {
  // Each `  /path:` line starts a new chunk (2-space indent + leading slash).
  const lines = pathsSection.split("\n");
  const chunks: string[] = [];
  let current: string[] = [lines[0]]; // "paths:" header line

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^  \//.test(line) && current.length > 1) {
      const section = current.join("\n").trim();
      if (section && section !== "paths:") chunks.push(section);
      current = ["paths:", line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 1) {
    const section = current.join("\n").trim();
    if (section && section !== "paths:") chunks.push(section);
  }

  return chunks.length > 0 ? chunks : [pathsSection];
}

// Above this size, skip JSON.parse to avoid OOM / long GC pauses.
// 500k-line files (~10-20MB) are fine; this guards against 100MB+ files.
const JSON_PARSE_LIMIT = 50 * 1024 * 1024;

function splitJSON(text: string): string[] {
  if (text.length > JSON_PARSE_LIMIT) {
    log.warn(
      `JSON file too large for structural parsing (${(text.length / 1024 / 1024).toFixed(1)}MB), using line-based splitting`,
      "chunker"
    );
    return splitParagraphs(text);
  }

  try {
    const obj = JSON.parse(text);

    if (typeof obj !== "object" || obj === null) {
      return [text];
    }

    if (Array.isArray(obj)) {
      // Chunk each array item individually
      const items = obj.map(
        (item, i) => `[${i}]: ${JSON.stringify(item, null, 2)}`
      );
      return mergeTinyParts(items, 100);
    }

    // Object: one chunk per top-level key.
    // For OpenAPI, further split `paths` into individual path chunks.
    const result: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (key === "paths" && typeof value === "object" && value !== null) {
        for (const [path, ops] of Object.entries(value)) {
          result.push(`paths["${path}"]: ${JSON.stringify(ops, null, 2)}`);
        }
      } else {
        result.push(`"${key}": ${JSON.stringify(value, null, 2)}`);
      }
    }

    return mergeTinyParts(result, 100);
  } catch {
    // Not valid JSON — fall back to paragraph splitting
    return splitParagraphs(text);
  }
}

function splitCode(text: string): string[] {
  // Split on double newlines (function/class boundaries)
  const parts = text.split(/\n\n+/);
  return mergeTinyParts(parts, 100);
}

function splitParagraphs(text: string): string[] {
  const parts = text.split(/\n\n+/);
  return mergeTinyParts(parts, 100);
}

/**
 * Merge consecutive tiny parts (< minSize chars) to avoid
 * creating embeddings for near-empty chunks.
 */
function mergeTinyParts(parts: string[], minSize: number): string[] {
  const merged: string[] = [];
  let buffer = "";

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (buffer.length + trimmed.length < minSize) {
      buffer += (buffer ? "\n\n" : "") + trimmed;
    } else {
      if (buffer) merged.push(buffer);
      buffer = trimmed;
    }
  }

  if (buffer) merged.push(buffer);
  return merged;
}

function splitBySize(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));

    if (end >= text.length) break;
    start = end - overlap;
  }

  return chunks;
}
