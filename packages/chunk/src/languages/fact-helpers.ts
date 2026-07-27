import type { Node as SyntaxNode } from "web-tree-sitter";

import type {
  SourceChunk,
  SourceChunkRef,
  SourceSpan,
} from "../types";

/** Mechanical source-span conversion shared by language-specific extractors. */
export function factSpan(node: SyntaxNode, lineStarts: number[]): SourceSpan {
  return {
    startOffset: node.startIndex,
    endOffset: node.endIndex,
    startLine: offsetToLine(lineStarts, node.startIndex),
    endLine: offsetToLine(
      lineStarts,
      Math.max(node.startIndex, node.endIndex - 1),
    ),
  };
}

export function chunkRef(chunk: SourceChunk): SourceChunkRef {
  return {
    kind: chunk.kind,
    name: chunk.name!,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  };
}

/** Find the deepest named source chunk containing a fact's complete span. */
export function factOwner(
  chunks: SourceChunk[],
  startOffset: number,
  endOffset: number,
  owner: SourceChunkRef | null = null,
): SourceChunkRef | null {
  return factOwnerWhere(chunks, startOffset, endOffset, () => true, owner);
}

/** Find the deepest accepted named owner while still traversing excluded parents. */
export function factOwnerWhere(
  chunks: SourceChunk[],
  startOffset: number,
  endOffset: number,
  accept: (chunk: SourceChunk) => boolean,
  owner: SourceChunkRef | null = null,
): SourceChunkRef | null {
  for (const chunk of chunks) {
    if (chunk.startOffset > startOffset || chunk.endOffset < endOffset) continue;
    const nextOwner = chunk.name === null || !accept(chunk) ? owner : chunkRef(chunk);
    return factOwnerWhere(chunk.children, startOffset, endOffset, accept, nextOwner);
  }
  return owner;
}

/** Named descendants in deterministic source order, excluding the root. */
export function syntaxDescendants(
  node: SyntaxNode,
  type?: string,
): SyntaxNode[] {
  const matches: SyntaxNode[] = [];
  const stack = [...node.namedChildren].reverse();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (type === undefined || current.type === type) matches.push(current);
    for (let index = current.namedChildren.length - 1; index >= 0; index--) {
      stack.push(current.namedChildren[index]!);
    }
  }
  return matches;
}

/** Named nodes in deterministic source order, including the root. */
export function* walkSyntax(node: SyntaxNode): Generator<SyntaxNode> {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    yield current;
    for (let index = current.namedChildren.length - 1; index >= 0; index--) {
      stack.push(current.namedChildren[index]!);
    }
  }
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
