import type { Node as SyntaxNode } from "web-tree-sitter";
import type { SourceChunkKind } from "../types";
import { NODE_TYPE_MAP } from "./kinds";

export function containsNodeType(node: SyntaxNode | null, type: string): boolean {
  if (!node) return false;
  if (node.type === type) return true;
  return node.namedChildren.some((child) => containsNodeType(child, type));
}

export function goDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "field_declaration") {
    const declaredType = node.childForFieldName("type");
    const names = node.namedChildren
      .filter((child) => child.type === "field_identifier")
      .map((child) => child.text);
    return names.length > 0 ? names.join(", ") : declaredType?.text ?? null;
  }
  if (node.type === "const_spec" || node.type === "var_spec") {
    const type = node.childForFieldName("type");
    const value = node.childForFieldName("value");
    const boundary = Math.min(type?.startIndex ?? node.endIndex, value?.startIndex ?? node.endIndex);
    const names = node.namedChildren
      .filter((child) => child.type === "identifier" && child.endIndex <= boundary)
      .map((child) => child.text);
    return names.length > 0 ? names.join(", ") : null;
  }
  if (node.type === "short_var_declaration") {
    const left = node.childForFieldName("left");
    const names = left?.namedChildren
      .filter((child) => child.type === "identifier")
      .map((child) => child.text) ?? [];
    return names.length > 0 ? names.join(", ") : null;
  }
  return null;
}

export function rustDeclaredName(node: SyntaxNode): string | null {
  if (node.type !== "impl_item") return null;
  const type = node.childForFieldName("type")?.text;
  if (!type) return null;
  const trait = node.childForFieldName("trait")?.text;
  return trait ? `${trait} for ${type}` : type;
}

export function javaDeclaredName(node: SyntaxNode): string | null {
  if (node.type !== "field_declaration") return null;
  const names = node.namedChildren
    .filter((child) => child.type === "variable_declarator")
    .map((child) => child.childForFieldName("name")?.text)
    .filter((name): name is string => name !== undefined);
  return names.length > 0 ? names.join(", ") : null;
}

export function csharpDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "field_declaration" || node.type === "event_field_declaration") {
    const declaration = node.namedChildren.find((child) => child.type === "variable_declaration");
    const names = declaration?.namedChildren
      .filter((child) => child.type === "variable_declarator")
      .map((child) => child.childForFieldName("name")?.text)
      .filter((name): name is string => name !== undefined) ?? [];
    return names.length > 0 ? names.join(", ") : null;
  }
  if (node.type === "indexer_declaration") return "this";
  if (node.type === "operator_declaration") {
    const operator = node.children.find((child) => child.type === "operator")?.nextSibling;
    return operator ? `operator ${operator.text}` : "operator";
  }
  if (node.type === "conversion_operator_declaration") {
    const style = node.children.find((child) => child.type === "implicit" || child.type === "explicit");
    const type = node.childForFieldName("type") ?? node.namedChildren.find((child) => child.type !== "modifier");
    return `${style?.text ?? "conversion"} operator ${type?.text ?? "?"}`;
  }
  return null;
}

export function rubyDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "singleton_class") {
    return `singleton ${node.childForFieldName("value")?.text ?? "?"}`;
  }
  if (node.type === "assignment") return node.childForFieldName("left")?.text ?? null;
  return null;
}

export function phpDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "namespace_definition") {
    return node.childForFieldName("name")?.text ?? "(global)";
  }
  if (node.type === "property_declaration") {
    const names = node.namedChildren
      .filter((child) => child.type === "property_element")
      .map((child) => child.childForFieldName("name")?.text.replace(/^\$/, ""))
      .filter((name): name is string => name !== undefined);
    return names.length > 0 ? names.join(", ") : null;
  }
  if (node.type === "const_declaration") {
    const names = node.namedChildren
      .filter((child) => child.type === "const_element")
      .map((child) => child.namedChildren[0]?.text)
      .filter((name): name is string => name !== undefined);
    return names.length > 0 ? names.join(", ") : null;
  }
  if (node.type === "property_promotion_parameter") {
    return node.childForFieldName("name")?.text.replace(/^\$/, "") ?? null;
  }
  if (node.type === "assignment_expression") {
    return node.childForFieldName("left")?.text.replace(/^\$/, "") ?? null;
  }
  return null;
}

