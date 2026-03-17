import { chunk as astChunk } from "code-chunk";

export interface ChunkImport {
  name: string;
  source: string;
}

export interface ChunkExport {
  name: string;
  type: string;
}

export interface Chunk {
  text: string;
  index: number;
  imports?: ChunkImport[];
  exports?: ChunkExport[];
}

const DEFAULT_CHUNK_SIZE = 512; // in characters
const DEFAULT_CHUNK_OVERLAP = 50;

// Extensions that code-chunk supports via tree-sitter
const AST_SUPPORTED = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
]);

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
): Promise<Chunk[]> {
  // Try AST-aware chunking for supported code files (even small ones, for import/export extraction)
  if (AST_SUPPORTED.has(extension)) {
    try {
      const astChunks = await astChunk(filePath || `file${extension}`, text, {
        maxChunkSize: chunkSize,
      });
      if (astChunks.length > 0) {
        return astChunks.map((c, i) => ({
          text: c.text,
          index: i,
          imports: c.context.imports.map((im) => ({ name: im.name, source: im.source })),
          exports: c.context.entities
            .filter((e) => e.type === "export" || e.type === "function" || e.type === "class" || e.type === "interface" || e.type === "type" || e.type === "enum")
            .map((e) => ({ name: e.name, type: e.type })),
        }));
      }
    } catch {
      // Fall through to heuristic chunking
    }
  }

  if (text.length <= chunkSize) {
    return [{ text, index: 0 }];
  }

  const isMarkdown = [".md", ".mdx", ".markdown"].includes(extension);
  const isCode = [
    ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs",
    ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".swift",
  ].includes(extension);

  let sections: string[];

  if (isMarkdown) {
    sections = splitMarkdown(text);
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

  return chunks;
}

function splitMarkdown(text: string): string[] {
  // Split on heading boundaries (## or ###)
  const parts = text.split(/(?=^#{1,3}\s)/m);
  return parts.filter((p) => p.trim().length > 0);
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
