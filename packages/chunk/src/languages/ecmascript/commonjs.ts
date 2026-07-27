import type { Node as SyntaxNode, Tree } from "web-tree-sitter";

import type {
  ExportFact,
  ImportFact,
  SourceChunk,
  SourceFact,
} from "../../types";
import {
  factOwner,
  factSpan,
  syntaxDescendants,
  walkSyntax,
} from "../fact-helpers";

const FUNCTION_NODES = new Set([
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

function stringValue(node: SyntaxNode | null): string | null {
  if (!node || node.type !== "string") return null;
  const text = node.text;
  if (text.length < 2) return null;
  return text.slice(1, -1);
}

function bindingNames(pattern: SyntaxNode | null): string[] {
  if (!pattern) return [];
  if (
    pattern.type === "identifier" ||
    pattern.type === "shorthand_property_identifier_pattern"
  ) {
    return [pattern.text];
  }
  if (pattern.type === "pair_pattern") {
    return bindingNames(pattern.childForFieldName("value"));
  }
  if (pattern.type === "assignment_pattern") {
    return bindingNames(pattern.childForFieldName("left"));
  }
  if (pattern.type === "required_parameter" || pattern.type === "optional_parameter") {
    return bindingNames(pattern.childForFieldName("pattern") ?? pattern.namedChildren[0] ?? null);
  }
  return pattern.namedChildren.flatMap(bindingNames);
}

function importBindsName(node: SyntaxNode, name: string): boolean {
  const requireClause = node.namedChildren.find(
    (child) => child.type === "import_require_clause",
  );
  if (requireClause) {
    return requireClause.namedChildren.some(
      (child) => child.type === "identifier" && child.text === name,
    );
  }
  const clause = node.namedChildren.find((child) => child.type === "import_clause");
  if (!clause) return false;
  if (
    clause.namedChildren.some(
      (child) => child.type === "identifier" && child.text === name,
    )
  ) {
    return true;
  }
  for (const namespace of syntaxDescendants(clause, "namespace_import")) {
    if (namespace.namedChildren.some((child) => child.text === name)) return true;
  }
  for (const specifier of syntaxDescendants(clause, "import_specifier")) {
    const imported = specifier.childForFieldName("name")?.text;
    const local = specifier.childForFieldName("alias")?.text ?? imported;
    if (local === name) return true;
  }
  return false;
}

function declarationBindsName(node: SyntaxNode, name: string): boolean {
  if (node.type === "export_statement") {
    return node.namedChildren.some((child) => declarationBindsName(child, name));
  }
  if (node.type === "import_statement") return importBindsName(node, name);
  if (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration" ||
    node.type === "class_declaration"
  ) {
    return node.childForFieldName("name")?.text === name;
  }
  if (
    node.type === "lexical_declaration" ||
    node.type === "variable_declaration" ||
    node.type === "using_declaration"
  ) {
    return syntaxDescendants(node, "variable_declarator").some((declarator) =>
      bindingNames(declarator.childForFieldName("name")).includes(name)
    );
  }
  return false;
}

function hoistedVarBindsName(scope: SyntaxNode, name: string): boolean {
  const roots = scope.type === "program"
    ? scope.namedChildren
    : scope.childForFieldName("body")?.namedChildren ?? [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (FUNCTION_NODES.has(current.type) || current.type === "class_declaration") continue;
    if (
      current.type === "variable_declaration" &&
      syntaxDescendants(current, "variable_declarator").some((declarator) =>
        bindingNames(declarator.childForFieldName("name")).includes(name)
      )
    ) {
      return true;
    }
    for (let index = current.namedChildren.length - 1; index >= 0; index--) {
      stack.push(current.namedChildren[index]!);
    }
  }
  return false;
}

function scopeBindsName(scope: SyntaxNode, name: string): boolean {
  if (FUNCTION_NODES.has(scope.type)) {
    if (
      scope.type !== "method_definition" &&
      scope.childForFieldName("name")?.text === name
    ) {
      return true;
    }
    const parameters = scope.childForFieldName("parameters");
    if (parameters && bindingNames(parameters).includes(name)) return true;
    if (hoistedVarBindsName(scope, name)) return true;
  }
  if (
    scope.type === "catch_clause" &&
    bindingNames(scope.childForFieldName("parameter")).includes(name)
  ) {
    return true;
  }
  if (scope.type === "for_statement" || scope.type === "for_in_statement") {
    const binder = scope.childForFieldName("initializer") ??
      scope.childForFieldName("left");
    if (binder && declarationBindsName(binder, name)) return true;
  }
  if (scope.type === "program" || scope.type === "statement_block") {
    if (scope.namedChildren.some((child) => declarationBindsName(child, name))) {
      return true;
    }
    if (scope.type === "program" && hoistedVarBindsName(scope, name)) return true;
  }
  return false;
}

function scopeReassignsBefore(
  scope: SyntaxNode,
  name: string,
  beforeOffset: number,
): boolean {
  if (scope.type !== "program" && !FUNCTION_NODES.has(scope.type)) return false;
  const roots = scope.type === "program"
    ? scope.namedChildren
    : scope.childForFieldName("body")?.namedChildren ?? [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.startIndex >= beforeOffset) continue;
    if (FUNCTION_NODES.has(current.type) || current.type === "class_declaration") continue;
    if (
      current.type === "assignment_expression" &&
      current.childForFieldName("left")?.type === "identifier" &&
      current.childForFieldName("left")?.text === name
    ) {
      return true;
    }
    for (let index = current.namedChildren.length - 1; index >= 0; index--) {
      stack.push(current.namedChildren[index]!);
    }
  }
  return false;
}

/** Whether a spelling still refers to Node's implicit CommonJS binding. */
function commonJsGlobalAvailable(node: SyntaxNode, name: string): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    if (scopeBindsName(current, name)) return false;
    if (scopeReassignsBefore(current, name, node.startIndex)) return false;
    current = current.parent;
  }
  return true;
}

