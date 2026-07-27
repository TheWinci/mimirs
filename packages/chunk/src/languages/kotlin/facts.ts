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

interface ImportEntry {
  source: string;
  imported: string;
  local: string | null;
  evidence: SyntaxNode;
}

function importEntry(node: SyntaxNode): ImportEntry | null {
  const path = node.namedChildren.find(
    (child) => child.type === "qualified_identifier",
  );
  if (!path) return null;
  const parts = path.namedChildren
    .filter((child) => child.type === "identifier")
    .map((child) => child.text);
  const wildcard = node.children.some((child) => child.type === "*");
  if (wildcard) {
    return {
      source: parts.join("."),
      imported: "*",
      local: null,
      evidence: node,
    };
  }
  if (parts.length === 0) return null;
  const imported = parts.at(-1)!;
  const alias = node.namedChildren.find(
    (child) => child.type === "identifier" && child.id !== path.id,
  );
  return {
    source: parts.slice(0, -1).join("."),
    imported,
    local: alias?.text ?? imported,
    evidence: node,
  };
}

function importFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact | null {
  const entry = importEntry(node);
  if (!entry) return null;
  return {
    kind: "import",
    source: entry.source,
    imported: entry.imported,
    local: entry.local,
    typeOnly: false,
    static: false,
    global: false,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(entry.evidence, starts),
  };
}

function identifierNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (
    node.type === "parameter" ||
    node.type === "class_parameter" ||
    node.type === "variable_declaration"
  ) {
    const identifier = node.namedChildren.find(
      (child) => child.type === "identifier",
    );
    return identifier ? [identifier.text] : [];
  }
  if (
    node.type === "function_value_parameters" ||
    node.type === "class_parameters" ||
    node.type === "lambda_parameters" ||
    node.type === "multi_variable_declaration"
  ) {
    return node.namedChildren.flatMap(identifierNames);
  }
  return [];
}

function propertyNames(node: SyntaxNode): string[] {
  const declaration = node.namedChildren.find(
    (child) =>
      child.type === "variable_declaration" ||
      child.type === "multi_variable_declaration",
  );
  return identifierNames(declaration ?? null);
}

function declaredChunk(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  kinds: Set<SourceChunk["kind"]>,
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return owner?.name === name && kinds.has(owner.kind) ? owner : null;
}

const TYPE_NODES = new Set([
  "class_declaration",
  "object_declaration",
  "companion_object",
  "type_alias",
]);

function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (node.type === "property_declaration") {
    if (!propertyNames(node).includes(name)) return null;
    const target = declaredChunk(node, name, chunks, new Set(["function"]));
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (node.type === "function_declaration") {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(
      node,
      name,
      chunks,
      new Set(["function", "method"]),
    );
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (TYPE_NODES.has(node.type)) {
    const declared =
      node.childForFieldName("name")?.text ??
      (node.type === "companion_object" ? "(companion)" : null);
    if (declared !== name) return null;
    const target = declaredChunk(
      node,
      name,
      chunks,
      new Set([
        "class",
        "interface",
        "enum",
        "record",
        "annotation_type",
        "type",
      ]),
    );
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (node.type === "import") {
    return importEntry(node)?.local === name
      ? { kind: "import", target: null }
      : null;
  }
  return null;
}

function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "this_expression" || node.type === "super_expression") {
    return node.text;
  }
  if (node.type === "navigation_expression") {
    return expressionRoot(node.namedChildren[0] ?? null);
  }
  if (node.type === "call_expression") {
    return expressionRoot(callCalleeNode(node));
  }
  if (node.type === "parenthesized_expression") {
    return expressionRoot(node.namedChildren[0] ?? null);
  }
  if (node.type === "user_type") {
    return (
      node.namedChildren.find((child) => child.type === "identifier")?.text ??
      null
    );
  }
  return null;
}

function callCalleeNode(node: SyntaxNode): SyntaxNode | null {
  return (
    node.namedChildren.find(
      (child) =>
        child.type !== "value_arguments" &&
        child.type !== "type_arguments" &&
        child.type !== "annotated_lambda",
    ) ?? null
  );
}

function callCallee(
  node: SyntaxNode,
): { callee: string; root: string | null } | null {
  if (node.type === "call_expression") {
    const calleeNode = callCalleeNode(node);
    if (!calleeNode) return null;
    const typeArguments = node.namedChildren.find(
      (child) => child.type === "type_arguments",
    );
    return {
      callee: typeArguments
        ? node.text.slice(0, typeArguments.endIndex - node.startIndex)
        : calleeNode.text,
      root: expressionRoot(calleeNode),
    };
  }
  if (node.type === "constructor_invocation") {
    const type = node.namedChildren.find((child) => child.type === "user_type");
    return type ? { callee: type.text, root: expressionRoot(type) } : null;
  }
  if (node.type === "constructor_delegation_call") {
    const keyword = node.children.find(
      (child) => child.type === "this" || child.type === "super",
    );
    return keyword ? { callee: keyword.text, root: keyword.text } : null;
  }
  return null;
}

