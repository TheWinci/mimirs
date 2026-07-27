import type {
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
  SourceSpan,
} from "../../types";

interface Range {
  start: number;
  end: number;
}

function offsetToLine(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function span(start: number, end: number, starts: number[]): SourceSpan {
  return {
    startOffset: start,
    endOffset: end,
    startLine: offsetToLine(starts, start),
    endLine: offsetToLine(starts, Math.max(start, end - 1)),
  };
}

function ref(chunk: SourceChunk): SourceChunkRef {
  return {
    kind: chunk.kind,
    name: chunk.name!,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  };
}

function findOwner(
  chunks: SourceChunk[],
  start: number,
  end: number,
  current: SourceChunkRef | null = null,
): SourceChunkRef | null {
  for (const chunk of chunks) {
    if (chunk.startOffset > start || chunk.endOffset < end) continue;
    const next = chunk.name === null ? current : ref(chunk);
    return findOwner(chunk.children, start, end, next);
  }
  return current;
}

function staticReference(value: string): string | null {
  const trimmed = normalizeDestination(value.trim());
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(?:data|javascript|mailto|tel):/i.test(trimmed)) return null;
  if (/\{\{|\}\}|\$\{|<%|%>/.test(trimmed)) return null;
  return trimmed;
}

function normalizeDestination(value: string): string {
  return value
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, "$1")
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_, name: string) => ({
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    })[name.toLowerCase()] ?? _)
    .replace(/&#(\d+);/g, (_, digits: string) => decodeCodePoint(digits, 10))
    .replace(/&#x([\da-f]+);/gi, (_, digits: string) =>
      decodeCodePoint(digits, 16)
    );
}

function decodeCodePoint(digits: string, radix: number): string {
  const value = Number.parseInt(digits, radix);
  return value === 0 || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff
    ? "\ufffd"
    : String.fromCodePoint(value);
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function codeRanges(source: string, starts: number[]): Range[] {
  const lines = source.split("\n");
  const ranges: Range[] = [];
  let fence: { character: string; length: number; start: number } | null = null;
  for (let row = 0; row < lines.length; row++) {
    const match = lines[row]!.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    const marker = match[1]!;
    if (!fence) {
      fence = {
        character: marker[0]!,
        length: marker.length,
        start: starts[row]!,
      };
    } else if (fence.character === marker[0] && marker.length >= fence.length) {
      ranges.push({
        start: fence.start,
        end: row + 1 < starts.length ? starts[row + 1]! : source.length,
      });
      fence = null;
    }
  }
  if (fence) ranges.push({ start: fence.start, end: source.length });

  for (let index = 0; index < source.length; index++) {
    if (ranges.some((range) => range.start <= index && index < range.end)) {
      continue;
    }
    if (source[index] !== "`") continue;
    let length = 1;
    while (source[index + length] === "`") length++;
    const marker = "`".repeat(length);
    const end = source.indexOf(marker, index + length);
    if (end !== -1) {
      ranges.push({ start: index, end: end + length });
      index = end + length - 1;
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function isCode(offset: number, ranges: Range[]): boolean {
  return ranges.some((range) => range.start <= offset && offset < range.end);
}

function fact(
  source: string,
  imported: string,
  start: number,
  end: number,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact {
  return {
    kind: "import",
    source,
    imported,
    local: null,
    typeOnly: false,
    static: false,
    global: false,
    owner: findOwner(chunks, start, end),
    ...span(start, end, starts),
  };
}

export function extractMarkdownFacts(
  source: string,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  const ranges = codeRanges(source, starts);
  const claimed: Range[] = [];
  const definitions = new Map<string, string>();

  const inline =
    /(!?)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const match of source.matchAll(inline)) {
    const matchStart = match.index;
    if (isCode(matchStart, ranges)) continue;
    claimed.push({ start: matchStart, end: matchStart + match[0].length });
    const raw = match[2] ?? match[3] ?? "";
    const value = staticReference(raw);
    if (!value) continue;
    const start = matchStart + match[0].indexOf(raw);
    facts.push(
      fact(
        value,
        match[1] === "!" ? "image" : "link",
        start,
        start + raw.length,
        chunks,
        starts,
      ),
    );
  }

  const definition = /^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|([^\s]+))/gm;
  for (const match of source.matchAll(definition)) {
    const matchStart = match.index;
    if (isCode(matchStart, ranges)) continue;
    claimed.push({ start: matchStart, end: matchStart + match[0].length });
    const raw = match[2] ?? match[3] ?? "";
    const value = staticReference(raw);
    if (!value) continue;
    const label = normalizeLabel(match[1] ?? "");
    if (label && !definitions.has(label)) definitions.set(label, value);
    const start = matchStart + match[0].indexOf(raw);
    facts.push(
      fact(value, "reference", start, start + raw.length, chunks, starts),
    );
  }

  const fullReference = /(!?)\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
  for (const match of source.matchAll(fullReference)) {
    const matchStart = match.index;
    if (isCode(matchStart, ranges) || isCode(matchStart, claimed)) continue;
    claimed.push({ start: matchStart, end: matchStart + match[0].length });
    const label = normalizeLabel(match[3] || match[2] || "");
    const value = definitions.get(label);
    if (!value) continue;
    facts.push(
      fact(
        value,
        match[1] === "!" ? "image" : "link",
        matchStart,
        matchStart + match[0].length,
        chunks,
        starts,
      ),
    );
  }

  const shortcutReference = /(!?)\[([^\]\n]+)\](?![\[(])/g;
  for (const match of source.matchAll(shortcutReference)) {
    const matchStart = match.index;
    if (isCode(matchStart, ranges) || isCode(matchStart, claimed)) continue;
    claimed.push({ start: matchStart, end: matchStart + match[0].length });
    const value = definitions.get(normalizeLabel(match[2] ?? ""));
    if (!value) continue;
    facts.push(
      fact(
        value,
        match[1] === "!" ? "image" : "link",
        matchStart,
        matchStart + match[0].length,
        chunks,
        starts,
      ),
    );
  }

  const autolink = /<((?:https?):\/\/[^ <>\n]+)>/g;
  for (const match of source.matchAll(autolink)) {
    const matchStart = match.index;
    if (isCode(matchStart, ranges) || isCode(matchStart, claimed)) continue;
    const raw = match[1]!;
    const start = matchStart + 1;
    facts.push(fact(raw, "link", start, start + raw.length, chunks, starts));
  }

  return facts.sort(
    (a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset,
  );
}
