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
  syntaxDescendants,
  walkSyntax,
} from "../fact-helpers";

interface ResolvedCallBinding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

interface CSharpUsing {
  source: string;
  local: string | null;
  static: boolean;
  global: boolean;
}

function usingValue(node: SyntaxNode): CSharpUsing | null {
  const local = node.childForFieldName("name")?.text ?? null;
  const candidates = node.namedChildren.filter((child) => child.id !== node.childForFieldName("name")?.id);
  const source = candidates.at(-1)?.text;
  if (!source) return null;
  return {
    source,
    local,
    static: node.children.some((child) => child.type === "static"),
    global: node.children.some((child) => child.type === "global"),
  };
}

function importFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const value = usingValue(node);
  if (!value) return [];
  return [{
    kind: "import",
    source: value.source,
    imported: "*",
    local: value.local,
    typeOnly: false,
    static: value.static,
    global: value.global,
    owner: factOwnerWhere(
      chunks,
      node.startIndex,
      node.endIndex,
      (chunk) => value.local === null || chunk.kind !== "import" || chunk.name !== value.local,
    ),
    ...factSpan(node, lineStarts),
  }];
}

function parameterBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "implicit_parameter") return [node.text];
  if (node.type === "parameter") {
    const name = node.childForFieldName("name");
    return name ? [name.text] : [];
  }
  if (node.type === "parameter_list") return node.namedChildren.flatMap(parameterBindings);
  return [];
}

function variableDeclarators(node: SyntaxNode): SyntaxNode[] {
  const declaration = node.type === "variable_declaration"
    ? node
    : node.namedChildren.find((child) => child.type === "variable_declaration");
  return declaration?.namedChildren.filter((child) => child.type === "variable_declarator") ?? [];
}

function bindingNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (node.type === "tuple_pattern") {
    return node.namedChildren.flatMap((child) => bindingNames(child));
  }
  const names = node.childrenForFieldName("name").flatMap((child) => bindingNames(child));
  if (names.length > 0) return names;
  if (node.type === "variable_declarator") {
    return bindingNames(
      node.namedChildren.find((child) => child.type === "tuple_pattern") ?? null,
    );
  }
  return [];
}

function declaredChunk(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  kinds: ReadonlySet<SourceChunk["kind"]>,
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return owner?.name === name && kinds.has(owner.kind) ? owner : null;
}

const TYPE_KINDS = new Set<SourceChunk["kind"]>([
  "class",
  "interface",
  "struct",
  "record",
  "enum",
  "delegate",
]);
const TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "interface_declaration",
  "struct_declaration",
  "record_declaration",
  "enum_declaration",
  "delegate_declaration",
]);
const TYPE_SCOPES = new Set([
  "declaration_list",
  "enum_member_declaration_list",
]);
const CALLABLE_DECLARATIONS = new Set([
  "method_declaration",
  "local_function_statement",
]);

function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (
    node.type === "local_declaration_statement" || node.type === "variable_declaration" ||
    node.type === "field_declaration" || node.type === "event_field_declaration"
  ) {
    const declarator = variableDeclarators(node)
      .find((candidate) => bindingNames(candidate).includes(name));
    if (!declarator) return null;
    const target = declaredChunk(declarator, name, chunks, new Set(["function"]));
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (CALLABLE_DECLARATIONS.has(node.type)) {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks, new Set(["function", "method"]));
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (TYPE_DECLARATIONS.has(node.type)) {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks, TYPE_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (node.type === "using_directive") {
    const value = usingValue(node);
    return value?.local === name ? { kind: "import", target: null } : null;
  }
  if (node.type === "extern_alias_directive") {
    return node.childForFieldName("name")?.text === name
      ? { kind: "local", target: null }
      : null;
  }
  return null;
}

function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (["identifier", "this", "base"].includes(node.type)) return node.text;
  if (node.type === "generic_name") return node.childForFieldName("name")?.text ?? node.namedChildren[0]?.text ?? null;
  if (node.type === "member_access_expression") return expressionRoot(node.namedChildren[0] ?? null);
  if (node.type === "conditional_access_expression") return expressionRoot(node.childForFieldName("condition") ?? node.namedChildren[0] ?? null);
  if (node.type === "postfix_unary_expression") return expressionRoot(node.namedChildren[0] ?? null);
  if (node.type === "element_access_expression") return expressionRoot(node.namedChildren[0] ?? null);
  if (node.type === "parenthesized_expression") return expressionRoot(node.namedChildren[0] ?? null);
  if (node.type === "alias_qualified_name" || node.type === "qualified_name") {
    return expressionRoot(node.namedChildren[0] ?? null);
  }
  return null;
}

