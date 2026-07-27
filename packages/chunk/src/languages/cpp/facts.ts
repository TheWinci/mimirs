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

interface BindingCandidate {
  node: SyntaxNode;
  binding: ResolvedCallBinding;
  category: "definition" | "prototype" | "macro" | "value" | "type" | "import";
}

function importFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const aliasName = node.type === "namespace_alias_definition"
    ? node.childForFieldName("name")?.text ?? null
    : null;
  const owner = factOwnerWhere(
    chunks,
    node.startIndex,
    node.endIndex,
    (chunk) => aliasName === null || chunk.kind !== "module" || chunk.name !== aliasName,
  );
  if (node.type === "preproc_include") {
    const source = node.childForFieldName("path")?.text;
    return source ? [{
      kind: "import",
      source,
      imported: null,
      local: null,
      typeOnly: false,
      static: false,
      global: false,
      owner,
      ...factSpan(node, lineStarts),
    }] : [];
  }
  if (node.type === "namespace_alias_definition") {
    const local = node.childForFieldName("name")?.text;
    const source = node.namedChildren.find((child) => child.text !== local)?.text;
    return source && local ? [{
      kind: "import",
      source,
      imported: "*",
      local,
      typeOnly: false,
      static: false,
      global: false,
      owner,
      ...factSpan(node, lineStarts),
    }] : [];
  }
  if (node.type === "using_declaration") {
    const target = node.namedChildren.at(-1)?.text;
    if (!target) return [];
    if (/^using\s+namespace\b/.test(node.text)) {
      return [{
        kind: "import",
        source: target,
        imported: "*",
        local: null,
        typeOnly: false,
        static: false,
        global: false,
        owner,
        ...factSpan(node, lineStarts),
      }];
    }
    const parts = target.split("::");
    const imported = parts.pop()!;
    return [{
      kind: "import",
      source: parts.join("::"),
      imported,
      local: imported,
      typeOnly: false,
      static: false,
      global: false,
      owner,
      ...factSpan(node, lineStarts),
    }];
  }
  return [];
}

function declaratorName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if ([
    "identifier",
    "type_identifier",
    "field_identifier",
    "qualified_identifier",
    "destructor_name",
    "operator_name",
    "template_function",
  ].includes(node.type)) return node.text;
  const declarator = node.childForFieldName("declarator");
  if (declarator) return declaratorName(declarator);
  if (
    node.type === "parenthesized_declarator" || node.type === "reference_declarator" ||
    node.type === "abstract_reference_declarator"
  ) return declaratorName(node.namedChildren[0] ?? null);
  return null;
}

function declaratorIsFunction(node: SyntaxNode): boolean {
  const wrappers: string[] = [];
  let current: SyntaxNode | null = node;
  while (current) {
    if (["function_declarator", "pointer_declarator", "array_declarator"].includes(current.type)) {
      wrappers.push(current.type);
    }
    if (
      current.type === "parenthesized_declarator" || current.type === "reference_declarator"
    ) current = current.namedChildren[0] ?? null;
    else current = current.childForFieldName("declarator");
  }
  return wrappers.at(-1) === "function_declarator";
}

function directDeclarators(node: SyntaxNode): SyntaxNode[] {
  if (node.type === "function_definition") {
    const declarator = node.childForFieldName("declarator");
    return declarator ? [declarator] : [];
  }
  return node.childrenForFieldName("declarator");
}

function declaratorNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "structured_binding_declarator") {
    return node.namedChildren.flatMap((child) => declaratorNames(child));
  }
  const name = declaratorName(node);
  return name ? [name] : [];
}

function matchingDeclarator(node: SyntaxNode, names: string[]): SyntaxNode | null {
  return directDeclarators(node)
    .find((declarator) => declaratorNames(declarator).some((name) => names.includes(name))) ?? null;
}

function templateDeclaration(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((child) => child.type !== "template_parameter_list") ?? null;
}

