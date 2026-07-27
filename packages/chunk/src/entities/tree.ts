import type { Node as SyntaxNode, Tree } from "web-tree-sitter";
import type { CommentNode, Entity } from "./types";
import type { Language, SourceChunkKind } from "../types";
import { offsetToRow } from "../source-text";

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

/** A comment's line range, used by the attachment rule. */
export interface CommentRange {
  startLine: number;
  endLine: number;
}

function isCommentNodeType(type: string): boolean {
  // Every grammar in this repo names its comment nodes with a "comment"
  // substring except tree-sitter-haskell's doc comment node `haddock`.
  return type.includes("comment") || type === "haddock";
}

/** Collect all comment nodes (offsets) plus a per-line attachment map.
 *  A comment's start/end line only enters the line map when that line holds
 *  no code outside the comment (a trailing `// note` after code must not
 *  make its whole line attachable). */
export function collectComments(
  tree: Tree,
  lines: string[],
  language: Language,
): { nodes: CommentNode[]; lineMap: Map<number, CommentRange> } {
  const nodes: CommentNode[] = [];
  const lineMap = new Map<number, CommentRange>();
  const stack: SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (language === "python" && node.type === "decorator") {
      const range: CommentRange = {
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
      };
      for (let line = range.startLine; line <= range.endLine; line++) {
        lineMap.set(line, range);
      }
    }
    if (isCommentNodeType(node.type)) {
      const sr = node.startPosition.row;
      const er = node.endPosition.row;
      nodes.push({
        startOffset: node.startIndex,
        endOffset: node.endIndex,
        startLine: sr,
        endLine: er,
      });
      const range: CommentRange = { startLine: sr, endLine: er };
      const startPure = (lines[sr] ?? "").slice(0, node.startPosition.column).trim() === "";
      const endPure = (lines[er] ?? "").slice(node.endPosition.column).trim() === "";
      for (let l = sr; l <= er; l++) {
        if (l === sr && !startPure) continue;
        if (l === er && !endPure) continue;
        lineMap.set(l, range);
      }
      continue;
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  nodes.sort((a, b) => a.startOffset - b.startOffset);
  return { nodes, lineMap };
}

/** Check if a line is a decorator/attribute line for the language. */
function isDecoratorLine(line: string, language: Language): boolean {
  const trimmed = line.trim();
  switch (language) {
    case "python":
      return trimmed.startsWith("@");
    case "typescript":
    case "javascript":
    case "java":
    case "kotlin":
    case "dart":
      return trimmed.startsWith("@") && !trimmed.startsWith("@interface");
    case "php":
      return trimmed.startsWith("#[");
    case "rust":
    case "zig":
      return trimmed.startsWith("#[") || trimmed.startsWith("#![");
    case "csharp":
      return trimmed.startsWith("[") && trimmed.endsWith("]");
    case "elixir":
      return trimmed.startsWith("@") && !trimmed.startsWith("@doc") && !trimmed.startsWith("@moduledoc");
    default:
      return false;
  }
}

/**
 * Attachment rule (decision 01-D3): a comment block or decorator run directly
 * above an entity belongs to it. A blank line between the run and entity makes
 * the comment standalone; a blank line above the attached run also ends the
 * walk (so a file header stays unattached). Comment nodes are taken whole —
 * never split inside a comment.
 * Returns the adjusted 0-indexed start row.
 */
function findLeadingContext(
  lines: string[],
  entityStartLine: number,
  floorLine: number,
  language: Language,
  commentLines: Map<number, CommentRange>,
): number {
  let start = entityStartLine;
  let i = entityStartLine - 1;

  while (i > floorLine) {
    const line = lines[i];
    if (!line.trim()) break; // blank above the attached run — stop
    const range = commentLines.get(i);
    if (range && commentLines.has(range.startLine)) {
      start = Math.max(range.startLine, floorLine + 1);
      i = start - 1;
    } else if (isDecoratorLine(line, language)) {
      start = i;
      i--;
    } else {
      break;
    }
  }

  return start;
}

/* ------------------------------------------------------------------ */
/* Entity tree                                                         */
/* ------------------------------------------------------------------ */

/**
 * Nest entities by span containment. Input entities in any order; output is
 * the top-level list, each entity holding its direct children. Partial
 * overlaps (neither contains the other) keep the earlier/larger entity and
 * drop the conflicting one.
 */
export function buildEntityTree(entities: Entity[]): Entity[] {
  const sorted = [...entities].sort(
    (a, b) => a.nodeStart - b.nodeStart || b.nodeEnd - a.nodeEnd,
  );
  const roots: Entity[] = [];
  const stack: Entity[] = [];
  for (const entity of sorted) {
    while (stack.length > 0 && stack[stack.length - 1].nodeEnd <= entity.nodeStart) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      if (entity.nodeEnd > parent.nodeEnd) continue; // partial overlap — drop
      if (entity.nodeStart === parent.nodeStart && entity.nodeEnd === parent.nodeEnd) {
        continue; // duplicate span (e.g. wrapper node) — keep the outer one
      }
      parent.children.push(entity);
    } else {
      roots.push(entity);
    }
    stack.push(entity);
  }
  return roots;
}

/** Python uses the same syntax node for module functions, methods, and nested
 * functions. Direct containment by a class is the semantic distinction. */
