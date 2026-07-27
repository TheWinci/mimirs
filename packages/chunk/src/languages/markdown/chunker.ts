import type { SourceChunk } from "../../types";

/**
 * Markdown section chunker. Sections split on headings — ATX (`#`..`######`)
 * and setext (a text line underlined with `===` or `---`) — and nest by
 * heading level, forming the chunk tree. Headings inside fenced code blocks
 * (``` or ~~~, any fence length ≥ 3) are content, not structure.
 *
 * A section chunk spans its heading line through the line before the next
 * heading of the same or shallower level. Content before the first heading
 * becomes a `paragraph` chunk. A section with subsections holds its own
 * pre-subsection body as a `block` (or `gap` when it is whitespace-only)
 * child so leaves still partition the file without misclassifying prose.
 */

interface Heading {
  level: number;
  name: string;
  /** Offset where the heading (and its section) starts. */
  start: number;
}

interface Fence {
  character: "`" | "~";
  length: number;
}

function findHeadings(source: string, lineStarts: number[]): Heading[] {
  const lines = source.split("\n");
  const headings: Heading[] = [];
  let fence: Fence | null = null;
  let frontMatterEnd = -1;

  // An initial YAML front-matter block is preamble content, not Markdown
  // structure. Without this guard its closing `---` can turn the preceding
  // YAML value into a false Setext heading.
  if (/^---\s*$/.test(lines[0] ?? "")) {
    for (let row = 1; row < lines.length; row++) {
      if (/^---\s*$/.test(lines[row])) {
        frontMatterEnd = row;
        break;
      }
    }
  }

  for (let row = 0; row < lines.length; row++) {
    if (row <= frontMatterEnd) continue;
    const line = lines[row];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const character = marker[0] as Fence["character"];
      if (!fence) {
        fence = { character, length: marker.length };
      } else if (fence.character === character && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const atx = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (atx) {
      headings.push({ level: atx[1].length, name: atx[2].trim(), start: lineStarts[row] });
      continue;
    }

    // Setext: this line is text, next line is === or --- (allow trailing spaces).
    const next = lines[row + 1];
    if (
      next !== undefined &&
      line.trim() !== "" &&
      !/^ {0,3}[-*_>#]/.test(line) &&
      /^ {0,3}(=+|-+)\s*$/.test(next)
    ) {
      headings.push({
        level: next.trim().startsWith("=") ? 1 : 2,
        name: line.trim(),
        start: lineStarts[row],
      });
      row++; // skip the underline
    }
  }
  return headings;
}

function makeChunk(
  source: string,
  lineStarts: number[],
  kind: SourceChunk["kind"],
  name: string | null,
  start: number,
  end: number,
  children: SourceChunk[] = [],
): SourceChunk {
  let startLine = 1;
  let endLine = 1;
  // Linear scans are fine here: markdown files have few sections.
  for (let i = 0; i < lineStarts.length; i++) {
    if (lineStarts[i] <= start) startLine = i + 1;
    if (lineStarts[i] <= Math.max(start, end - 1)) endLine = i + 1;
  }
  return {
    kind,
    name,
    ...(children.length === 0 ? { text: source.slice(start, end) } : {}),
    startOffset: start,
    endOffset: end,
    startLine,
    endLine,
    children,
  };
}

function bodyKind(source: string, start: number, end: number): "block" | "gap" {
  return source.slice(start, end).trim() === "" ? "gap" : "block";
}

/** Build the section tree for headings[from..) at the given level bound,
 *  covering [start, end). */
function buildSections(
  source: string,
  lineStarts: number[],
  headings: Heading[],
  from: number,
  start: number,
  end: number,
): { chunks: SourceChunk[]; next: number } {
  const chunks: SourceChunk[] = [];
  let cursor = start;
  let i = from;

  // Body before the first heading at this level.
  if (i < headings.length && headings[i].start > cursor) {
    chunks.push(
      makeChunk(
        source,
        lineStarts,
        i === from && from === 0
          ? "paragraph"
          : bodyKind(source, cursor, headings[i].start),
        null,
        cursor,
        headings[i].start,
      ),
    );
    cursor = headings[i].start;
  } else if (i >= headings.length && cursor < end) {
    chunks.push(
      makeChunk(
        source,
        lineStarts,
        from === 0 ? "paragraph" : bodyKind(source, cursor, end),
        null,
        cursor,
        end,
      ),
    );
    return { chunks, next: i };
  }

  while (i < headings.length && headings[i].start < end) {
    const heading = headings[i];
    // Section extends to the next heading with level <= this one, or `end`.
    let j = i + 1;
    while (j < headings.length && headings[j].level > heading.level) j++;
    const sectionEnd = j < headings.length && headings[j].start < end ? headings[j].start : end;

    // Children: subsections between i+1 and j.
    let children: SourceChunk[] = [];
    if (i + 1 < j && headings[i + 1].start < sectionEnd) {
      const inner = buildSections(source, lineStarts, headings, i + 1, heading.start, sectionEnd);
      children = inner.chunks;
    }
    chunks.push(makeChunk(source, lineStarts, "section", heading.name, heading.start, sectionEnd, children));
    cursor = sectionEnd;
    i = j;
  }

  if (cursor < end) {
    chunks.push(
      makeChunk(
        source,
        lineStarts,
        bodyKind(source, cursor, end),
        null,
        cursor,
        end,
      ),
    );
  }
  return { chunks, next: i };
}

export function chunkMarkdown(source: string, lineStarts: number[]): SourceChunk[] {
  if (source.length === 0) return [];
  const headings = findHeadings(source, lineStarts);
  if (headings.length === 0) {
    return [makeChunk(source, lineStarts, "paragraph", null, 0, source.length)];
  }
  return buildSections(source, lineStarts, headings, 0, 0, source.length).chunks;
}