const MEMBER_SCOPES = new Set(["class_body", "enum_class_body"]);

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function controlBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
): Binding | null {
  if (scope.type === "for_statement") {
    const declaration = scope.namedChildren.find((child) =>
      child.type === "variable_declaration" ||
      child.type === "multi_variable_declaration"
    );
    const body = scope.namedChildren.at(-1) ?? null;
    if (identifierNames(declaration ?? null).includes(name) && contains(body, call)) {
      return { kind: "local", target: null };
    }
  }
  if (scope.type === "catch_block") {
    const parameter = scope.namedChildren.find((child) => child.type === "identifier");
    const body = scope.namedChildren.find((child) => child.type === "block");
    if (parameter?.text === name && contains(body ?? null, call)) {
      return { kind: "local", target: null };
    }
  }
  if (scope.type === "when_expression") {
    const subject = scope.namedChildren.find((child) => child.type === "when_subject");
    const declaration = subject?.namedChildren.find(
      (child) => child.type === "variable_declaration",
    );
    if (
      identifierNames(declaration ?? null).includes(name) &&
      scope.namedChildren.some((child) => child.type === "when_entry" && contains(child, call))
    ) return { kind: "local", target: null };
  }
  return null;
}

function scopedBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  includeFutureValues: boolean,
): Binding | null {
  const candidates: Binding[] = [];
  for (const child of scope.namedChildren) {
    const hoisted =
      TYPE_NODES.has(child.type) || child.type === "function_declaration";
    if (!hoisted && !includeFutureValues && child.endIndex > call.startIndex)
      continue;
    const binding = declarationBinding(child, name, chunks);
    if (binding) candidates.push(binding);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) return { kind: "local", target: null };
  return null;
}

function resolve(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding {
  if (name === "this" || name === "super") {
    return { kind: "local", target: null };
  }
  let current: SyntaxNode | null = call.parent;
  while (current) {
    const control = controlBinding(current, call, name);
    if (control) return control;
    if (
      current.type === "function_declaration" ||
      current.type === "secondary_constructor" ||
      current.type === "anonymous_function"
    ) {
      const parameters = current.namedChildren.find(
        (child) => child.type === "function_value_parameters",
      );
      if (identifierNames(parameters ?? null).includes(name)) {
        return { kind: "local", target: null };
      }
    }
    if (current.type === "lambda_literal") {
      const parameters = current.namedChildren.find(
        (child) => child.type === "lambda_parameters",
      );
      if (identifierNames(parameters ?? null).includes(name)) {
        return { kind: "local", target: null };
      }
    }
    if (current.type === "setter") {
      const parameter = current.namedChildren.find(
        (child) => child.type === "identifier",
      );
      if ((parameter?.text ?? "value") === name) {
        return { kind: "local", target: null };
      }
    }
    if (current.type === "class_declaration") {
      const constructor = current.namedChildren.find(
        (child) => child.type === "primary_constructor",
      );
      const parameters = constructor?.namedChildren.find(
        (child) => child.type === "class_parameters",
      );
      if (identifierNames(parameters ?? null).includes(name)) {
        return { kind: "local", target: null };
      }
    }
    if (current.type === "block" || current.type === "lambda_literal") {
      const binding = scopedBinding(current, call, name, chunks, false);
      if (binding) return binding;
    } else if (MEMBER_SCOPES.has(current.type)) {
      const binding = scopedBinding(current, call, name, chunks, true);
      if (binding) return binding;
    } else if (current.type === "source_file") {
      const binding = scopedBinding(current, call, name, chunks, false);
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
    node.type === "call_expression" &&
    callCalleeNode(node)?.type === "call_expression"
  )
    return null;
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.type === "annotation") return null;
    ancestor = ancestor.parent;
  }
  const parsed = callCallee(node);
  if (!parsed) return null;
  const binding = parsed.root
    ? resolve(node, parsed.root, chunks)
    : { kind: "unknown" as const, target: null };
  return {
    kind: "call",
    callee: parsed.callee,
    binding: binding.kind,
    target: binding.target,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, starts),
  };
}

const CALL_NODES = new Set([
  "call_expression",
  "constructor_invocation",
  "constructor_delegation_call",
]);

export function extractKotlinFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "import") {
      const fact = importFact(node, chunks, starts);
      if (fact) facts.push(fact);
    } else if (CALL_NODES.has(node.type)) {
      const fact = callFact(node, chunks, starts);
      if (fact) facts.push(fact);
    }
  }
  return facts.sort(
    (left, right) =>
      left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset ||
      left.kind.localeCompare(right.kind),
  );
}
