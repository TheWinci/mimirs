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
  factSpan,
  syntaxDescendants,
  walkSyntax,
} from "../fact-helpers";

interface ResolvedCallBinding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

function stringValue(node: SyntaxNode | null): string | null {
  if (!node) return null;
  const value = node.text;
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("`") && value.endsWith("`")))
  ) {
    return value.slice(1, -1);
  }
  return null;
}

function importFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return syntaxDescendants(node, "import_spec").flatMap((specifier): ImportFact[] => {
    const source = stringValue(specifier.childForFieldName("path"));
    if (source === null) return [];
    const name = specifier.childForFieldName("name");
    const blank = name?.type === "blank_identifier";
    return [{
      kind: "import",
      source,
      imported: blank ? null : "*",
      local: name?.text ?? null,
      typeOnly: false,
      static: false,
      global: false,
      owner,
      ...factSpan(specifier, lineStarts),
    }];
  });
}

function parameterBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "parameter_list") {
    return node.namedChildren.flatMap((child) => parameterBindings(child));
  }
  if (node.type === "parameter_declaration" || node.type === "variadic_parameter_declaration") {
    const type = node.childForFieldName("type");
    return node.namedChildren
      .filter((child) => child.type === "identifier" && (!type || child.endIndex <= type.startIndex))
      .map((child) => child.text);
  }
  return [];
}

function typeParameterBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  return syntaxDescendants(node, "type_parameter_declaration").flatMap(
    (declaration) => declaration.childrenForFieldName("name")
      .filter((name) => name.type === "identifier")
      .map((name) => name.text),
  );
}

function receiverTypeParameterBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  return syntaxDescendants(node, "type_arguments").flatMap((typeArguments) =>
    syntaxDescendants(typeArguments, "type_identifier").map((name) => name.text)
  );
}

function assignedNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (node.type !== "expression_list") return [];
  return node.namedChildren.flatMap((child) => assignedNames(child));
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

const FUNCTION_KINDS = new Set<SourceChunk["kind"]>(["function"]);
const TYPE_KINDS = new Set<SourceChunk["kind"]>(["type", "struct", "interface"]);
const METHOD_KINDS = new Set<SourceChunk["kind"]>(["method"]);

function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (node.type === "import_declaration") {
    for (const specifier of syntaxDescendants(node, "import_spec")) {
      const alias = specifier.childForFieldName("name");
      if (alias?.type === "package_identifier" && alias.text === name) {
        return { kind: "import", target: null };
      }
    }
    return null;
  }

  if (node.type === "function_declaration") {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks, FUNCTION_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }

  if (node.type === "type_declaration") {
    for (const specifier of syntaxDescendants(node, "type_spec")) {
      if (specifier.childForFieldName("name")?.text !== name) continue;
      const target = declaredChunk(specifier, name, chunks, TYPE_KINDS);
      return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
    }
  }

  if (node.type === "short_var_declaration") {
    if (!assignedNames(node.childForFieldName("left")).includes(name)) return null;
    const target = declaredChunk(node, name, chunks, FUNCTION_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }

  if (node.type === "assignment_statement") {
    return assignedNames(node.childForFieldName("left")).includes(name)
      ? { kind: "local", target: null }
      : null;
  }

  if (node.type === "var_declaration" || node.type === "const_declaration") {
    const specifierType = node.type === "var_declaration" ? "var_spec" : "const_spec";
    for (const specifier of syntaxDescendants(node, specifierType)) {
      if (!specifier.childrenForFieldName("name").some((bound) => bound.text === name)) {
        continue;
      }
      const target = declaredChunk(specifier, name, chunks, FUNCTION_KINDS);
      return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
    }
  }
  return null;
}

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function latestSequentialBinding(
  statementList: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  let latest: ResolvedCallBinding | null = null;
  for (const child of statementList.namedChildren) {
    if (child.endIndex > call.startIndex) break;
    const binding = declarationBinding(child, name, chunks);
    if (binding) latest = binding;
  }
  return latest;
}

function initializerBinding(
  node: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  const initializer = node.childForFieldName("initializer");
  if (!initializer || contains(initializer, call)) return null;
  return declarationBinding(initializer, name, chunks);
}

function controlBinding(
  node: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (
    node.type === "if_statement" || node.type === "for_clause" ||
    node.type === "expression_switch_statement"
  ) {
    return initializerBinding(node, call, name, chunks);
  }

  if (node.type === "for_statement" && contains(node.childForFieldName("body"), call)) {
    const clause = node.namedChildren.find(
      (child) => child.type === "for_clause" || child.type === "range_clause",
    );
    if (clause?.type === "for_clause") {
      return initializerBinding(clause, call, name, chunks);
    }
    if (
      clause?.type === "range_clause" &&
      assignedNames(clause.childForFieldName("left")).includes(name)
    ) {
      return { kind: "local", target: null };
    }
  }

  if (node.type === "type_switch_statement") {
    const initializer = initializerBinding(node, call, name, chunks);
    if (initializer) return initializer;
    const activeCase = node.namedChildren.find(
      (child) =>
        (child.type === "type_case" || child.type === "default_case") &&
        contains(child, call),
    );
    if (
      activeCase?.namedChildren.some(
        (child) => child.type === "statement_list" && contains(child, call),
      ) &&
      assignedNames(node.childForFieldName("alias")).includes(name)
    ) {
      return { kind: "local", target: null };
    }
  }

  if (node.type === "communication_case") {
    const body = node.namedChildren.find((child) => child.type === "statement_list");
    const communication = node.childForFieldName("communication");
    if (
      contains(body ?? null, call) && communication?.type === "receive_statement" &&
      assignedNames(communication.childForFieldName("left")).includes(name)
    ) {
      return { kind: "local", target: null };
    }
  }

  return null;
}