export function scalaDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "given_definition") {
    return node.childForFieldName("name")?.text ??
      node.childForFieldName("return_type")?.text ?? "(anonymous given)";
  }
  if (node.type === "extension_definition") {
    const parameters = node.childForFieldName("parameters");
    const parameter = parameters?.namedChildren.find((child) => child.type === "parameter");
    const type = parameter?.childForFieldName("type")?.text;
    return type ? `${type} extensions` : "extensions";
  }
  return null;
}

export function scalaClassParameterIsField(node: SyntaxNode): boolean {
  if (/\b(?:val|var)\b/.test(node.text)) return true;
  const definition = node.parent?.parent;
  return definition?.type === "full_enum_case" ||
    (definition?.type === "class_definition" &&
      definition.children.some((child) => child.type === "case"));
}

export function kotlinClassParameterIsField(node: SyntaxNode): boolean {
  return /\b(?:val|var)\b/.test(node.text);
}

export function kotlinDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "companion_object") {
    return node.childForFieldName("name")?.text ?? "(companion)";
  }
  if (node.type === "secondary_constructor") return "constructor";
  return null;
}

export function bashVariableKind(node: SyntaxNode): SourceChunkKind {
  if (node.parent?.type !== "declaration_command") return "variable";
  const declaration = node.parent.text;
  if (/^readonly(?:\s|$)/.test(declaration)) return "constant";
  if (
    /^(?:declare|local|typeset)(?:\s|$)/.test(declaration) &&
    /(?:^|\s)-[A-Za-z]*r[A-Za-z]*(?:\s|$)/.test(declaration)
  ) return "constant";
  return "variable";
}

function ocamlBindingNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "value_name") return [node.text];
  return node.namedChildren.flatMap(ocamlBindingNames);
}

export function ocamlDeclaredName(node: SyntaxNode): string | null {
  if (node.type !== "value_definition") return null;
  const names = node.namedChildren
    .filter((child) => child.type === "let_binding")
    .flatMap((binding) => ocamlBindingNames(binding.childForFieldName("pattern")));
  return names.length > 0 ? names.join(", ") : null;
}

export function ocamlValueKind(node: SyntaxNode): SourceChunkKind {
  const bindings = node.namedChildren.filter((child) => child.type === "let_binding");
  return bindings.some(
    (binding) =>
      binding.namedChildren.some((child) => child.type === "parameter") ||
      binding.childForFieldName("body")?.type === "fun_expression",
  )
    ? "function"
    : "variable";
}

export function dartContains(node: SyntaxNode | null, types: Set<string>): boolean {
  if (!node) return false;
  if (types.has(node.type)) return true;
  return node.namedChildren.some((child) => dartContains(child, types));
}

function dartNames(node: SyntaxNode): string[] {
  if (["static_final_declaration", "initialized_identifier"].includes(node.type)) {
    return node.namedChildren.find((child) => child.type === "identifier")
      ? [node.namedChildren.find((child) => child.type === "identifier")!.text]
      : [];
  }
  if (node.type === "initialized_variable_definition") {
    return node.childForFieldName("name")?.text
      ? [node.childForFieldName("name")!.text]
      : [];
  }
  if (node.type === "pattern_variable_declaration") {
    const pattern = node.namedChildren.find((child) => child.type.endsWith("_pattern"));
    return pattern ? dartPatternNames(pattern) : [];
  }
  return node.namedChildren.flatMap(dartNames);
}

function dartPatternNames(node: SyntaxNode): string[] {
  if (node.type === "variable_pattern") {
    const name = node.namedChildren.filter((child) => child.type === "identifier").at(-1);
    return name ? [name.text] : [];
  }
  if (node.type === "constant_pattern") {
    const name = node.namedChildren.find((child) => child.type === "identifier");
    return name ? [name.text] : [];
  }
  return node.namedChildren.flatMap(dartPatternNames);
}