export function staticRequireSource(node: SyntaxNode): string | null {
  if (node.type !== "call_expression") return null;
  const callee = node.childForFieldName("function");
  if (callee?.type !== "identifier" || callee.text !== "require") return null;
  if (!commonJsGlobalAvailable(node, "require")) return null;
  const args = node.childForFieldName("arguments");
  if (!args || args.namedChildren.length !== 1) return null;
  return stringValue(args.namedChildren[0] ?? null);
}

/** A literal require expression used as a variable initializer. */
export function staticRequireBinding(node: SyntaxNode): {
  source: string;
  imported: string;
} | null {
  const direct = staticRequireSource(node);
  if (direct !== null) return { source: direct, imported: "*" };
  if (node.type !== "member_expression" && node.type !== "subscript_expression") {
    return null;
  }
  const object = node.childForFieldName("object");
  const source = object ? staticRequireSource(object) : null;
  const property = staticPropertyName(
    node.childForFieldName(node.type === "member_expression" ? "property" : "index"),
  );
  return source === null || property === null ? null : { source, imported: property };
}

function selectedRequireProperty(node: SyntaxNode): {
  expression: SyntaxNode;
  imported: string;
} | null {
  const parent = node.parent;
  if (
    (parent?.type !== "member_expression" && parent?.type !== "subscript_expression") ||
    parent.childForFieldName("object")?.id !== node.id
  ) {
    return null;
  }
  const imported = staticPropertyName(
    parent.childForFieldName(parent.type === "member_expression" ? "property" : "index"),
  );
  return imported === null ? null : { expression: parent, imported };
}

function importBindings(pattern: SyntaxNode | null): Array<{
  imported: string;
  local: string;
  evidence: SyntaxNode;
}> {
  if (!pattern) return [];
  if (pattern.type === "identifier") {
    return [{ imported: "*", local: pattern.text, evidence: pattern }];
  }
  if (pattern.type === "shorthand_property_identifier_pattern") {
    return [{ imported: pattern.text, local: pattern.text, evidence: pattern }];
  }
  if (pattern.type === "pair_pattern") {
    const key = pattern.childForFieldName("key");
    const value = pattern.childForFieldName("value");
    if (!key || !value) return [];
    return importBindings(value).map((binding) => ({
      imported: key.text,
      local: binding.local,
      evidence: pattern,
    }));
  }
  if (pattern.type === "assignment_pattern") {
    return importBindings(pattern.childForFieldName("left"));
  }
  return pattern.namedChildren.flatMap(importBindings);
}

function requireFacts(
  node: SyntaxNode,
  source: string,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact[] {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  const selected = selectedRequireProperty(node);
  const expression = selected?.expression ?? node;
  const declarator =
    expression.parent?.type === "variable_declarator" &&
      expression.parent.childForFieldName("value")?.id === expression.id
      ? expression.parent
      : null;
  const pattern = declarator?.childForFieldName("name") ?? null;
  const bindings = selected && pattern?.type === "identifier"
    ? [{ imported: selected.imported, local: pattern.text, evidence: pattern }]
    : importBindings(pattern);
  if (bindings.length === 0) {
    return [{
      kind: "import",
      source,
      imported: null,
      local: null,
      typeOnly: false,
      static: false,
      global: false,
      owner,
      ...factSpan(node, starts),
    }];
  }
  return bindings.map((binding) => ({
    kind: "import",
    source,
    imported: binding.imported,
    local: binding.local,
    typeOnly: false,
    static: false,
    global: false,
    owner,
    ...factSpan(binding.evidence, starts),
  }));
}

function isModuleExports(node: SyntaxNode | null): boolean {
  if (node?.type !== "member_expression" && node?.type !== "subscript_expression") {
    return false;
  }
  const object = node.childForFieldName("object");
  const property = staticPropertyName(
    node.childForFieldName(node.type === "member_expression" ? "property" : "index"),
  );
  return object?.type === "identifier" && object.text === "module" &&
    property === "exports";
}

function staticPropertyName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (
    node.type === "property_identifier" ||
    node.type === "shorthand_property_identifier" ||
    node.type === "shorthand_property_identifier_pattern"
  ) {
    return node.text;
  }
  if (node.type === "computed_property_name" && node.namedChildren.length === 1) {
    return stringValue(node.namedChildren[0] ?? null);
  }
  return stringValue(node);
}