function declaredName(node: SyntaxNode): string | null {
  if (node.type === "template_declaration") {
    const declaration = templateDeclaration(node);
    if (!declaration) return null;
    return declaration.childForFieldName("name")?.text ??
      directDeclarators(declaration).map(declaratorName).find(Boolean) ?? null;
  }
  if (node.type === "namespace_definition" || node.type === "namespace_alias_definition") {
    return node.childForFieldName("name")?.text ?? "(anonymous)";
  }
  if (node.type === "alias_declaration") return node.childForFieldName("name")?.text ?? null;
  if (node.type === "preproc_def" || node.type === "preproc_function_def") {
    return node.childForFieldName("name")?.text ?? null;
  }
  const names = directDeclarators(node)
    .map(declaratorName)
    .filter((name): name is string => name !== null);
  return names.length > 0 ? names.join(", ") : node.childForFieldName("name")?.text ?? null;
}

function parameterBindings(node: SyntaxNode): string[] {
  let parameters: SyntaxNode | null = null;
  if (node.type === "lambda_expression") {
    parameters = node.childForFieldName("declarator")?.childForFieldName("parameters") ?? null;
  } else {
    let declarator = node.childForFieldName("declarator");
    while (declarator && declarator.type !== "function_declarator") {
      declarator = declarator.type === "parenthesized_declarator"
        ? declarator.namedChildren[0] ?? null
        : declarator.childForFieldName("declarator") ?? declarator.namedChildren[0] ?? null;
    }
    parameters = declarator?.childForFieldName("parameters") ?? null;
  }
  if (!parameters) return [];
  return parameters.namedChildren.flatMap((parameter) => {
    if (parameter.type !== "parameter_declaration") return [];
    const name = declaratorName(parameter.childForFieldName("declarator"));
    return name ? [name] : [];
  });
}

function declaredChunk(
  node: SyntaxNode,
  names: string[],
  chunks: SourceChunk[],
  kinds: ReadonlySet<SourceChunk["kind"]>,
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return owner && names.includes(owner.name) && kinds.has(owner.kind) ? owner : null;
}

const CALLABLE_KINDS = new Set<SourceChunk["kind"]>(["function", "method", "macro"]);
const TYPE_KINDS = new Set<SourceChunk["kind"]>([
  "class",
  "struct",
  "enum",
  "type",
  "module",
]);
const TYPE_NODES = new Set([
  "class_specifier",
  "struct_specifier",
  "union_specifier",
  "enum_specifier",
  "alias_declaration",
  "type_definition",
  "namespace_definition",
]);

function usingBinding(node: SyntaxNode, name: string): ResolvedCallBinding | null {
  if (node.type === "namespace_alias_definition") {
    return node.childForFieldName("name")?.text === name
      ? { kind: "import", target: null }
      : null;
  }
  if (node.type !== "using_declaration" || /^using\s+namespace\b/.test(node.text)) return null;
  const target = node.namedChildren.at(-1)?.text;
  return target?.split("::").at(-1) === name ? { kind: "import", target: null } : null;
}

function typeBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  const imported = usingBinding(node, name);
  if (imported) return imported;
  if (node.type === "template_declaration") {
    const declaration = templateDeclaration(node);
    if (!declaration || declaration.type === "function_definition") return null;
  } else if (!TYPE_NODES.has(node.type)) {
    return null;
  }
  if (declaredName(node) !== name) return null;
  const target = declaredChunk(node, [name], chunks, TYPE_KINDS);
  return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
}

