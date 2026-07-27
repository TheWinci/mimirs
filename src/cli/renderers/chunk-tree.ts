import type { SourceChunk } from "@winci/bun-chunk";

const HIDDEN_FILLER_KINDS = new Set(["gap"]);

interface TreeEntry {
  chunk: SourceChunk;
  children: TreeEntry[];
}

function structuralEntries(chunks: SourceChunk[], parent: SourceChunk | null = null): TreeEntry[] {
  const entries: TreeEntry[] = [];

  for (const current of chunks) {
    const internalBlock = current.kind === "block" && parent !== null &&
      (parent.name !== null ||
        parent.kind === "constant" ||
        parent.kind === "variable" ||
        parent.kind === "section");
    if (HIDDEN_FILLER_KINDS.has(current.kind) || internalBlock) {
      entries.push(...structuralEntries(current.children, parent));
      continue;
    }

    entries.push({
      chunk: current,
      children: structuralEntries(current.children, current),
    });
  }

  return entries;
}

function label(chunk: SourceChunk): string {
  const name = chunk.name ? ` ${chunk.name.replace(/\s+/g, " ").trim()}` : "";
  const lines = chunk.startLine === chunk.endLine
    ? `${chunk.startLine}`
    : `${chunk.startLine}–${chunk.endLine}`;
  return `${chunk.kind}${name} [${lines}]`;
}

function renderEntries(entries: TreeEntry[], prefix: string, output: string[]): void {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const last = index === entries.length - 1;
    output.push(`${prefix}${last ? "└──" : "├──"} ${label(entry.chunk)}`);
    renderEntries(entry.children, `${prefix}${last ? "    " : "│   "}`, output);
  }
}

export function renderChunkTree(filepath: string, chunks: SourceChunk[]): string {
  const output = [filepath];
  renderEntries(structuralEntries(chunks), "", output);
  return output.join("\n");
}
