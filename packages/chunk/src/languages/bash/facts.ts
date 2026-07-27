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

function commandName(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName("name");
}
function literal(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "word" && node.namedChildren.length === 0) return node.text;
  if (
    node.type === "string" &&
    node.namedChildren.every((child) => child.type === "string_content")
  )
    return node.text.slice(1, -1);
  if (node.type === "raw_string") return node.text.slice(1, -1);
  return null;
}
function sourcePath(node: SyntaxNode): string | null {
  const name = commandName(node)?.text;
  if (name !== "source" && name !== ".") return null;
  const nameNode = commandName(node);
  const argument = node.namedChildren.find(
    (child) =>
      child.id !== nameNode?.id && child.type !== "variable_assignment",
  );
  return literal(argument ?? null);
}
function importFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact | null {
  const source = sourcePath(node);
  if (source === null) return null;
  const name = commandName(node)?.text ?? "source";
  if (resolve(node, name, chunks, false).kind !== "unknown") return null;
  return {
    kind: "import",
    source,
    imported: name,
    local: null,
    typeOnly: false,
    static: false,
    global: false,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, starts),
  };
}
function variableName(node: SyntaxNode): string | null {
  if (node.type === "variable_name") return node.text;
  return (
    node.childForFieldName("name")?.text ??
    node.namedChildren.find((child) => child.type === "variable_name")?.text ??
    null
  );
}
function declaredChunk(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return owner?.name === name && owner.kind === "function" ? owner : null;
}
function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  includeVariables: boolean,
): Binding | null {
  if (
    node.type === "function_definition" &&
    node.childForFieldName("name")?.text === name
  ) {
    const target = declaredChunk(node, name, chunks);
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (
    includeVariables && node.type === "variable_assignment" &&
    variableName(node) === name
  )
    return { kind: "local", target: null };
  if (includeVariables && node.type === "declaration_command") {
    const variable = node.namedChildren.find(
      (child) =>
        (child.type === "variable_assignment" || child.type === "variable_name") &&
        variableName(child) === name,
    );
    if (variable) return { kind: "local", target: null };
  }
  return null;
}
function expansionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "variable_name") return node.text;
  for (const child of node.namedChildren) {
    const root = expansionRoot(child);
    if (root) return root;
  }
  return null;
}
const SCOPES = new Set([
  "program",
  "compound_statement",
  "do_group",
  "subshell",
  "command_substitution",
  "if_statement",
]);

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function controlBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
): Binding | null {
  if (scope.type !== "for_statement") return null;
  const variable = scope.childForFieldName("variable");
  const body = scope.childForFieldName("body") ??
    scope.namedChildren.find((child) => child.type === "do_group");
  return variable?.text === name && contains(body ?? null, call)
    ? { kind: "local", target: null }
    : null;
}
function scopedBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  includeVariables: boolean,
): Binding | null {
  const found: Binding[] = [];
  for (const child of scope.namedChildren) {
    if (child.endIndex > call.startIndex) continue;
    if (
      includeVariables &&
      child.type === "for_statement" &&
      child.childForFieldName("variable")?.text === name
    ) {
      found.push({ kind: "local", target: null });
      continue;
    }
    const binding = declarationBinding(child, name, chunks, includeVariables);
    if (binding) found.push(binding);
  }
  return found.at(-1) ?? null;
}

const PROCESS_BOUNDARIES = new Set([
  "function_definition",
  "subshell",
  "command_substitution",
  "process_substitution",
  "pipeline",
]);

function recursiveVariableBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
): Binding | null {
  let latest = -1;
  const stack = [...scope.namedChildren].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (PROCESS_BOUNDARIES.has(node.type)) continue;
    if (
      node.type === "variable_assignment" &&
      node.parent?.type !== "command" &&
      node.parent?.type !== "declaration_command" &&
      variableName(node) === name &&
      node.endIndex <= call.startIndex
    ) latest = Math.max(latest, node.endIndex);
    if (
      node.type === "declaration_command" &&
      node.namedChildren.some((child) =>
        (child.type === "variable_assignment" || child.type === "variable_name") &&
        variableName(child) === name
      ) &&
      node.endIndex <= call.startIndex
    ) latest = Math.max(latest, node.endIndex);
    if (node.type === "for_statement") {
      const body = node.childForFieldName("body") ??
        node.namedChildren.find((child) => child.type === "do_group");
      const visibleAt = body?.startIndex ?? node.endIndex;
      if (
        node.childForFieldName("variable")?.text === name &&
        visibleAt <= call.startIndex
      ) latest = Math.max(latest, visibleAt);
    }
    for (let index = node.namedChildren.length - 1; index >= 0; index--) {
      stack.push(node.namedChildren[index]!);
    }
  }
  return latest >= 0 ? { kind: "local", target: null } : null;
}
function resolve(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  includeVariables: boolean,
): Binding {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    const control = includeVariables
      ? controlBinding(current, call, name)
      : null;
    if (control) return control;
    if (
      current.type === "function_definition" &&
      current.childForFieldName("name")?.text === name
    ) {
      const target = declaredChunk(current, name, chunks);
      if (target) return { kind: "source-chunk", target };
    }
    if (SCOPES.has(current.type)) {
      const binding = scopedBinding(
        current,
        call,
        name,
        chunks,
        includeVariables,
      );
      if (binding) return binding;
      if (includeVariables) {
        const recursive = recursiveVariableBinding(current, call, name);
        if (recursive) return recursive;
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
  const nameNode = commandName(node);
  if (!nameNode) return null;
  const callee = nameNode.text;
  const expandedRoot = expansionRoot(nameNode);
  const root =
    expandedRoot ??
    (nameNode.namedChildren.length === 1 &&
    nameNode.namedChildren[0]?.type === "word"
      ? nameNode.text
      : null);
  const binding = root
    ? resolve(node, root, chunks, expandedRoot !== null)
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
export function extractBashFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "command") {
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