function valueDeclarationBinding(
  node: SyntaxNode,
  names: string[],
  chunks: SourceChunk[],
): BindingCandidate | null {
  if (node.type === "declaration" || node.type === "field_declaration") {
    const declarator = matchingDeclarator(node, names);
    if (!declarator) return null;
    const name = declaratorNames(declarator).find((candidate) => names.includes(candidate))!;
    if (declaratorIsFunction(declarator)) {
      const target = declaredChunk(node, [name], chunks, CALLABLE_KINDS);
      return {
        node,
        binding: target
          ? { kind: "source-chunk", target }
          : { kind: "local", target: null },
        category: "prototype",
      };
    }
    const target = declaredChunk(node, [name], chunks, new Set(["function"]));
    return {
      node,
      binding: target
        ? { kind: "source-chunk", target }
        : { kind: "local", target: null },
      category: "value",
    };
  }
  if (node.type === "expression_statement") {
    const expression = node.namedChildren[0] ?? null;
    if (expression?.type !== "assignment_expression") return null;
    const left = expression.childForFieldName("left");
    if (left?.type !== "identifier" || !names.includes(left.text)) return null;
    return {
      node,
      binding: { kind: "local", target: null },
      category: "value",
    };
  }
  if (node.type === "function_definition") {
    const name = declaredName(node);
    if (!name || !names.includes(name)) return null;
    const target = declaredChunk(node, [name], chunks, CALLABLE_KINDS);
    return {
      node,
      binding: target
        ? { kind: "source-chunk", target }
        : { kind: "local", target: null },
      category: "definition",
    };
  }
  if (node.type === "template_declaration") {
    const declaration = templateDeclaration(node);
    if (declaration?.type !== "function_definition") return null;
    const name = declaredName(node);
    if (!name || !names.includes(name)) return null;
    const target = declaredChunk(node, [name], chunks, CALLABLE_KINDS);
    return {
      node,
      binding: target
        ? { kind: "source-chunk", target }
        : { kind: "local", target: null },
      category: "definition",
    };
  }
  if (node.type === "preproc_def" || node.type === "preproc_function_def") {
    const name = node.childForFieldName("name")?.text;
    if (!name || !names.includes(name)) return null;
    const target = declaredChunk(node, [name], chunks, CALLABLE_KINDS);
    return {
      node,
      binding: target
        ? { kind: "source-chunk", target }
        : { kind: "local", target: null },
      category: "macro",
    };
  }
  const imported = usingBinding(node, names[0]!);
  if (imported) return { node, binding: imported, category: "import" };
  const type = typeBinding(node, names[0]!, chunks);
  return type ? { node, binding: type, category: "type" } : null;
}

function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if ([
    "identifier",
    "field_identifier",
    "type_identifier",
    "namespace_identifier",
    "this",
  ].includes(node.type)) return node.text;
  if (node.type === "qualified_identifier") {
    return expressionRoot(node.childForFieldName("scope"));
  }
  if (node.type === "template_function") {
    return node.childForFieldName("name")?.text ?? null;
  }
  if (node.type === "field_expression") {
    return expressionRoot(node.childForFieldName("argument"));
  }
  if (node.type === "pointer_expression") {
    return expressionRoot(node.childForFieldName("argument"));
  }
  if (node.type === "parenthesized_expression") {
    return expressionRoot(node.namedChildren[0] ?? null);
  }
  if (node.type === "subscript_expression") {
    return expressionRoot(node.childForFieldName("argument"));
  }
  return null;
}

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function visibleBeforeCall(node: SyntaxNode, call: SyntaxNode): boolean {
  if (node.endIndex <= call.startIndex) return true;
  if (node.type === "function_definition") {
    return contains(node.childForFieldName("body"), call);
  }
  if (node.type === "template_declaration") {
    const declaration = templateDeclaration(node);
    return declaration?.type === "function_definition" &&
      contains(declaration.childForFieldName("body"), call);
  }
  if (["class_specifier", "struct_specifier", "union_specifier"].includes(node.type)) {
    return contains(node.childForFieldName("body"), call);
  }
  return false;
}

function nestedDeclarationBinding(
  node: SyntaxNode | null,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (!node) return null;
  const direct = valueDeclarationBinding(node, [name], chunks);
  if (direct) return direct.binding;
  for (const child of node.namedChildren) {
    const binding = valueDeclarationBinding(child, [name], chunks);
    if (binding) return binding.binding;
  }
  return null;
}

function controlBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (scope.type === "for_statement") {
    const initializer = scope.childForFieldName("initializer");
    if (initializer && initializer.endIndex <= call.startIndex) {
      return nestedDeclarationBinding(initializer, name, chunks);
    }
  }
  if (scope.type === "for_range_loop") {
    const body = scope.childForFieldName("body");
    const declarator = scope.childForFieldName("declarator");
    if (contains(body, call) && declaratorNames(declarator).includes(name)) {
      return { kind: "local", target: null };
    }
  }
  if (["if_statement", "switch_statement", "while_statement"].includes(scope.type)) {
    const condition = scope.childForFieldName("condition");
    if (condition) {
      const candidates = [
        condition.childForFieldName("initializer"),
        condition.childForFieldName("value"),
      ];
      for (const candidate of candidates) {
        if (candidate && candidate.endIndex <= call.startIndex) {
          const binding = nestedDeclarationBinding(candidate, name, chunks);
          if (binding) return binding;
        }
      }
    }
  }
  if (scope.type === "catch_clause" && contains(scope.childForFieldName("body"), call)) {
    const parameters = scope.childForFieldName("parameters");
    for (const parameter of parameters?.namedChildren ?? []) {
      if (declaratorNames(parameter.childForFieldName("declarator")).includes(name)) {
        return { kind: "local", target: null };
      }
    }
  }
  return null;
}

function insideDeclaration(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "declaration" || current.type === "field_declaration") return true;
    if (current.type === "function_definition") return false;
    current = current.parent;
  }
  return false;
}

function callOwner(call: SyntaxNode, chunks: SourceChunk[]): SourceChunkRef | null {
  const owner = factOwner(chunks, call.startIndex, call.endIndex);
  if (owner?.kind !== "variable" || insideDeclaration(call)) return owner;
  return factOwnerWhere(
    chunks,
    call.startIndex,
    call.endIndex,
    (chunk) =>
      chunk.kind !== owner.kind || chunk.name !== owner.name ||
      chunk.startOffset !== owner.startOffset || chunk.endOffset !== owner.endOffset,
  );
}

function activeScopeBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  names: string[],
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  const candidates: BindingCandidate[] = [];
  for (const child of scope.namedChildren) {
    if (!visibleBeforeCall(child, call)) continue;
    if (
      child.type === "preproc_call" &&
      child.childForFieldName("directive")?.text === "#undef" &&
      names.includes(child.childForFieldName("argument")?.text.trim() ?? "")
    ) {
      for (let index = candidates.length - 1; index >= 0; index--) {
        if (candidates[index]!.category === "macro") candidates.splice(index, 1);
      }
      continue;
    }
    const candidate = valueDeclarationBinding(child, names, chunks);
    if (candidate) candidates.push(candidate);
  }
  const macro = candidates.filter((candidate) => candidate.category === "macro").at(-1);
  if (macro) return macro.binding;
  const value = candidates.filter((candidate) => candidate.category === "value").at(-1);
  if (value) return value.binding;
  const definitions = candidates.filter((candidate) => candidate.category === "definition");
  if (definitions.length === 1) return definitions[0]!.binding;
  if (definitions.length > 1) return { kind: "local", target: null };
  const prototypes = candidates.filter((candidate) => candidate.category === "prototype");
  if (prototypes.length === 1) return prototypes[0]!.binding;
  if (prototypes.length > 1) return { kind: "local", target: null };
  return candidates.at(-1)?.binding ?? null;
}

function memberBinding(
  body: SyntaxNode,
  names: string[],
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  const candidates = body.namedChildren
    .map((child) => valueDeclarationBinding(child, names, chunks))
    .filter((candidate): candidate is BindingCandidate => candidate !== null);
  const callables = candidates.filter(
    (candidate) => candidate.category === "definition" || candidate.category === "prototype",
  );
  if (callables.length === 1) return callables[0]!.binding;
  if (callables.length > 1) return { kind: "local", target: null };
  return candidates.find((candidate) => candidate.category === "value")?.binding ?? null;
}

function enclosingParameterBinding(node: SyntaxNode, name: string): boolean {
  return (node.type === "function_definition" || node.type === "lambda_expression") &&
    parameterBindings(node).includes(name);
}

