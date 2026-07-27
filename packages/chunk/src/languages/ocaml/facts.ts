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

interface Binding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

function path(node: SyntaxNode | null): string | null {
  return node?.text ?? null;
}

function importFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact | null {
  let source: string | null = null;
  let imported: string | null = null;
  let local: string | null = null;
  if (node.type === "open_module" || node.type === "include_module") {
    source = path(node.childForFieldName("module"));
    imported = node.type === "open_module" ? "open" : "include";
  } else if (node.type === "include_module_type") {
    const moduleType = node.childForFieldName("module_type");
    source = path(moduleType?.childForFieldName("module") ?? moduleType);
    imported = "include";
  } else if (node.type === "local_open_expression") {
    source = path(
      node.namedChildren.find((child) => child.type === "module_path") ?? null,
    );
    imported = "open";
  } else if (node.type === "module_definition") {
    const binding = node.namedChildren.find(
      (child) => child.type === "module_binding",
    );
    const body = binding?.childForFieldName("body");
    if (body?.type !== "module_path") return null;
    source = body.text;
    imported = "module";
    local =
      binding?.namedChildren.find((child) => child.type === "module_name")
        ?.text ?? null;
  }
  if (!source || !imported) return null;
  const owner =
    node.type === "module_definition" && local
      ? findOwnerSkippingModule(chunks, node.startIndex, node.endIndex, local)
      : factOwner(chunks, node.startIndex, node.endIndex);
  return {
    kind: "import",
    source,
    imported,
    local,
    typeOnly: false,
    static: false,
    global: false,
    owner,
    ...factSpan(node, starts),
  };
}

function findOwnerSkippingModule(
  chunks: SourceChunk[],
  start: number,
  end: number,
  moduleName: string,
): SourceChunkRef | null {
  return factOwnerWhere(
    chunks,
    start,
    end,
    (chunk) => chunk.kind !== "module" || chunk.name !== moduleName,
  );
}

function patternNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (
    ["value_name", "value_pattern"].includes(node.type) &&
    node.namedChildren.length === 0 &&
    node.text !== "_"
  )
    return [node.text];
  return node.namedChildren.flatMap(patternNames);
}

function bindingNames(node: SyntaxNode): string[] {
  return patternNames(node.childForFieldName("pattern"));
}

function definitionBindings(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === "let_binding");
}

function recursiveDefinition(node: SyntaxNode): boolean {
  return node.children.some((child) => child.type === "rec");
}

function ownerTarget(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return owner?.kind === "function" && owner.name?.split(", ").includes(name)
    ? owner
    : null;
}

function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (node.type === "value_definition") {
    for (const binding of definitionBindings(node)) {
      if (!bindingNames(binding).includes(name)) continue;
      const callable =
        binding.namedChildren.some((child) => child.type === "parameter") ||
        binding.childForFieldName("body")?.type === "fun_expression";
      const target = callable ? ownerTarget(node, name, chunks) : null;
      return target
        ? { kind: "source-chunk", target }
        : { kind: "local", target: null };
    }
  }
  if (node.type === "external" && node.namedChildren[0]?.text === name) {
    const target = factOwner(chunks, node.startIndex, node.endIndex);
    return target?.kind === "function"
      ? { kind: "source-chunk", target }
      : { kind: "unknown", target: null };
  }
  if (node.type === "class_definition") {
    const declared = node.namedChildren
      .find((child) => child.type === "class_binding")
      ?.namedChildren.find((child) => child.type === "class_name")?.text;
    if (declared === name) {
      const target = factOwner(chunks, node.startIndex, node.endIndex);
      return target?.kind === "class"
        ? { kind: "source-chunk", target }
        : { kind: "unknown", target: null };
    }
  }
  if (node.type === "module_definition") {
    const imported = importFact(node, chunks, [0]);
    if (imported?.local === name) return { kind: "import", target: null };
  }
  return null;
}

function parameterNames(node: SyntaxNode): string[] {
  return node.namedChildren
    .filter((child) => child.type === "parameter")
    .flatMap((parameter) =>
      patternNames(parameter.childForFieldName("pattern")),
    );
}

function lexicalBinding(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (
      ["let_binding", "fun_expression", "method_definition"].includes(
        current.type,
      )
    ) {
      if (parameterNames(current).includes(name))
        return { kind: "local", target: null };
    }
    if (current.type === "match_case") {
      const pattern = current.childForFieldName("pattern");
      if (patternNames(pattern).includes(name)) {
        return { kind: "local", target: null };
      }
    }
    if (
      current.type === "for_expression" &&
      current.childForFieldName("name")?.text === name
    ) {
      let scope: SyntaxNode | null = call.parent;
      while (scope && scope.parent?.id !== current.id) scope = scope.parent;
      if (scope?.type === "do_clause") return { kind: "local", target: null };
    }
    if (current.type === "let_expression") {
      for (const definition of current.namedChildren.filter(
        (child) => child.type === "value_definition",
      )) {
        const insideDefinition =
          definition.startIndex <= call.startIndex &&
          definition.endIndex >= call.endIndex;
        if (insideDefinition && !recursiveDefinition(definition)) continue;
        const binding = declarationBinding(definition, name, chunks);
        if (binding) return binding;
      }
    }
    if (current.type === "let_module_expression") {
      const definition = current.namedChildren.find(
        (child) => child.type === "module_definition",
      );
      if (definition) {
        const binding = declarationBinding(definition, name, chunks);
        if (binding) return binding;
      }
    }
    current = current.parent;
  }
  return null;
}