function dartSignatureName(node: SyntaxNode): string | null {
  const signature = node.type === "method_signature" ? node.namedChildren[0] : node;
  if (!signature) return null;
  if (["constructor_signature", "factory_constructor_signature"].includes(signature.type)) {
    const boundary = signature.namedChildren.find(
      (child) => child.type === "formal_parameter_list",
    )?.startIndex ?? signature.endIndex;
    const names = signature.namedChildren
      .filter((child) => child.type === "identifier" && child.endIndex <= boundary)
      .map((child) => child.text);
    return names.length > 0 ? names.join(".") : null;
  }
  const direct = signature.childForFieldName("name")?.text;
  if (direct) return direct;
  for (const child of signature.namedChildren) {
    const name = dartSignatureName(child);
    if (name) return name;
  }
  return null;
}

export function dartDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "part_of_directive") {
    return node.namedChildren.find((child) => child.type === "dotted_identifier_list")?.text ??
      null;
  }
  if (node.type === "extension_declaration") {
    return node.childForFieldName("name")?.text ??
      `(extension on ${node.childForFieldName("class")?.text ?? "?"})`;
  }
  if (node.type === "method_signature" || node.type === "function_signature") {
    return dartSignatureName(node);
  }
  if (node.type === "declaration" && dartContains(node, new Set(["constructor_signature"]))) {
    const signature = node.namedChildren.find((child) => child.type === "constructor_signature");
    return signature ? dartSignatureName(signature) : null;
  }
  if (node.type === "local_function_declaration") {
    const signature = node.namedChildren[0]?.namedChildren.find(
      (child) => child.type === "function_signature",
    );
    return signature ? dartSignatureName(signature) : null;
  }
  const names = dartNames(node);
  return names.length > 0 ? names.join(", ") : null;
}

export function dartVariableKind(node: SyntaxNode): SourceChunkKind {
  if (dartContains(node, new Set(["function_expression"]))) return "function";
  if (node.type === "declaration") {
    return dartContains(node, new Set(["constructor_signature"])) ? "method" : "field";
  }
  if (node.type === "static_final_declaration_list") {
    let previous = node.previousNamedSibling;
    while (previous && previous.endPosition.row === node.startPosition.row) {
      if (previous.type === "const_builtin") return "constant";
      previous = previous.previousNamedSibling;
    }
  }
  return NODE_TYPE_MAP[node.type] ?? "variable";
}

export function cssDeclaredName(node: SyntaxNode): string | null {
  if (!["media_statement", "supports_statement", "scope_statement", "at_rule"].includes(node.type)) {
    return null;
  }
  const block = node.namedChildren.find((child) => child.type === "block");
  const end = block ? block.startIndex - node.startIndex : node.text.length;
  return node.text.slice(0, end).trim().replace(/;$/, "").trim() || null;
}

export function kotlinClassKind(node: SyntaxNode): SourceChunkKind {
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  const words = modifiers?.text ?? "";
  if (
    /\binterface\b/.test(words) ||
    node.children.some((child) => child.type === "interface")
  ) return "interface";
  if (/\benum\b/.test(words)) return "enum";
  if (/\bannotation\b/.test(words)) return "annotation_type";
  if (/\b(?:data|value)\b/.test(words)) return "record";
  return "class";
}

