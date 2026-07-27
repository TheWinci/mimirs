import type { Node as SyntaxNode, Tree } from "web-tree-sitter";

import type {
  CallBindingKind,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
} from "../../types";
import {
  factOwner,
  factOwnerWhere,
  factSpan,
  walkSyntax,
} from "../fact-helpers";

interface ResolvedCallBinding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

function importedName(node: SyntaxNode): SyntaxNode {
  return node.type === "aliased_import"
    ? node.childForFieldName("name") ?? node
    : node;
}

function importedAlias(node: SyntaxNode): SyntaxNode | null {
  return node.type === "aliased_import" ? node.childForFieldName("alias") : null;
}

function moduleBinding(node: SyntaxNode): string {
  return importedAlias(node)?.text ?? importedName(node).text.split(".")[0]!;
}

function namedBinding(node: SyntaxNode): string {
  return importedAlias(node)?.text ?? importedName(node).text;
}

function isTypeOnlyImport(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "if_statement") {
      const condition = current.childForFieldName("condition")?.text;
      const guarded = condition === "TYPE_CHECKING" || condition === "typing.TYPE_CHECKING";
      if (guarded && contains(current.childForFieldName("consequence"), node)) return true;
    }
    current = current.parent;
  }
  return false;
}

function importFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  const typeOnly = isTypeOnlyImport(node);
  return node.namedChildren.map((binding): ImportFact => ({
    kind: "import",
    source: importedName(binding).text,
    imported: "*",
    local: moduleBinding(binding),
    typeOnly,
    static: false,
    global: false,
    owner,
    ...factSpan(binding, lineStarts),
  }));
}

function importFromFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const moduleName = node.childForFieldName("module_name");
  if (!moduleName) return [];
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  const typeOnly = isTypeOnlyImport(node);
  return node.namedChildren
    .filter((binding) => binding.id !== moduleName.id)
    .map((binding): ImportFact => {
      if (binding.type === "wildcard_import") {
        return {
          kind: "import",
          source: moduleName.text,
          imported: "*",
          local: null,
          typeOnly,
          static: false,
          global: false,
          owner,
          ...factSpan(binding, lineStarts),
        };
      }
      return {
        kind: "import",
        source: moduleName.text,
        imported: importedName(binding).text,
        local: namedBinding(binding),
        typeOnly,
        static: false,
        global: false,
        owner,
        ...factSpan(binding, lineStarts),
      };
    });
}

function bindingNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (node.type === "attribute" || node.type === "subscript") return [];
  if (
    node.type === "default_parameter" ||
    node.type === "typed_parameter" ||
    node.type === "typed_default_parameter"
  ) {
    return bindingNames(node.childForFieldName("name") ?? node.namedChildren[0] ?? null);
  }
  return node.namedChildren.flatMap((child) => bindingNames(child));
}

function patternBindingNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "dotted_name") {
    const identifiers = node.namedChildren.filter((child) => child.type === "identifier");
    return identifiers.length === 1 && identifiers[0]?.text !== "_"
      ? [identifiers[0]!.text]
      : [];
  }
  if (node.type === "class_pattern") {
    return node.namedChildren.slice(1).flatMap(patternBindingNames);
  }
  if (node.type === "keyword_pattern") {
    return node.namedChildren.slice(1).flatMap(patternBindingNames);
  }
  if (node.type === "identifier") return node.text === "_" ? [] : [node.text];
  return node.namedChildren.flatMap(patternBindingNames);
}

function importBindings(node: SyntaxNode): string[] {
  if (node.type === "import_statement") return node.namedChildren.map(moduleBinding);
  if (node.type !== "import_from_statement") return [];
  const moduleName = node.childForFieldName("module_name");
  return node.namedChildren
    .filter((binding) => binding.id !== moduleName?.id && binding.type !== "wildcard_import")
    .map(namedBinding);
}

function callableDeclaredBy(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return owner?.name === name && (owner.kind === "function" || owner.kind === "method")
    ? owner
    : null;
}

const COMPREHENSION_NODES = new Set([
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "generator_expression",
]);

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function definitionNode(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "function_definition" || node.type === "class_definition") {
    return node;
  }
  if (node.type !== "decorated_definition") return null;
  return node.namedChildren.find(
    (child) => child.type === "function_definition" || child.type === "class_definition",
  ) ?? null;
}

function directBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (node.type === "import_statement" || node.type === "import_from_statement") {
    return importBindings(node).includes(name) ? { kind: "import", target: null } : null;
  }
  const definition = definitionNode(node);
  if (definition?.type === "function_definition") {
    if (definition.childForFieldName("name")?.text !== name) return null;
    const target = callableDeclaredBy(definition, name, chunks);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (definition?.type === "class_definition") {
    if (definition.childForFieldName("name")?.text !== name) return null;
    const target = factOwner(chunks, definition.startIndex, definition.endIndex);
    return target?.name === name && target.kind === "class"
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (
    node.type === "assignment" || node.type === "augmented_assignment" ||
    node.type === "named_expression"
  ) {
    const left = node.childForFieldName("left") ?? node.childForFieldName("name") ??
      node.namedChildren[0] ?? null;
    if (bindingNames(left).includes(name)) return { kind: "local", target: null };
  }
  if (node.type === "for_statement") {
    if (bindingNames(node.childForFieldName("left")).includes(name)) {
      return { kind: "local", target: null };
    }
  }
  if (node.type === "with_item") {
    const pattern = node.namedChildren.find((child) => child.type === "as_pattern");
    if (bindingNames(pattern?.childForFieldName("alias") ?? null).includes(name)) {
      return { kind: "local", target: null };
    }
  }
  if (node.type === "except_clause") {
    const pattern = node.childForFieldName("value");
    if (
      pattern?.type === "as_pattern" &&
      bindingNames(pattern.childForFieldName("alias")).includes(name)
    ) {
      return { kind: "local", target: null };
    }
  }
  if (node.type === "case_clause") {
    const pattern = node.namedChildren.find((child) => child.type === "case_pattern");
    if (patternBindingNames(pattern ?? null).includes(name)) {
      return { kind: "local", target: null };
    }
  }
  if (
    node.type === "delete_statement" &&
    bindingNames(node).includes(name)
  ) {
    return { kind: "local", target: null };
  }
  return null;
}

function collapseBindings(bindings: ResolvedCallBinding[]): ResolvedCallBinding | null {
  if (bindings.length === 0) return null;
  if (bindings.every((binding) => binding.kind === "import")) {
    return { kind: "import", target: null };
  }
  if (bindings.length === 1 && bindings[0]?.kind === "source-chunk") {
    return bindings[0];
  }
  return { kind: "local", target: null };
}

function scopeBindings(
  scope: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  beforeOffset: number | null,
): ResolvedCallBinding[] {
  const body = scope.type === "module" ? scope : scope.childForFieldName("body");
  if (!body) return [];
  const bindings: ResolvedCallBinding[] = [];
  const stack = [...body.namedChildren].reverse();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (beforeOffset !== null && current.startIndex >= beforeOffset) continue;
    const definition = definitionNode(current);
    if (definition) {
      const binding = directBinding(current, name, chunks);
      if (binding) bindings.push(binding);
      continue;
    }
    if (current.type === "lambda") continue;
    if (COMPREHENSION_NODES.has(current.type)) {
      const comprehensionStack = [...current.namedChildren].reverse();
      while (comprehensionStack.length > 0) {
        const nested = comprehensionStack.pop()!;
        if (nested.type === "lambda") continue;
        const binding = nested.type === "named_expression"
          ? directBinding(nested, name, chunks)
          : null;
        if (binding) bindings.push(binding);
        for (let index = nested.namedChildren.length - 1; index >= 0; index--) {
          comprehensionStack.push(nested.namedChildren[index]!);
        }
      }
      continue;
    }
    const binding = directBinding(current, name, chunks);
    if (binding) bindings.push(binding);
    for (let index = current.namedChildren.length - 1; index >= 0; index--) {
      stack.push(current.namedChildren[index]!);
    }
  }
  return bindings;
}

function scopeDirective(
  functionNode: SyntaxNode,
  name: string,
): "global" | "nonlocal" | null {
  const body = functionNode.childForFieldName("body");
  if (!body) return null;
  const stack = [...body.namedChildren].reverse();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (definitionNode(current) || current.type === "lambda" ||
      COMPREHENSION_NODES.has(current.type)) {
      continue;
    }
    if (
      (current.type === "global_statement" || current.type === "nonlocal_statement") &&
      current.namedChildren.some((child) => child.type === "identifier" && child.text === name)
    ) {
      return current.type === "global_statement" ? "global" : "nonlocal";
    }
    for (let index = current.namedChildren.length - 1; index >= 0; index--) {
      stack.push(current.namedChildren[index]!);
    }
  }
  return null;
}

function comprehensionBinds(
  comprehension: SyntaxNode,
  call: SyntaxNode,
  name: string,
): boolean {
  const containingIndex = comprehension.namedChildren.findIndex((child) =>
    contains(child, call)
  );
  if (containingIndex < 0) return false;
  const visible = containingIndex === 0
    ? comprehension.namedChildren
    : comprehension.namedChildren.slice(0, containingIndex);
  return visible.some((child) =>
    child.type === "for_in_clause" &&
    bindingNames(child.childForFieldName("left")).includes(name)
  );
}

