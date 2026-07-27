import type { Node as SyntaxNode, Tree } from "web-tree-sitter";
import type {
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
} from "../../types";
import { factOwner, factSpan, walkSyntax } from "../fact-helpers";

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function staticReference(value: string): string | null {
  const trimmed = unquote(value).trim();
  if (!trimmed) return null;
  if (
    /^(?:blob|data|javascript):/i.test(trimmed) ||
    trimmed.startsWith("#") ||
    /\{\{|\}\}|\$\{|#\{|\bvar\s*\(/i.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function urlArgument(
  node: SyntaxNode,
): { source: string; evidence: SyntaxNode } | null {
  const name = node.namedChildren.find(
    (child) => child.type === "function_name",
  );
  if (name?.text.toLowerCase() !== "url") return null;
  const argumentsNode = node.namedChildren.find(
    (child) => child.type === "arguments",
  );
  if (!argumentsNode || argumentsNode.namedChildren.length !== 1) return null;
  const value = argumentsNode.namedChildren[0]!;
  if (!["plain_value", "string_value"].includes(value.type)) return null;
  const source = staticReference(value.text);
  return source ? { source, evidence: value } : null;
}

function imageSetArguments(
  node: SyntaxNode,
): Array<{ source: string; evidence: SyntaxNode }> {
  const name = node.namedChildren.find((child) => child.type === "function_name");
  if (!name || !["image-set", "-webkit-image-set"].includes(name.text.toLowerCase())) {
    return [];
  }
  const argumentsNode = node.namedChildren.find((child) => child.type === "arguments");
  if (!argumentsNode) return [];
  return argumentsNode.namedChildren.flatMap((child) => {
    if (child.type !== "string_value") return [];
    const source = staticReference(child.text);
    return source ? [{ source, evidence: child }] : [];
  });
}

function importReference(
  node: SyntaxNode,
): { source: string; evidence: SyntaxNode } | null {
  for (const child of node.namedChildren) {
    if (child.type === "string_value") {
      const source = staticReference(child.text);
      if (source) return { source, evidence: child };
    }
    if (child.type === "call_expression") {
      const value = urlArgument(child);
      if (value) return value;
    }
  }
  return null;
}

function importFact(
  source: string,
  imported: string,
  evidence: SyntaxNode,
  owner: SourceChunkRef | null,
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
    owner,
    ...factSpan(evidence, starts),
  };
}

function hasAncestor(node: SyntaxNode, types: ReadonlySet<string>): boolean {
  let current = node.parent;
  while (current) {
    if (types.has(current.type)) return true;
    current = current.parent;
  }
  return false;
}

const NON_RESOURCE_URL_ANCESTORS = new Set([
  "import_statement",
  "namespace_statement",
]);

export function extractCssFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "import_statement") {
      const value = importReference(node);
      if (value) {
        facts.push(
          importFact(
            value.source,
            "stylesheet",
            value.evidence,
            factOwner(chunks, node.startIndex, node.endIndex),
            starts,
          ),
        );
      }
    } else if (
      node.type === "call_expression" &&
      !hasAncestor(node, NON_RESOURCE_URL_ANCESTORS)
    ) {
      const value = urlArgument(node);
      if (value) {
        facts.push(
          importFact(
            value.source,
            "asset:url",
            value.evidence,
            factOwner(chunks, node.startIndex, node.endIndex),
            starts,
          ),
        );
      }
      for (const image of imageSetArguments(node)) {
        facts.push(
          importFact(
            image.source,
            "asset:image-set",
            image.evidence,
            factOwner(chunks, node.startIndex, node.endIndex),
            starts,
          ),
        );
      }
    }
  }
  return facts.sort(
    (a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset,
  );
}