function enclosingParameterBinding(node: SyntaxNode, name: string): boolean {
  if (
    node.type === "method_declaration" || node.type === "constructor_declaration" ||
    node.type === "local_function_statement" || node.type === "operator_declaration" ||
    node.type === "conversion_operator_declaration" || node.type === "lambda_expression"
  ) {
    return parameterBindings(
      node.childForFieldName("parameters") ??
        node.namedChildren.find((child) => child.type === "parameter_list" || child.type === "implicit_parameter") ??
        null,
    ).includes(name);
  }
  return false;
}

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function patternBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  return syntaxDescendants(node)
    .filter((current) => current.type === "declaration_pattern")
    .flatMap((current) => bindingNames(current));
}

function declarationExpressionBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  return syntaxDescendants(node, "declaration_expression")
    .flatMap((current) => bindingNames(current));
}

function queryClauseName(node: SyntaxNode): string | null {
  if (node.type === "from_clause") {
    return node.childForFieldName("name")?.text ?? null;
  }
  if (["join_clause", "join_into_clause", "let_clause"].includes(node.type)) {
    return node.namedChildren.find((child) => child.type === "identifier")?.text ?? null;
  }
  return null;
}

function queryBinding(scope: SyntaxNode, call: SyntaxNode, name: string): boolean {
  const active = new Set<string>();
  for (const child of scope.namedChildren) {
    if (child.type === "identifier") {
      if (child.endIndex <= call.startIndex) {
        active.clear();
        active.add(child.text);
      }
      continue;
    }
    if (contains(child, call)) {
      if (child.type === "join_clause") {
        const into = child.namedChildren.find((current) => current.type === "join_into_clause");
        const rightKey = child.namedChildren.filter((current) => current.id !== into?.id).at(-1);
        if (
          queryClauseName(child) === name &&
          contains(rightKey ?? null, call)
        ) return true;
      }
      return active.has(name);
    }
    if (child.endIndex > call.startIndex) break;
    if (child.type === "join_clause") {
      const into = child.namedChildren.find((current) => current.type === "join_into_clause");
      const binding = into ? queryClauseName(into) : queryClauseName(child);
      if (binding) active.add(binding);
    } else {
      const binding = queryClauseName(child);
      if (binding) active.add(binding);
    }
  }
  return active.has(name);
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
      const binding = declarationBinding(initializer, name, chunks);
      if (binding) return binding;
    }
  }
  if (scope.type === "foreach_statement") {
    const left = scope.childForFieldName("left");
    if (contains(scope.childForFieldName("body"), call) && bindingNames(left).includes(name)) {
      return { kind: "local", target: null };
    }
  }
  if (scope.type === "catch_clause") {
    const declaration = scope.namedChildren.find((child) => child.type === "catch_declaration");
    const filter = scope.namedChildren.find((child) => child.type === "catch_filter_clause");
    if (
      bindingNames(declaration ?? null).includes(name) &&
      (contains(filter ?? null, call) || contains(scope.childForFieldName("body"), call))
    ) return { kind: "local", target: null };
  }
  if (scope.type === "using_statement" || scope.type === "fixed_statement") {
    const declaration = scope.namedChildren.find((child) => child.type === "variable_declaration");
    if (contains(scope.childForFieldName("body"), call)) {
      const binding = declaration ? declarationBinding(declaration, name, chunks) : null;
      if (binding) return binding;
    }
  }
  if (scope.type === "if_statement" || scope.type === "while_statement") {
    const condition = scope.childForFieldName("condition");
    const body = scope.type === "if_statement"
      ? scope.childForFieldName("consequence")
      : scope.childForFieldName("body");
    const names = [...patternBindings(condition), ...declarationExpressionBindings(condition)];
    if (names.includes(name) && contains(body, call)) {
      return { kind: "local", target: null };
    }
  }
  if (scope.type === "switch_section") {
    if (patternBindings(scope).includes(name) && contains(scope, call)) {
      return { kind: "local", target: null };
    }
  }
  if (scope.type === "query_expression") {
    if (queryBinding(scope, call, name)) {
      return { kind: "local", target: null };
    }
  }
  return null;
}

function scopedBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  const candidates: ResolvedCallBinding[] = [];
  for (const child of scope.namedChildren) {
    const isHoisted = CALLABLE_DECLARATIONS.has(child.type) || TYPE_DECLARATIONS.has(child.type);
    if (!isHoisted && child.endIndex > call.startIndex) continue;
    const binding = declarationBinding(child, name, chunks);
    if (binding) candidates.push(binding);
    if (
      declarationExpressionBindings(child).includes(name) &&
      child.endIndex <= call.startIndex
    ) candidates.push({ kind: "local", target: null });
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) return { kind: "local", target: null };
  return null;
}

function resolveBinding(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding {
  if (name === "this" || name === "base") return { kind: "local", target: null };
  let current: SyntaxNode | null = call.parent;
  while (current) {
    const control = controlBinding(current, call, name, chunks);
    if (control) return control;
    if (enclosingParameterBinding(current, name)) return { kind: "local", target: null };
    if (
      TYPE_DECLARATIONS.has(current.type) &&
      parameterBindings(
        current.namedChildren.find((child) => child.type === "parameter_list") ?? null,
      ).includes(name)
    ) return { kind: "local", target: null };
    if (current.type === "block") {
      const binding = scopedBinding(current, call, name, chunks);
      if (binding) return binding;
    } else if (
      TYPE_SCOPES.has(current.type) || current.type === "compilation_unit" ||
      current.type === "namespace_declaration" || current.type === "file_scoped_namespace_declaration"
    ) {
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
  lineStarts: number[],
): SourceFact | null {
  let callee: string | null = null;
  let binding: ResolvedCallBinding = { kind: "unknown", target: null };

  if (node.type === "invocation_expression") {
    const fn = node.childForFieldName("function") ?? node.namedChildren[0] ?? null;
    callee = fn?.text ?? null;
    const root = expressionRoot(fn);
    if (root) binding = resolveBinding(node, root, chunks);
  } else if (node.type === "object_creation_expression") {
    const type = node.childForFieldName("type") ?? node.namedChildren[0] ?? null;
    callee = type?.text ?? null;
    const root = expressionRoot(type);
    if (root) binding = resolveBinding(node, root, chunks);
  } else if (node.type === "implicit_object_creation_expression") {
    const declaration = node.parent?.parent?.type === "variable_declaration" ? node.parent.parent : null;
    const type = declaration?.childForFieldName("type") ?? null;
    callee = type?.text ?? "new";
    const root = expressionRoot(type);
    if (root) binding = resolveBinding(node, root, chunks);
  } else if (node.type === "constructor_initializer") {
    callee = node.children.find((child) => child.type === "this" || child.type === "base")?.text ?? null;
    if (callee) binding = { kind: "local", target: null };
  }

  if (!callee) return null;
  return {
    kind: "call",
    callee,
    binding: binding.kind,
    target: binding.target,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, lineStarts),
  };
}

/** Extract C# using directives and explicit invocation syntax without assembly metadata. */
export function extractCSharpFacts(
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "using_directive") {
      facts.push(...importFact(node, chunks, lineStarts));
    } else if (
      node.type === "invocation_expression" || node.type === "object_creation_expression" ||
      node.type === "implicit_object_creation_expression" || node.type === "constructor_initializer"
    ) {
      const fact = callFact(node, chunks, lineStarts);
      if (fact) facts.push(fact);
    }
  }
  return facts.sort(
    (left, right) => left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset || left.kind.localeCompare(right.kind),
  );
}