export function luaAssignedNames(node: SyntaxNode): string | null {
  if (node.type === "field") {
    const name = node.childForFieldName("name")?.text;
    return name?.replace(/^(["'])(.*)\1$/, "$2") ?? null;
  }
  const assignment = node.type === "variable_declaration"
    ? node.namedChildren.find((child) => child.type === "assignment_statement") ?? node
    : node;
  const variables = assignment.namedChildren.find(
    (child) => child.type === "variable_list",
  );
  const names = variables?.namedChildren.map((child) => child.text) ?? [];
  return names.length > 0 ? names.join(", ") : null;
}

export function luaAssignedFunction(node: SyntaxNode): boolean {
  if (node.type === "field") {
    return node.childForFieldName("value")?.type === "function_definition";
  }
  const assignment = node.type === "variable_declaration"
    ? node.namedChildren.find((child) => child.type === "assignment_statement")
    : node;
  const values = assignment?.namedChildren.find(
    (child) => child.type === "expression_list",
  );
  return values?.namedChildren[0]?.type === "function_definition";
}

export function zigVariableKind(node: SyntaxNode): SourceChunkKind {
  if (node.namedChildren.some((child) => child.type === "struct_declaration")) {
    return "struct";
  }
  if (node.namedChildren.some((child) => child.type === "enum_declaration")) {
    return "enum";
  }
  if (node.namedChildren.some((child) => child.type === "union_declaration")) {
    return "struct";
  }
  if (
    node.namedChildren.some((child) =>
      ["opaque_declaration", "error_set_declaration"].includes(child.type)
    )
  ) return "type";
  return /^\s*const\b/.test(node.text) ? "constant" : "variable";
}

export function zigDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "test_declaration") {
    const name = node.namedChildren.find((child) => child.type === "string")?.text;
    return name?.replace(/^(["'])(.*)\1$/, "$2") ?? "(anonymous test)";
  }
  if (node.type === "comptime_declaration") return "comptime";
  return null;
}

function elixirCallTarget(node: SyntaxNode): string | null {
  return node.childForFieldName("target")?.text ?? null;
}

export function elixirDeclaredName(
  node: SyntaxNode,
  context: string | undefined,
  captured: string | null,
): string | null {
  if (context === "defimpl") {
    const argumentsNode = node.namedChildren.find((child) => child.type === "arguments");
    const protocol = argumentsNode?.namedChildren.find((child) => child.type === "alias")?.text;
    const implementation = argumentsNode?.namedChildren
      .find((child) => child.type === "keywords")
      ?.namedChildren.flatMap((child) => child.namedChildren)
      .find((child) => child.type === "alias")?.text;
    return protocol && implementation ? `${protocol} for ${implementation}` : protocol ?? captured;
  }
  if (context === "defstruct") {
    let current = node.parent;
    while (current) {
      if (current.type === "call" && elixirCallTarget(current) === "defmodule") {
        const module = current.namedChildren
          .find((child) => child.type === "arguments")
          ?.namedChildren.find((child) => child.type === "alias")?.text;
        return module?.split(".").at(-1) ?? "struct";
      }
      current = current.parent;
    }
    return "struct";
  }
  if (["callback", "macrocallback"].includes(context ?? "")) {
    return captured?.replace(/\(.*$/, "") ?? null;
  }
  return captured;
}

function declaratorName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (["identifier", "type_identifier", "field_identifier"].includes(node.type)) {
    return node.text;
  }
  const declarator = node.childForFieldName("declarator");
  if (declarator) return declaratorName(declarator);
  if (node.type === "parenthesized_declarator") {
    return declaratorName(node.namedChildren[0] ?? null);
  }
  return null;
}

function declaratorIsFunction(node: SyntaxNode): boolean {
  const wrappers: string[] = [];
  let current: SyntaxNode | null = node;
  while (current) {
    if (["function_declarator", "pointer_declarator", "array_declarator"].includes(current.type)) {
      wrappers.push(current.type);
    }
    if (current.type === "parenthesized_declarator") {
      current = current.namedChildren[0] ?? null;
    } else {
      current = current.childForFieldName("declarator");
    }
  }
  return wrappers.at(-1) === "function_declarator";
}

function cDeclarators(node: SyntaxNode): SyntaxNode[] {
  if (node.type === "function_definition") {
    const declarator = node.childForFieldName("declarator");
    return declarator ? [declarator] : [];
  }
  return node.childrenForFieldName("declarator");
}

export function cDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "preproc_ifdef") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    return node.children.some((child) => child.type === "#ifndef")
      ? `!defined(${name})`
      : `defined(${name})`;
  }
  if (node.type === "preproc_else") return "else";
  if (node.type === "preproc_call") {
    const directive = node.childForFieldName("directive")?.text;
    const argument = node.childForFieldName("argument")?.text.trim();
    return [directive, argument].filter(Boolean).join(" ") || null;
  }
  const names = cDeclarators(node)
    .map(declaratorName)
    .filter((name): name is string => name !== null);
  return names.length > 0 ? names.join(", ") : null;
}

export function cDeclarationKind(node: SyntaxNode): SourceChunkKind {
  const declarators = cDeclarators(node);
  if (declarators.length > 0 && declarators.every(declaratorIsFunction)) return "function";
  if (node.namedChildren.some(
    (child) => child.type === "type_qualifier" && child.text === "const",
  )) return "constant";
  return "variable";
}

function cppDeclaratorName(node: SyntaxNode | null): string | null {
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
  if (declarator) return cppDeclaratorName(declarator);
  if (
    node.type === "parenthesized_declarator" || node.type === "reference_declarator" ||
    node.type === "abstract_reference_declarator"
  ) return cppDeclaratorName(node.namedChildren[0] ?? null);
  return null;
}

function cppDeclarators(node: SyntaxNode): SyntaxNode[] {
  if (node.type === "function_definition") {
    const declarator = node.childForFieldName("declarator");
    return declarator ? [declarator] : [];
  }
  return node.childrenForFieldName("declarator");
}

export function cppTemplateDeclaration(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((child) => child.type !== "template_parameter_list") ?? null;
}

export function cppDeclaredName(node: SyntaxNode): string | null {
  if (node.type === "namespace_definition") {
    return node.childForFieldName("name")?.text ?? "(anonymous)";
  }
  if (node.type === "preproc_ifdef") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    return node.children.some((child) => child.type === "#ifndef")
      ? `!defined(${name})`
      : `defined(${name})`;
  }
  if (node.type === "preproc_else") return "else";
  if (node.type === "preproc_call") {
    const directive = node.childForFieldName("directive")?.text;
    const argument = node.childForFieldName("argument")?.text.trim();
    return [directive, argument].filter(Boolean).join(" ") || null;
  }
  if (node.type === "template_declaration") {
    const declaration = cppTemplateDeclaration(node);
    if (!declaration) return null;
    return declaration.childForFieldName("name")?.text ??
      cppDeclarators(declaration).map(cppDeclaratorName).find(Boolean) ?? null;
  }
  const names = cppDeclarators(node)
    .map(cppDeclaratorName)
    .filter((name): name is string => name !== null);
  return names.length > 0 ? names.join(", ") : null;
}