function resolveUnqualifiedCall(
  call: SyntaxNode,
  names: string[],
  chunks: SourceChunk[],
): ResolvedCallBinding {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    for (const name of names) {
      const binding = controlBinding(current, call, name, chunks);
      if (binding) return binding;
    }
    if (names.some((name) => enclosingParameterBinding(current!, name))) {
      return { kind: "local", target: null };
    }
    if (current.type === "compound_statement") {
      for (let index = current.namedChildren.length - 1; index >= 0; index--) {
        const child = current.namedChildren[index]!;
        if (child.endIndex > call.startIndex) continue;
        const candidate = valueDeclarationBinding(child, names, chunks);
        if (candidate) return candidate.binding;
      }
    } else if (current.type === "field_declaration_list") {
      const binding = memberBinding(current, names, chunks);
      if (binding) return binding;
    } else if (
      current.type === "translation_unit" || current.type === "declaration_list" ||
      current.type === "preproc_if" || current.type === "preproc_ifdef" ||
      current.type === "preproc_elif" || current.type === "preproc_else"
    ) {
      const binding = activeScopeBinding(current, call, names, chunks);
      if (binding) return binding;
    }
    if (current.type === "preproc_else" || current.type === "preproc_elif") {
      current = current.parent?.parent ?? current.parent;
      continue;
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

function resolveValueBinding(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding {
  if (name === "this") return { kind: "local", target: null };
  let current: SyntaxNode | null = call.parent;
  while (current) {
    const control = controlBinding(current, call, name, chunks);
    if (control) return control;
    if (enclosingParameterBinding(current, name)) return { kind: "local", target: null };
    if (current.type === "compound_statement") {
      for (let index = current.namedChildren.length - 1; index >= 0; index--) {
        const child = current.namedChildren[index]!;
        if (child.endIndex > call.startIndex) continue;
        const candidate = valueDeclarationBinding(child, [name], chunks);
        if (candidate) return candidate.binding;
      }
    } else if (current.type === "field_declaration_list") {
      const binding = memberBinding(current, [name], chunks);
      if (binding) return binding;
    } else if (
      current.type === "translation_unit" || current.type === "declaration_list" ||
      current.type === "preproc_if" || current.type === "preproc_ifdef" ||
      current.type === "preproc_elif" || current.type === "preproc_else"
    ) {
      const binding = activeScopeBinding(current, call, [name], chunks);
      if (binding) return binding;
    }
    if (current.type === "preproc_else" || current.type === "preproc_elif") {
      current = current.parent?.parent ?? current.parent;
      continue;
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

function callFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact | null {
  let callee: string | null = null;
  let binding: ResolvedCallBinding = { kind: "unknown", target: null };
  if (node.type === "call_expression") {
    const functionNode = node.childForFieldName("function");
    if (!functionNode) return null;
    callee = functionNode.text;
    if (["identifier", "field_identifier", "template_function"].includes(functionNode.type)) {
      const names = [callee];
      const base = expressionRoot(functionNode);
      if (base && base !== callee) names.push(base);
      for (const name of names) {
        const resolved = resolveUnqualifiedCall(node, [name], chunks);
        if (resolved.kind !== "unknown") {
          binding = resolved;
          break;
        }
      }
    } else {
      const root = expressionRoot(functionNode);
      if (root) binding = resolveValueBinding(node, root, chunks);
    }
  } else if (node.type === "new_expression") {
    const type = node.childForFieldName("type");
    callee = type?.text ?? null;
    const root = expressionRoot(type);
    if (root) binding = resolveValueBinding(node, root, chunks);
  }
  if (!callee) return null;
  return {
    kind: "call",
    callee,
    binding: binding.kind,
    target: binding.target,
    owner: callOwner(node, chunks),
    ...factSpan(node, lineStarts),
  };
}

/** Extract C++ includes, using declarations, namespace aliases, and calls without lookup inference. */
export function extractCppFacts(
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (["preproc_include", "using_declaration", "namespace_alias_definition"].includes(node.type)) {
      facts.push(...importFact(node, chunks, lineStarts));
    } else if (node.type === "call_expression" || node.type === "new_expression") {
      const fact = callFact(node, chunks, lineStarts);
      if (fact) facts.push(fact);
    }
  }
  return facts.sort(
    (left, right) => left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset || left.kind.localeCompare(right.kind),
  );
}