function constructorTargets(
  root: SyntaxNode,
  chunks: SourceChunk[],
): Map<string, SourceChunkRef[]> {
  const targets = new Map<string, SourceChunkRef[]>();
  for (const definition of walkSyntax(root)) {
    if (definition.type !== "type_definition") continue;
    const target = factOwner(chunks, definition.startIndex, definition.endIndex);
    if (!target || target.kind !== "type") continue;
    for (const declaration of walkSyntax(definition)) {
      if (declaration.type !== "constructor_declaration") continue;
      const name = declaration.childForFieldName("name")?.text ??
        declaration.namedChildren.find((child) => child.type === "constructor_name")?.text;
      if (!name) continue;
      const existing = targets.get(name) ?? [];
      if (!existing.some((candidate) => candidate.startOffset === target.startOffset)) {
        existing.push(target);
      }
      targets.set(name, existing);
    }
  }
  return targets;
}

function topLevelBinding(
  root: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  const values: Binding[] = [];
  for (const node of root.namedChildren) {
    if (node.startIndex > call.startIndex) continue;
    const insideDefinition =
      node.type === "value_definition" &&
      node.startIndex <= call.startIndex &&
      node.endIndex >= call.endIndex;
    if (insideDefinition && !recursiveDefinition(node)) continue;
    const binding = declarationBinding(node, name, chunks);
    if (binding) values.push(binding);
  }
  return values.length === 1 ? values[0]! : null;
}

function calleeRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "method_invocation") {
    return calleeRoot(node.childForFieldName("object"));
  }
  if (
    ["value_path", "module_path", "constructor_path", "class_path"].includes(
      node.type,
    )
  ) {
    return node.text.split(/[.#]/)[0] ?? null;
  }
  if (
    ["value_name", "module_name", "constructor_name", "class_name"].includes(
      node.type,
    )
  )
    return node.text;
  return (
    node.namedChildren.flatMap((child) => calleeRoot(child) ?? []).at(0) ?? null
  );
}

function resolve(
  node: SyntaxNode,
  root: string | null,
  tree: Tree,
  chunks: SourceChunk[],
  constructors: Map<string, SourceChunkRef[]>,
): Binding {
  if (!root) return { kind: "unknown", target: null };
  const lexical = lexicalBinding(node, root, chunks);
  if (lexical) return lexical;
  const targets = constructors.get(root) ?? [];
  if (targets.length > 0) {
    return targets.length === 1
      ? { kind: "source-chunk", target: targets[0]! }
      : { kind: "unknown", target: null };
  }
  return (
    topLevelBinding(tree.rootNode, node, root, chunks) ?? {
      kind: "unknown",
      target: null,
    }
  );
}

function applicationCallee(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName("function");
}

export function extractOcamlFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  const constructors = constructorTargets(tree.rootNode, chunks);
  for (const node of walkSyntax(tree.rootNode)) {
    if (
      [
        "open_module",
        "include_module",
        "include_module_type",
        "local_open_expression",
        "module_definition",
      ].includes(node.type)
    ) {
      const imported = importFact(node, chunks, starts);
      if (imported) facts.push(imported);
    }
    if (node.type === "application_expression") {
      const parentFunction =
        node.parent?.type === "application_expression"
          ? node.parent.childForFieldName("function")
          : null;
      if (parentFunction?.id !== node.id) {
        const callee = applicationCallee(node);
        const binding = resolve(
          node,
          calleeRoot(callee),
          tree,
          chunks,
          constructors,
        );
        facts.push({
          kind: "call",
          callee: callee?.text ?? node.text,
          binding: binding.kind,
          target: binding.target,
          owner: factOwner(chunks, node.startIndex, node.endIndex),
          ...factSpan(node, starts),
        });
      }
    }
    if (node.type === "infix_expression") {
      const operator = node.childForFieldName("operator");
      if (operator) {
        const binding = resolve(
          node,
          operator.text,
          tree,
          chunks,
          constructors,
        );
        facts.push({
          kind: "call",
          callee: operator.text,
          binding: binding.kind,
          target: binding.target,
          owner: factOwner(chunks, node.startIndex, node.endIndex),
          ...factSpan(node, starts),
        });
      }
    }
    if (node.type === "module_application") {
      const callee = node.childForFieldName("functor");
      const binding = resolve(
        node,
        calleeRoot(callee),
        tree,
        chunks,
        constructors,
      );
      facts.push({
        kind: "call",
        callee: callee?.text ?? node.text,
        binding: binding.kind,
        target: binding.target,
        owner: factOwner(chunks, node.startIndex, node.endIndex),
        ...factSpan(node, starts),
      });
    }
    if (node.type === "new_expression") {
      const callee =
        node.namedChildren.find((child) => child.type === "class_path") ?? null;
      const binding = resolve(
        node,
        calleeRoot(callee),
        tree,
        chunks,
        constructors,
      );
      facts.push({
        kind: "call",
        callee: callee?.text ?? node.text,
        binding: binding.kind,
        target: binding.target,
        owner: factOwner(chunks, node.startIndex, node.endIndex),
        ...factSpan(node, starts),
      });
    }
  }
  return facts.sort(
    (a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset,
  );
}
