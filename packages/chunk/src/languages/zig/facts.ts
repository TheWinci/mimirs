import type { Node as SyntaxNode, Tree } from "web-tree-sitter";
import type {
  CallBindingKind,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
} from "../../types";
import { factOwner, factSpan, walkSyntax } from "../fact-helpers";

interface Binding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

function stringValue(node: SyntaxNode | null): string | null {
  if (!node || node.type !== "string") return null;
  return node.text.length >= 2 ? node.text.slice(1, -1) : "";
}
function builtinName(node: SyntaxNode): string | null {
  return (
    node.namedChildren.find((child) => child.type === "builtin_identifier")
      ?.text ?? null
  );
}
function builtinArguments(node: SyntaxNode): SyntaxNode[] {
  return (
    node.namedChildren.find((child) => child.type === "arguments")
      ?.namedChildren ?? []
  );
}
function declarationName(node: SyntaxNode): string | null {
  return (
    node.namedChildren.find((child) => child.type === "identifier")?.text ??
    null
  );
}
function enclosingVariable(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (current.type === "variable_declaration") return current;
    if (current.type === "source_file") return null;
    current = current.parent;
  }
  return null;
}
function importFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact | null {
  const builtin = builtinName(node);
  if (!["@import", "@cInclude", "@embedFile"].includes(builtin ?? "")) return null;
  const args = builtinArguments(node);
  const source = args.length === 1 ? stringValue(args[0] ?? null) : null;
  if (source === null) return null;
  const variable = enclosingVariable(node);
  return {
    kind: "import",
    source,
    imported: builtin === "@cInclude" ? "c-header" : builtin === "@embedFile" ? "resource" : "*",
    local: variable ? declarationName(variable) : null,
    typeOnly: false,
    static: false,
    global: false,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, starts),
  };
}
function declaredChunk(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return owner?.name === name && ["function", "method"].includes(owner.kind)
    ? owner
    : null;
}
function variableImport(node: SyntaxNode): boolean {
  return node.namedChildren.some(
    (child) =>
      child.type === "builtin_function" &&
      ((builtinName(child) === "@import" &&
        stringValue(builtinArguments(child)[0] ?? null) !== null) ||
        builtinName(child) === "@cImport"),
  );
}
function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (node.type === "function_declaration") {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks);
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (node.type === "variable_declaration" && declarationName(node) === name) {
    return { kind: variableImport(node) ? "import" : "local", target: null };
  }
  return null;
}
function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "field_expression")
    return expressionRoot(node.childForFieldName("object"));
  if (node.type === "call_expression")
    return expressionRoot(node.childForFieldName("function"));
  if (node.type === "parenthesized_expression")
    return expressionRoot(node.namedChildren[0] ?? null);
  return null;
}
function parameterNames(node: SyntaxNode): string[] {
  return (
    node.namedChildren
      .find((child) => child.type === "parameters")
      ?.namedChildren.filter((child) => child.type === "parameter")
      .map((parameter) => parameter.childForFieldName("name")?.text)
      .filter((name): name is string => name !== undefined) ?? []
  );
}
function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}
function visibleBeforeCall(node: SyntaxNode, call: SyntaxNode): boolean {
  if (node.endIndex <= call.startIndex) return true;
  return node.type === "function_declaration" &&
    contains(node.childForFieldName("body"), call);
}
function payloadRegion(scope: SyntaxNode): SyntaxNode | null {
  if (["if_statement", "while_statement", "for_statement"].includes(scope.type)) {
    return scope.childForFieldName("body");
  }
  if (scope.type === "else_clause") return scope.childForFieldName("alternative");
  if (scope.type === "switch_case" || scope.type === "catch_expression") {
    return scope.namedChildren.at(-1) ?? null;
  }
  return null;
}
function payloadBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
): Binding | null {
  const payload = scope.namedChildren.find((child) => child.type === "payload");
  const region = payloadRegion(scope);
  if (!payload || !contains(region, call)) return null;
  return payload.namedChildren.some(
      (child) => child.type === "identifier" && child.text === name,
    )
    ? { kind: "local", target: null }
    : null;
}
function scopedBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  const found: Binding[] = [];
  for (const child of scope.namedChildren) {
    if (!visibleBeforeCall(child, call)) continue;
    const binding = declarationBinding(child, name, chunks);
    if (binding) found.push(binding);
  }
  return found.at(-1) ?? null;
}
function resolve(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    const captured = payloadBinding(current, call, name);
    if (captured) return captured;
    if (
      current.type === "function_declaration" &&
      parameterNames(current).includes(name)
    )
      return { kind: "local", target: null };
    if (current.type === "block" || current.type === "source_file") {
      const binding = scopedBinding(current, call, name, chunks);
      if (binding) return binding;
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}
function callFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact | null {
  if (
    node.type === "builtin_function" &&
    builtinName(node) === "@cImport" &&
    node.text.includes("@cInclude")
  )
    return null;
  let callee: string | null = null,
    root: string | null = null;
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    callee = fn?.text ?? null;
    root = expressionRoot(fn);
  } else if (node.type === "builtin_function") {
    callee = builtinName(node);
    root = callee;
  }
  if (!callee) return null;
  const binding = root?.startsWith("@")
    ? { kind: "unknown" as const, target: null }
    : root
      ? resolve(node, root, chunks)
      : { kind: "unknown" as const, target: null };
  return {
    kind: "call",
    callee,
    binding: binding.kind,
    target: binding.target,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, starts),
  };
}
export function extractZigFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "call_expression" || node.type === "builtin_function") {
      const imported = importFact(node, chunks, starts);
      if (imported) facts.push(imported);
      else {
        const called = callFact(node, chunks, starts);
        if (called) facts.push(called);
      }
    }
  }
  return facts.sort(
    (a, b) =>
      a.startOffset - b.startOffset ||
      a.endOffset - b.endOffset ||
      a.kind.localeCompare(b.kind),
  );
}
