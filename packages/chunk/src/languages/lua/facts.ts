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
  const text = node.text;
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  )
    return text.slice(1, -1);
  const long = text.match(/^\[(=*)\[([\s\S]*)\]\1\]$/);
  return long?.[2] ?? null;
}

function callName(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName("name");
}

function loaderReference(
  node: SyntaxNode,
): { source: string; imported: "*" | "dofile" | "loadfile" } | null {
  if (node.type !== "function_call") return null;
  const imported = callName(node)?.text;
  if (!imported || !["require", "dofile", "loadfile"].includes(imported)) {
    return null;
  }
  const argumentsNode = node.childForFieldName("arguments");
  if (!argumentsNode || argumentsNode.namedChildren.length !== 1) return null;
  const source = stringValue(argumentsNode.namedChildren[0] ?? null);
  const kind = imported === "require"
    ? "*"
    : imported === "dofile"
    ? "dofile"
    : "loadfile";
  return source === null
    ? null
    : { source, imported: kind };
}

function requireSource(node: SyntaxNode): string | null {
  const reference = loaderReference(node);
  return reference?.imported === "*" ? reference.source : null;
}

function enclosingAssignment(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (current.type === "assignment_statement") return current;
    if (
      [
        "block",
        "chunk",
        "function_definition",
        "function_declaration",
      ].includes(current.type)
    ) {
      return null;
    }
    current = current.parent;
  }
  return null;
}

function assignedNames(node: SyntaxNode): string[] {
  const assignment =
    node.type === "variable_declaration"
      ? node.namedChildren.find(
          (child) => child.type === "assignment_statement",
        )
      : node;
  const variables = assignment?.namedChildren.find(
    (child) => child.type === "variable_list",
  );
  return variables?.namedChildren.map((child) => child.text) ?? [];
}

function requireLocal(node: SyntaxNode): string | null {
  const assignment = enclosingAssignment(node);
  if (!assignment) return null;
  const values = assignment.namedChildren.find(
    (child) => child.type === "expression_list",
  );
  const index =
    values?.namedChildren.findIndex((child) => child.id === node.id) ?? -1;
  return index >= 0 ? (assignedNames(assignment)[index] ?? null) : null;
}

function importFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact | null {
  const reference = loaderReference(node);
  if (!reference) return null;
  const loader = callName(node)?.text ?? "";
  if (resolve(node, loader, loader, chunks).kind !== "unknown") return null;
  return {
    kind: "import",
    source: reference.source,
    imported: reference.imported,
    local: requireLocal(node),
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

function assignedFunction(node: SyntaxNode, name: string): boolean {
  const assignment =
    node.type === "variable_declaration"
      ? node.namedChildren.find(
          (child) => child.type === "assignment_statement",
        )
      : node;
  const values = assignment?.namedChildren.find(
    (child) => child.type === "expression_list",
  );
  const index = assignedNames(node).indexOf(name);
  return index >= 0 && values?.namedChildren[index]?.type === "function_definition";
}

function assignedRequire(node: SyntaxNode, name: string): boolean {
  const assignment =
    node.type === "variable_declaration"
      ? node.namedChildren.find(
          (child) => child.type === "assignment_statement",
        )
      : node;
  const names = assignedNames(node);
  const values = assignment?.namedChildren.find(
    (child) => child.type === "expression_list",
  );
  const index = names.indexOf(name);
  const value = index >= 0 ? (values?.namedChildren[index] ?? null) : null;
  return value !== null && requireSource(value) !== null;
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
  if (
    node.type === "variable_declaration" ||
    node.type === "assignment_statement"
  ) {
    if (!assignedNames(node).includes(name)) return null;
    if (assignedRequire(node, name)) return { kind: "import", target: null };
    if (assignedFunction(node, name)) {
      const target = declaredChunk(node, name, chunks);
      if (target) return { kind: "source-chunk", target };
    }
    return { kind: "local", target: null };
  }
  return null;
}

function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (
    node.type === "dot_index_expression" ||
    node.type === "method_index_expression"
  ) {
    return expressionRoot(node.childForFieldName("table"));
  }
  if (node.type === "function_call") return expressionRoot(callName(node));
  if (node.type === "parenthesized_expression") {
    return expressionRoot(node.namedChildren[0] ?? null);
  }
  return null;
}

function parameters(node: SyntaxNode): string[] {
  return (
    node
      .childForFieldName("parameters")
      ?.childrenForFieldName("name")
      .map((child) => child.text) ?? []
  );
}

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function scopedBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  const candidates: Binding[] = [];
  for (const child of scope.namedChildren) {
    if (child.endIndex > call.startIndex) continue;
    const binding = declarationBinding(child, name, chunks);
    if (binding) candidates.push(binding);
  }
  return candidates.at(-1) ?? null;
}

function controlBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (scope.type === "for_statement") {
    const clause = scope.childForFieldName("clause") ??
      scope.namedChildren.find((child) =>
        child.type === "for_numeric_clause" || child.type === "for_generic_clause"
      );
    const body = scope.childForFieldName("body") ??
      scope.namedChildren.find((child) => child.type === "block");
    if (contains(body ?? null, call)) {
      if (clause?.type === "for_numeric_clause") {
        const binder = clause.childForFieldName("name");
        if (binder?.text === name) return { kind: "local", target: null };
      }
      if (clause?.type === "for_generic_clause") {
        const names = clause.namedChildren.find(
          (child) => child.type === "variable_list",
        );
        if (names?.childrenForFieldName("name").some((child) => child.text === name)) {
          return { kind: "local", target: null };
        }
      }
    }
  }
  if (scope.type === "repeat_statement") {
    const body = scope.childForFieldName("body") ??
      scope.namedChildren.find((child) => child.type === "block");
    const condition = scope.childForFieldName("condition");
    if (contains(condition, call) && body) {
      return scopedBinding(body, call, name, chunks);
    }
  }
  return null;
}

function recursiveAssignmentBinding(
  functionNode: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  let current = functionNode.parent;
  while (current && !["assignment_statement", "field"].includes(current.type)) {
    if (["block", "chunk"].includes(current.type)) return null;
    current = current.parent;
  }
  if (!current) return null;
  if (current.type === "field") {
    const fieldName = current.childForFieldName("name")?.text;
    if (fieldName !== name) return null;
    const target = declaredChunk(current, name, chunks);
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  return declarationBinding(current, name, chunks);
}

function resolve(
  call: SyntaxNode,
  callee: string,
  root: string | null,
  chunks: SourceChunk[],
): Binding {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    const control = controlBinding(current, call, root ?? callee, chunks);
    if (control) return control;
    if (current.type === "function_declaration") {
      const declared = current.childForFieldName("name")?.text;
      if (declared === callee) {
        const target = declaredChunk(current, callee, chunks);
        if (target) return { kind: "source-chunk", target };
      }
      if (parameters(current).includes(root ?? "")) {
        return { kind: "local", target: null };
      }
      if (
        current.childForFieldName("name")?.type === "method_index_expression" &&
        root === "self"
      )
        return { kind: "local", target: null };
    }
    if (current.type === "function_definition") {
      if (parameters(current).includes(root ?? "")) {
        return { kind: "local", target: null };
      }
      const recursive = recursiveAssignmentBinding(current, callee, chunks);
      if (recursive) return recursive;
    }
    if (current.type === "block" || current.type === "chunk") {
      const exact = scopedBinding(current, call, callee, chunks);
      if (exact) return exact;
      if (root) {
        const binding = scopedBinding(current, call, root, chunks);
        if (binding) return binding;
      }
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
  const name = callName(node);
  if (!name) return null;
  const callee = name.text;
  const binding = resolve(node, callee, expressionRoot(name), chunks);
  return {
    kind: "call",
    callee,
    binding: binding.kind,
    target: binding.target,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, starts),
  };
}

export function extractLuaFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "function_call") {
      const imported = importFact(node, chunks, starts);
      if (imported) facts.push(imported);
      else {
        const called = callFact(node, chunks, starts);
        if (called) facts.push(called);
      }
    }
  }
  return facts.sort(
    (left, right) =>
      left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset ||
      left.kind.localeCompare(right.kind),
  );
}