export function classifyContainedEntities(
  entities: Entity[],
  language: Language,
  parentKind: SourceChunkKind | null = null,
): void {
  for (const entity of entities) {
    if (language === "python" && parentKind === "class" && entity.kind === "function") {
      entity.kind = "method";
    }
    if (language === "python" && parentKind === "class" && entity.kind === "variable") {
      entity.kind = "field";
    }
    if (
      language === "rust" && (parentKind === "impl" || parentKind === "trait") &&
      entity.kind === "function"
    ) {
      entity.kind = "method";
    }
    if (
      language === "cpp" && (parentKind === "class" || parentKind === "struct") &&
      entity.kind === "function"
    ) entity.kind = "method";
    if (
      language === "scala" &&
      ["class", "trait", "enum", "given", "impl"].includes(parentKind ?? "") &&
      entity.kind === "function" &&
      ["function_definition", "function_declaration"].includes(entity.nodeType)
    ) entity.kind = "method";
    if (
      language === "scala" &&
      ["class", "trait", "enum", "given", "impl", "module"].includes(parentKind ?? "") &&
      entity.kind === "variable"
    ) entity.kind = "field";
    if (
      language === "kotlin" &&
      ["class", "interface", "enum", "record", "annotation_type"].includes(
        parentKind ?? "",
      ) &&
      entity.kind === "function" &&
      entity.nodeType === "function_declaration"
    ) entity.kind = "method";
    if (
      language === "kotlin" &&
      ["class", "interface", "enum", "record", "annotation_type"].includes(
        parentKind ?? "",
      ) &&
      entity.nodeType === "property_declaration"
    ) entity.kind = "field";
    if (
      language === "zig" &&
      ["struct", "enum", "type"].includes(parentKind ?? "") &&
      entity.kind === "function"
    ) entity.kind = "method";
    if (
      language === "zig" && parentKind === "enum" &&
      entity.nodeType === "container_field"
    ) entity.kind = "constant";
    classifyContainedEntities(entity.children, language, entity.kind);
  }
}

/* ------------------------------------------------------------------ */
/* Span adjustment: comment attachment + line snapping                 */
/* ------------------------------------------------------------------ */

/**
 * Adjust every entity's span in place:
 * - start pulls back to include attached doc comments/decorators (01-D3),
 *   snapped to the start of that line;
 * - start snaps to its own line start when only whitespace precedes it;
 * - end extends through the trailing newline when only whitespace follows on
 *   the end line.
 * Children are clamped inside their parent; siblings never overlap (the
 * attachment floor is the previous sibling's end row / the parent's start row).
 */
export function adjustSpans(
  tree: Entity[],
  source: string,
  lines: string[],
  lineStarts: number[],
  language: Language,
  commentLines: Map<number, CommentRange>,
  floorRow: number,
  parentEnd: number,
): void {
  let prevEndRow = floorRow;
  for (let i = 0; i < tree.length; i++) {
    const entity = tree[i];
    const next = tree[i + 1];

    const adjRow = findLeadingContext(lines, entity.startRow, prevEndRow, language, commentLines);
    if (adjRow < entity.startRow) {
      entity.start = lineStarts[adjRow];
    } else if (prevEndRow < entity.startRow) {
      // No other entity on this line before us — take the whole line, so
      // statement prefixes (`export `, `pub `, indentation) stay with the
      // entity instead of leaking into a gap chunk.
      entity.start = lineStarts[entity.startRow];
    } // else: previous sibling ends on our line — keep the exact node start.

    // Extend the end through the rest of its line (incl. `;`, `,`, trailing
    // comment, newline) unless the next sibling starts on that same line.
    const endRow = offsetToRow(lineStarts, Math.max(entity.start, entity.nodeEnd - 1));
    let end = entity.nodeEnd;
    if (!next || next.startRow > endRow) {
      const lineEnd = endRow + 1 < lineStarts.length ? lineStarts[endRow + 1] : source.length;
      end = lineEnd;
    }
    entity.end = Math.min(Math.max(end, entity.nodeEnd), parentEnd);

    adjustSpans(
      entity.children,
      source,
      lines,
      lineStarts,
      language,
      commentLines,
      entity.startRow,
      entity.end,
    );

    prevEndRow = offsetToRow(lineStarts, Math.max(entity.start, entity.end - 1));
  }
}

/** Merge consecutive sibling import entities separated by whitespace that
 *  contains no blank line into one import entity (uncapped). */
function collapseImports(siblings: Entity[], source: string): Entity[] {
  const result: Entity[] = [];
  for (const entity of siblings) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.kind === "import" &&
      entity.kind === "import" &&
      prev.children.length === 0 &&
      entity.children.length === 0
    ) {
      const between = source.slice(prev.end, entity.start);
      const blankLine = /\n[ \t]*\n/.test(between);
      if (between.trim() === "" && !blankLine) {
        prev.end = entity.end;
        prev.nodeEnd = entity.nodeEnd;
        prev.name = null;
        continue;
      }
    }
    result.push(entity);
  }
  return result;
}

/** Keep a TypeScript overload set with its implementation as one source
 * entity. The signatures are not useful in isolation, and separating them
 * would leave the implementation without its public call contract. */
function collapseOverloads(siblings: Entity[], source: string): Entity[] {
  const result: Entity[] = [];
  for (const entity of siblings) {
    const prev = result[result.length - 1];
    if (
      prev?.overloadSignature &&
      (prev.kind === "function" || prev.kind === "method") &&
      entity.kind === prev.kind &&
      prev.name === entity.name &&
      source.slice(prev.end, entity.start).trim() === ""
    ) {
      prev.nodeEnd = entity.nodeEnd;
      prev.end = entity.end;
      prev.overloadSignature = entity.overloadSignature;
      prev.children.push(...entity.children);
      continue;
    }
    result.push(entity);
  }
  return result;
}

/** Collapse source constructs that are semantically one entity at every level. */
export function collapseEntityGroupsDeep(tree: Entity[], source: string): Entity[] {
  const merged = collapseOverloads(collapseImports(tree, source), source);
  for (const entity of merged) {
    entity.children = collapseEntityGroupsDeep(entity.children, source);
  }
  return merged;
}
