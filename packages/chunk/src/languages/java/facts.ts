import type { Node as SyntaxNode, Tree } from "web-tree-sitter";

import type {
  CallBindingKind,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
} from "../../types";
import { factOwner, factSpan, walkSyntax } from "../fact-helpers";

interface ResolvedCallBinding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

interface JavaImport {
  source: string;
  imported: string;
  local: string | null;
  static: boolean;
}

function terminal(path: string): string {
  return path.split(".").at(-1) ?? path;
}

function javaImport(node: SyntaxNode): JavaImport | null {
  const path = node.namedChildren.find(
    (child) => child.type === "scoped_identifier" || child.type === "identifier",
  )?.text;
  if (!path) return null;

  const isStatic = node.children.some((child) => child.type === "static");
  const wildcard = node.namedChildren.some((child) => child.type === "asterisk");
  if (wildcard) {
    return { source: path, imported: "*", local: null, static: isStatic };
  }
  if (!isStatic) {
    return { source: path, imported: "*", local: terminal(path), static: false };
  }

  const imported = terminal(path);
  return {
    source: path.slice(0, -(imported.length + 1)),
    imported,
    local: imported,
    static: true,
  };
}

function importFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const value = javaImport(node);
  if (!value) return [];
  return [{
    kind: "import",
    ...value,
    typeOnly: false,
    global: false,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, lineStarts),
  }];
}

function requiresFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const source = node.childForFieldName("module")?.text;
  if (!source) return [];
  const isStatic = /\brequires\s+(?:(?:transitive|static)\s+)*static\b/.test(node.text);
  const transitive = /\brequires\s+(?:(?:transitive|static)\s+)*transitive\b/.test(node.text);
  return [{
    kind: "import",
    source,
    imported: "module",
    local: null,
    typeOnly: isStatic,
    static: isStatic,
    global: transitive,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, lineStarts),
  }];
}

function parameterBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (
    node.type === "formal_parameter" || node.type === "spread_parameter" ||
    node.type === "receiver_parameter"
  ) {
    const name = node.childForFieldName("name");
    return name ? [name.text] : node.type === "receiver_parameter" ? ["this"] : [];
  }
  if (node.type === "formal_parameters" || node.type === "inferred_parameters") {
    return node.namedChildren.flatMap(parameterBindings);
  }
  return [];
}

function variableDeclarators(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === "variable_declarator");
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
  "record",
  "enum",
  "annotation_type",
]);
const TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "interface_declaration",
  "record_declaration",
  "enum_declaration",
  "annotation_type_declaration",
]);
const TYPE_BODIES = new Set([
  "class_body",
  "interface_body",
  "enum_body",
  "annotation_type_body",
]);

function valueDeclarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (node.type === "local_variable_declaration") {
    const declarator = variableDeclarators(node)
      .find((candidate) => candidate.childForFieldName("name")?.text === name);
    if (!declarator) return null;
    const target = declaredChunk(declarator, name, chunks, new Set(["function"]));
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (node.type === "field_declaration") {
    return variableDeclarators(node).some(
      (declarator) => declarator.childForFieldName("name")?.text === name,
    ) ? { kind: "local", target: null } : null;
  }
  if (TYPE_DECLARATIONS.has(node.type)) {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks, TYPE_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (node.type === "import_declaration") {
    const imported = javaImport(node);
    return imported?.local === name ? { kind: "import", target: null } : null;
  }
  return null;
}

function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (
    node.type === "identifier" || node.type === "type_identifier" ||
    node.type === "this" || node.type === "super"
  ) return node.text;
  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") {
    return expressionRoot(node.childForFieldName("scope"));
  }
  if (node.type === "field_access") return expressionRoot(node.childForFieldName("object"));
  if (node.type === "array_access") return expressionRoot(node.childForFieldName("array"));
  if (node.type === "parenthesized_expression") return expressionRoot(node.namedChildren[0] ?? null);
  if (node.type === "generic_type") return expressionRoot(node.namedChildren[0] ?? null);
  return null;
}

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function patternBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  const names: string[] = [];
  const direct = node.childForFieldName("name");
  if (direct?.type === "identifier") names.push(direct.text);
  for (const current of walkSyntax(node)) {
    if (current.id === node.id) continue;
    if (current.type === "instanceof_expression") {
      const name = current.childForFieldName("name");
      if (name?.type === "identifier") names.push(name.text);
    }
    if (current.type === "type_pattern" || current.type === "record_pattern_component") {
      const name = current.namedChildren.findLast((child) => child.type === "identifier");
      if (name) names.push(name.text);
    }
  }
  return [...new Set(names)];
}

function controlBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (scope.type === "for_statement") {
    const initializer = scope.childForFieldName("init");
    if (initializer && initializer.endIndex <= call.startIndex) {
      const binding = valueDeclarationBinding(initializer, name, chunks);
      if (binding) return binding;
    }
  }
  if (scope.type === "enhanced_for_statement") {
    const body = scope.childForFieldName("body");
    if (contains(body, call) && scope.childForFieldName("name")?.text === name) {
      return { kind: "local", target: null };
    }
  }
  if (scope.type === "catch_clause") {
    const parameter = scope.namedChildren.find((child) => child.type === "catch_formal_parameter");
    if (
      contains(scope.childForFieldName("body"), call) &&
      parameter?.childForFieldName("name")?.text === name
    ) return { kind: "local", target: null };
  }
  if (scope.type === "try_with_resources_statement") {
    const resources = scope.childForFieldName("resources");
    const bound = resources?.namedChildren.some(
      (resource) => resource.childForFieldName("name")?.text === name,
    ) ?? false;
    if (bound && contains(scope.childForFieldName("body"), call)) {
      return { kind: "local", target: null };
    }
  }
  if (scope.type === "if_statement" || scope.type === "while_statement") {
    const condition = scope.childForFieldName("condition");
    const body = scope.type === "if_statement"
      ? scope.childForFieldName("consequence")
      : scope.childForFieldName("body");
    if (patternBindings(condition).includes(name) && contains(body, call)) {
      return { kind: "local", target: null };
    }
  }
  if (scope.type === "switch_rule" || scope.type === "switch_block_statement_group") {
    const label = scope.namedChildren.find((child) => child.type === "switch_label");
    if (
      patternBindings(label ?? null).includes(name) && label !== undefined &&
      label.endIndex <= call.startIndex && contains(scope, call)
    ) return { kind: "local", target: null };
  }
  return null;
}

function enclosingParameterBinding(node: SyntaxNode, name: string): boolean {
  if (
    node.type === "method_declaration" || node.type === "constructor_declaration" ||
    node.type === "compact_constructor_declaration"
  ) {
    if (parameterBindings(node.childForFieldName("parameters")).includes(name)) return true;
    if (node.type === "compact_constructor_declaration") {
      const record = node.parent?.parent;
      return record?.type === "record_declaration" &&
        parameterBindings(record.childForFieldName("parameters")).includes(name);
    }
    return false;
  }
  if (node.type === "lambda_expression") {
    return parameterBindings(node.childForFieldName("parameters")).includes(name);
  }
  return false;
}

function resolveValueBinding(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding {
  if (name === "this" || name === "super") return { kind: "local", target: null };

  let current: SyntaxNode | null = call.parent;
  while (current) {
    const control = controlBinding(current, call, name, chunks);
    if (control) return control;
    if (enclosingParameterBinding(current, name)) return { kind: "local", target: null };

    if (current.type === "block" || current.type === "constructor_body") {
      for (let index = current.namedChildren.length - 1; index >= 0; index--) {
        const child = current.namedChildren[index]!;
        if (child.endIndex > call.startIndex) continue;
        const binding = valueDeclarationBinding(child, name, chunks);
        if (binding) return binding;
      }
    } else if (TYPE_BODIES.has(current.type) || current.type === "program") {
      for (const child of current.namedChildren) {
        const binding = valueDeclarationBinding(child, name, chunks);
        if (binding) return binding;
      }
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

function resolveMethodBinding(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (TYPE_BODIES.has(current.type)) {
      const declarations = current.namedChildren.filter(
        (child) => child.type === "method_declaration" &&
          child.childForFieldName("name")?.text === name,
      );
      if (declarations.length === 1) {
        const target = declaredChunk(declarations[0]!, name, chunks, new Set(["method"]));
        return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
      }
      if (declarations.length > 1) return { kind: "local", target: null };
    }
    if (current.type === "program") {
      for (const child of current.namedChildren) {
        if (child.type !== "import_declaration") continue;
        const imported = javaImport(child);
        if (imported?.static && imported.local === name) {
          return { kind: "import", target: null };
        }
      }
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

function methodCallee(node: SyntaxNode): string | null {
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const object = node.childForFieldName("object")?.text;
  const typeArguments = node.childForFieldName("type_arguments")?.text ?? "";
  return `${object ? `${object}.` : ""}${typeArguments}${name}`;
}

function callFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact | null {
  let callee: string | null = null;
  let binding: ResolvedCallBinding = { kind: "unknown", target: null };

  if (node.type === "method_invocation") {
    callee = methodCallee(node);
    const object = node.childForFieldName("object");
    const name = node.childForFieldName("name")?.text;
    if (object) {
      const root = expressionRoot(object);
      if (root) binding = resolveValueBinding(node, root, chunks);
    } else if (name) {
      binding = resolveMethodBinding(node, name, chunks);
    }
  } else if (node.type === "object_creation_expression") {
    const type = node.childForFieldName("type");
    callee = type?.text ?? null;
    const root = expressionRoot(type);
    if (root) binding = resolveValueBinding(node, root, chunks);
  } else if (node.type === "explicit_constructor_invocation") {
    const constructor = node.childForFieldName("constructor");
    callee = constructor?.text ?? null;
    if (callee === "this" || callee === "super") {
      binding = { kind: "local", target: null };
    }
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

/** Extract Java imports and invocation syntax without classpath or overload inference. */
export function extractJavaFacts(
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "import_declaration") {
      facts.push(...importFact(node, chunks, lineStarts));
    } else if (node.type === "requires_module_directive") {
      facts.push(...requiresFact(node, chunks, lineStarts));
    } else if (
      node.type === "method_invocation" || node.type === "object_creation_expression" ||
      node.type === "explicit_constructor_invocation"
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