function calleeRoot(callee: SyntaxNode): string | null {
  if (callee.type === "identifier") return callee.text;
  if (callee.type === "attribute" || callee.type === "subscript") {
    const object = callee.childForFieldName("object") ?? callee.namedChildren[0];
    return object ? calleeRoot(object) : null;
  }
  return null;
}

function resolveCallBinding(
  call: SyntaxNode,
  callee: SyntaxNode,
  chunks: SourceChunk[],
): ResolvedCallBinding {
  const name = calleeRoot(callee);
  if (name === null) return { kind: "unknown", target: null };

  let current: SyntaxNode | null = call.parent;
  let crossedFunction = false;
  let globalOnly = false;
  while (current) {
    if (COMPREHENSION_NODES.has(current.type)) {
      if (comprehensionBinds(current, call, name)) {
        return { kind: "local", target: null };
      }
    }
    if (current.type === "lambda" && contains(current.childForFieldName("body"), call)) {
      if (bindingNames(current.childForFieldName("parameters")).includes(name)) {
        return { kind: "local", target: null };
      }
      const binding = collapseBindings(scopeBindings(current, name, chunks, null));
      if (binding) return binding;
      crossedFunction = true;
    }
    if (current.type === "function_definition") {
      if (!contains(current.childForFieldName("body"), call)) {
        current = current.parent;
        continue;
      }
      const directive = scopeDirective(current, name);
      const bindings = scopeBindings(current, name, chunks, null);
      if (directive !== null) {
        const rebound = collapseBindings(bindings);
        if (rebound) return rebound;
        if (directive === "global") globalOnly = true;
        crossedFunction = true;
        current = current.parent;
        continue;
      }
      if (!globalOnly && bindingNames(current.childForFieldName("parameters")).includes(name)) {
        return { kind: "local", target: null };
      }
      if (!globalOnly) {
        const binding = collapseBindings(bindings);
        if (binding) return binding;
      }
      crossedFunction = true;
    }
    if (current.type === "class_definition") {
      if (!crossedFunction && !globalOnly && contains(current.childForFieldName("body"), call)) {
        const binding = collapseBindings(
          scopeBindings(current, name, chunks, call.startIndex),
        );
        if (binding) return binding;
      }
    }
    if (current.type === "module") {
      const binding = collapseBindings(
        scopeBindings(current, name, chunks, call.startIndex),
      );
      if (binding) return binding;
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

function callRunsInsideOwner(call: SyntaxNode, owner: SourceChunkRef): boolean {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (
      current.type === "function_definition" &&
      current.childForFieldName("name")?.text === owner.name
    ) {
      return contains(current.childForFieldName("body"), call);
    }
    if (
      current.type === "class_definition" &&
      current.childForFieldName("name")?.text === owner.name
    ) {
      return contains(current.childForFieldName("body"), call);
    }
    if (current.type === "decorated_definition") {
      const definition = definitionNode(current);
      if (definition?.childForFieldName("name")?.text === owner.name) {
        return contains(definition, call) && contains(definition.childForFieldName("body"), call);
      }
    }
    current = current.parent;
  }
  return true;
}

function callOwner(call: SyntaxNode, chunks: SourceChunk[]): SourceChunkRef | null {
  const owner = factOwner(chunks, call.startIndex, call.endIndex);
  if (!owner || callRunsInsideOwner(call, owner)) return owner;
  return factOwnerWhere(
    chunks,
    call.startIndex,
    call.endIndex,
    (chunk) =>
      chunk.startOffset !== owner.startOffset || chunk.endOffset !== owner.endOffset ||
      chunk.kind !== owner.kind || chunk.name !== owner.name,
  );
}

/** Extract Python imports and calls without inventing implicit export facts. */
export function extractPythonFacts(
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "import_statement") {
      facts.push(...importFacts(node, chunks, lineStarts));
    } else if (node.type === "import_from_statement") {
      facts.push(...importFromFacts(node, chunks, lineStarts));
    } else if (node.type === "call") {
      const callee = node.childForFieldName("function");
      if (callee) {
        const binding = resolveCallBinding(node, callee, chunks);
        facts.push({
          kind: "call",
          callee: callee.text,
          binding: binding.kind,
          target: binding.target,
          owner: callOwner(node, chunks),
          ...factSpan(node, lineStarts),
        });
      }
    }
  }
  return facts.sort(
    (left, right) => left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset || left.kind.localeCompare(right.kind),
  );
}