interface ExportValue {
  local: string | null;
  source: string | null;
}

function exportValue(node: SyntaxNode | null): ExportValue {
  if (!node) return { local: null, source: null };
  if (node.type === "identifier") return { local: node.text, source: null };
  if (node.type === "assignment_expression") {
    return exportValue(node.childForFieldName("right"));
  }
  const required = staticRequireSource(node);
  if (required !== null) return { local: "default", source: required };
  if (node.type === "member_expression" || node.type === "subscript_expression") {
    const object = node.childForFieldName("object");
    const source = object ? staticRequireSource(object) : null;
    const property = staticPropertyName(
      node.childForFieldName(node.type === "member_expression" ? "property" : "index"),
    );
    if (source !== null && property !== null) return { local: property, source };
  }
  return { local: null, source: null };
}

function makeExportFact(
  evidence: SyntaxNode,
  exported: string,
  value: ExportValue,
  ownerNode: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ExportFact {
  return {
    kind: "export",
    exported,
    local: value.local,
    source: value.source,
    typeOnly: false,
    owner: factOwner(chunks, ownerNode.startIndex, ownerNode.endIndex),
    ...factSpan(evidence, starts),
  };
}

function objectExportFacts(
  object: SyntaxNode,
  assignment: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ExportFact[] {
  const facts: ExportFact[] = [];
  for (const property of object.namedChildren) {
    if (property.type === "shorthand_property_identifier") {
      facts.push(makeExportFact(
        property,
        property.text,
        { local: property.text, source: null },
        assignment,
        chunks,
        starts,
      ));
      continue;
    }
    if (property.type === "pair") {
      const exported = staticPropertyName(property.childForFieldName("key"));
      if (!exported) continue;
      facts.push(makeExportFact(
        property,
        exported,
        exportValue(property.childForFieldName("value")),
        assignment,
        chunks,
        starts,
      ));
      continue;
    }
    if (property.type === "method_definition") {
      const nameNode = property.childForFieldName("name");
      const exported = staticPropertyName(nameNode);
      if (!exported || !nameNode) continue;
      facts.push(makeExportFact(
        nameNode,
        exported,
        { local: null, source: null },
        assignment,
        chunks,
        starts,
      ));
    }
  }
  return facts;
}

function exportFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ExportFact[] {
  if (node.type !== "assignment_expression") return [];
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left) return [];

  if (isModuleExports(left)) {
    if (!commonJsGlobalAvailable(node, "module")) return [];
    if (right?.type === "object") {
      return objectExportFacts(right, node, chunks, starts);
    }
    const value = exportValue(right);
    if (value.source !== null && value.local === "default") {
      return [
        makeExportFact(left, "*", { local: null, source: value.source }, node, chunks, starts),
        makeExportFact(left, "default", value, node, chunks, starts),
      ];
    }
    return [makeExportFact(left, "default", value, node, chunks, starts)];
  }

  if (left.type !== "member_expression" && left.type !== "subscript_expression") {
    return [];
  }
  const object = left.childForFieldName("object");
  const property = staticPropertyName(
    left.childForFieldName(left.type === "member_expression" ? "property" : "index"),
  );
  if (!property) return [];
  if (
    object?.type === "identifier" && object.text === "exports" &&
    commonJsGlobalAvailable(node, "exports")
  ) {
    return [makeExportFact(left, property, exportValue(right), node, chunks, starts)];
  }
  if (isModuleExports(object) && commonJsGlobalAvailable(node, "module")) {
    return [makeExportFact(left, property, exportValue(right), node, chunks, starts)];
  }
  return [];
}

export function extractCommonJsFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    const required = staticRequireSource(node);
    if (required !== null) facts.push(...requireFacts(node, required, chunks, starts));
    facts.push(...exportFacts(node, chunks, starts));
  }
  return facts;
}