export function cppDeclarationKind(node: SyntaxNode): SourceChunkKind {
  const declarators = cppDeclarators(node);
  if (declarators.length > 0 && declarators.every(declaratorIsFunction)) {
    return node.type === "field_declaration" ? "method" : "function";
  }
  if (node.type === "field_declaration") return "field";
  if (node.namedChildren.some(
    (child) => child.type === "type_qualifier" &&
      ["const", "constexpr", "consteval", "constinit"].includes(child.text),
  )) return "constant";
  return "variable";
}

export function cppTemplateKind(node: SyntaxNode): SourceChunkKind {
  const declaration = cppTemplateDeclaration(node);
  if (!declaration) return "type";
  if (declaration.type === "class_specifier") return "class";
  if (declaration.type === "struct_specifier") return "struct";
  if (declaration.type === "enum_specifier") return "enum";
  if (declaration.type === "union_specifier") return "struct";
  if (declaration.type === "function_definition") return "function";
  return "type";
}

export function cppQualifiedMethod(node: SyntaxNode): boolean {
  const qualified = cppDeclarators(node)
    .map((declarator) => {
      let current: SyntaxNode | null = declarator;
      while (current && current.type !== "qualified_identifier") {
        current = current.type === "parenthesized_declarator"
          ? current.namedChildren[0] ?? null
          : current.childForFieldName("declarator");
      }
      return current;
    })
    .find((candidate): candidate is SyntaxNode => candidate !== null);
  const scope = qualified?.childForFieldName("scope")?.text.split("::").at(-1);
  if (!scope) return false;

  let root = node;
  while (root.parent) root = root.parent;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (
      ["class_specifier", "struct_specifier"].includes(current.type) &&
      current.childForFieldName("name")?.text === scope
    ) return true;
    stack.push(...current.namedChildren);
  }
  return false;
}