function calleeRoot(callee: SyntaxNode): string | null {
  if (callee.type === "identifier" || callee.type === "type_identifier") return callee.text;
  if (callee.type === "selector_expression") {
    const operand = callee.childForFieldName("operand");
    return operand ? calleeRoot(operand) : null;
  }
  if (
    callee.type === "index_expression" ||
    callee.type === "parenthesized_expression" ||
    callee.type === "unary_expression"
  ) {
    return callee.namedChildren[0] ? calleeRoot(callee.namedChildren[0]) : null;
  }
  if (callee.type === "generic_type") {
    const type = callee.childForFieldName("type");
    return type ? calleeRoot(type) : null;
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
  while (current) {
    const controlled = controlBinding(current, call, name, chunks);
    if (controlled) return controlled;

    if (current.type === "statement_list") {
      const binding = latestSequentialBinding(current, call, name, chunks);
      if (binding) return binding;
    }

    if (
      current.type === "function_declaration" ||
      current.type === "method_declaration" ||
      current.type === "func_literal"
    ) {
      const parameters = [
        ...parameterBindings(current.childForFieldName("receiver")),
        ...parameterBindings(current.childForFieldName("parameters")),
        ...parameterBindings(current.childForFieldName("result")),
        ...typeParameterBindings(current.childForFieldName("type_parameters")),
        ...(current.type === "method_declaration"
          ? receiverTypeParameterBindings(current.childForFieldName("receiver"))
          : []),
      ];
      if (parameters.includes(name)) return { kind: "local", target: null };
    }

    if (current.type === "source_file") {
      for (const child of current.namedChildren) {
        const binding = declarationBinding(child, name, chunks);
        if (binding) return binding;
      }
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

function receiverTypeName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "type_identifier") return node.text;
  if (node.type === "generic_type") {
    return receiverTypeName(node.childForFieldName("type"));
  }
  if (node.type === "pointer_type" || node.type === "parenthesized_type") {
    return receiverTypeName(node.namedChildren[0] ?? null);
  }
  return null;
}

function refineMethodExpression(
  call: SyntaxNode,
  callee: SyntaxNode,
  binding: ResolvedCallBinding,
  chunks: SourceChunk[],
): ResolvedCallBinding {
  if (
    callee.type !== "selector_expression" || binding.kind !== "source-chunk" ||
    binding.target === null || !TYPE_KINDS.has(binding.target.kind)
  ) {
    return binding;
  }

  const root = calleeRoot(callee);
  const member = callee.childForFieldName("field")?.text;
  if (root === null || member === undefined) return { kind: "local", target: null };

  let sourceFile: SyntaxNode | null = call;
  while (sourceFile && sourceFile.type !== "source_file") sourceFile = sourceFile.parent;
  if (!sourceFile) return { kind: "local", target: null };

  const targets = sourceFile.namedChildren
    .filter((node) => node.type === "method_declaration")
    .filter((node) => {
      if (node.childForFieldName("name")?.text !== member) return false;
      const receiver = node.childForFieldName("receiver");
      const declaration = receiver
        ? syntaxDescendants(receiver, "parameter_declaration")[0]
        : null;
      return receiverTypeName(declaration?.childForFieldName("type") ?? null) === root;
    })
    .map((node) => declaredChunk(node, member, chunks, METHOD_KINDS))
    .filter((target): target is SourceChunkRef => target !== null);

  return targets.length === 1
    ? { kind: "source-chunk", target: targets[0]! }
    : { kind: "local", target: null };
}

/** Extract Go imports and calls without inventing implicit export facts. */
export function extractGoFacts(
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "import_declaration") {
      facts.push(...importFacts(node, chunks, lineStarts));
    } else if (node.type === "call_expression" || node.type === "type_conversion_expression") {
      const callee = node.childForFieldName(
        node.type === "call_expression" ? "function" : "type",
      );
      if (callee) {
        const binding = refineMethodExpression(
          node,
          callee,
          resolveCallBinding(node, callee, chunks),
          chunks,
        );
        facts.push({
          kind: "call",
          callee: callee.text,
          binding: binding.kind,
          target: binding.target,
          owner: factOwner(chunks, node.startIndex, node.endIndex),
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
