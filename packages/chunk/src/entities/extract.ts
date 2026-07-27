import type { Node as SyntaxNode, Tree } from "web-tree-sitter";
import {
  bashVariableKind,
  cDeclarationKind,
  cDeclaredName,
  containsNodeType,
  cppDeclarationKind,
  cppDeclaredName,
  cppQualifiedMethod,
  cppTemplateDeclaration,
  cppTemplateKind,
  csharpDeclaredName,
  cssDeclaredName,
  dartContains,
  dartDeclaredName,
  dartVariableKind,
  elixirDeclaredName,
  goDeclaredName,
  javaDeclaredName,
  kotlinClassKind,
  kotlinClassParameterIsField,
  kotlinDeclaredName,
  luaAssignedFunction,
  luaAssignedNames,
  ocamlDeclaredName,
  ocamlValueKind,
  phpDeclaredName,
  rubyDeclaredName,
  rustDeclaredName,
  scalaClassParameterIsField,
  scalaDeclaredName,
  zigDeclaredName,
  zigVariableKind,
} from "./declared-names";
import { nodeTypeToKind } from "./kinds";
import type { Entity } from "./types";
import { loadQuery } from "../parsing/parser";
import type { Grammar } from "../parsing/parser";
import { QUERIES } from "../parsing/queries";
import type { Language, SourceChunkKind } from "../types";

/** Extract every entity match (all depths) via the language's query. */
export async function extractEntities(
  tree: Tree,
  language: Language,
  grammar: Grammar = language,
): Promise<Entity[]> {
  const queryString = QUERIES[language];
  if (!queryString) return [];

  const query = await loadQuery(grammar, queryString);
  const matches = query.matches(tree.rootNode);

  const entities: Entity[] = [];
  const seen = new Set<number>();

  for (const match of matches) {
    const itemCapture = match.captures.find((c) => c.name === "item");
    if (!itemCapture) continue;
    const node = itemCapture.node;
    if (
      language === "scala" && node.type === "class_parameter" &&
      !scalaClassParameterIsField(node)
    ) continue;
    if (
      language === "kotlin" && node.type === "class_parameter" &&
      !kotlinClassParameterIsField(node)
    ) continue;
    if (
      language === "bash" && node.type === "variable_assignment" &&
      node.parent?.type === "command"
    ) continue;
    if (
      language === "cpp" && node.parent?.type === "template_declaration" &&
      cppTemplateDeclaration(node.parent)?.id === node.id
    ) continue;
    const seenKey = language === "yaml" ? node.id : node.startIndex;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    const nameCapture = match.captures.find((c) => c.name === "name");

    // Elixir models everything as `call` nodes; the query's @context capture
    // holds the defining keyword (defmodule, def, defimpl, …) — use it to
    // pick an honest kind instead of blanket "function".
    let kind = nodeTypeToKind(node.type);
    if (match.captures.some((capture) => capture.name === "docstring")) {
      kind = "comment";
    }
    if (
      node.type === "variable_declarator" &&
      ["arrow_function", "function_expression"].includes(
        node.childForFieldName("value")?.type ?? "",
      )
    ) {
      kind = "function";
    }
    if (
      language === "go" &&
      ((node.type === "short_var_declaration" &&
        containsNodeType(node.childForFieldName("right"), "func_literal")) ||
        (node.type === "var_spec" &&
          containsNodeType(node.childForFieldName("value"), "func_literal")))
    ) {
      kind = "function";
    }
    if (
      language === "rust" && node.type === "let_declaration" &&
      containsNodeType(node.childForFieldName("value"), "closure_expression")
    ) {
      kind = "function";
    }
    if (
      language === "java" && node.type === "variable_declarator" &&
      containsNodeType(node.childForFieldName("value"), "lambda_expression")
    ) {
      kind = "function";
    }
    if (
      language === "csharp" && node.type === "variable_declarator" &&
      containsNodeType(node, "lambda_expression")
    ) kind = "function";
    if (language === "ruby" && node.type === "assignment") {
      kind = containsNodeType(node.childForFieldName("right"), "lambda")
        ? "function"
        : "constant";
    }
    if (language === "php" && node.type === "property_declaration") kind = "field";
    if (
      language === "php" && node.type === "assignment_expression" &&
      ["arrow_function", "anonymous_function"].includes(
        node.childForFieldName("right")?.type ?? "",
      )
    ) kind = "function";
    if (
      language === "scala" && ["val_definition", "var_definition"].includes(node.type) &&
      containsNodeType(node.childForFieldName("value"), "lambda_expression")
    ) kind = "function";
    if (language === "kotlin" && node.type === "class_declaration") {
      kind = kotlinClassKind(node);
    }
    if (language === "kotlin" && node.type === "property_declaration") {
      kind = "variable";
    }
    if (
      language === "kotlin" && node.type === "property_declaration" &&
      containsNodeType(node, "lambda_literal")
    ) kind = "function";
    if (language === "lua" && node.type === "function_declaration") {
      kind = node.childForFieldName("name")?.type === "method_index_expression"
        ? "method"
        : "function";
    }
    if (
      language === "lua" &&
      ["variable_declaration", "assignment_statement", "field"].includes(node.type) &&
      luaAssignedFunction(node)
    ) kind = "function";
    if (language === "zig" && node.type === "variable_declaration") {
      kind = zigVariableKind(node);
    }
    if (
      language === "zig" && node.type === "identifier" &&
      node.parent?.type === "error_set_declaration"
    ) kind = "constant";
    if (
      language === "elixir" && node.type === "binary_operator" &&
      containsNodeType(node.childForFieldName("right"), "anonymous_function")
    ) kind = "function";
    if (language === "bash" && node.type === "variable_assignment") {
      kind = bashVariableKind(node);
    }
    if (language === "haskell" && node.type === "header") kind = "module";
    if (language === "ocaml" && node.type === "value_definition") {
      kind = ocamlValueKind(node);
    }
    if (
      language === "dart" &&
      [
        "declaration",
        "static_final_declaration_list",
        "initialized_identifier_list",
        "local_variable_declaration",
      ].includes(node.type)
    ) kind = dartVariableKind(node);
    if (
      language === "dart" && node.type === "import_or_export" &&
      dartContains(node, new Set(["library_export"]))
    ) kind = "export";
    if (language === "java" && node.type === "block") kind = "initializer";
    if (language === "c" && node.type === "declaration") {
      kind = cDeclarationKind(node);
    }
    if (
      language === "cpp" &&
      ["declaration", "field_declaration"].includes(node.type)
    ) kind = cppDeclarationKind(node);
    if (language === "cpp" && node.type === "template_declaration") {
      kind = cppTemplateKind(node);
    }
    if (
      language === "cpp" && node.type === "function_definition" &&
      cppQualifiedMethod(node)
    ) kind = "method";
    if (
      language === "cpp" && node.type === "declaration" &&
      containsNodeType(node, "lambda_expression")
    ) kind = "function";
    if (language === "go" && node.type === "type_spec") {
      const declaredType = node.childForFieldName("type")?.type;
      if (declaredType === "struct_type") kind = "struct";
      else if (declaredType === "interface_type") kind = "interface";
    }
    const context = match.captures.find((c) => c.name === "context")?.node.text;
    if (language === "elixir") {
      if (context === "defmodule") kind = "module";
      else if (context === "defprotocol") kind = "trait";
      else if (context === "defimpl") kind = "impl";
      else if (context === "defstruct") kind = "struct";
      else if (["type", "typep", "opaque"].includes(context ?? "")) kind = "type";
      else if (["callback", "macrocallback"].includes(context ?? "")) kind = "method";
      else if (["import", "alias", "use", "require"].includes(context ?? "")) {
        kind = "import";
      }
    }
    if (language === "bash" && ["source", "."].includes(context ?? "")) {
      kind = "import";
    }

    const name = language === "go"
      ? goDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "rust"
      ? rustDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "java"
      ? javaDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "c"
      ? cDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "cpp"
      ? cppDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "csharp"
      ? csharpDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "ruby"
      ? rubyDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "php"
      ? phpDeclaredName(node) ?? nameCapture?.node.text.replace(/^\$/, "") ?? null
      : language === "scala"
      ? scalaDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "kotlin"
      ? kotlinDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "lua"
      ? luaAssignedNames(node) ?? nameCapture?.node.text ?? null
      : language === "zig"
      ? zigDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "elixir"
      ? elixirDeclaredName(node, context, nameCapture?.node.text ?? null)
      : language === "haskell" && node.type === "instance"
      ? `${nameCapture?.node.text ?? "?"} ${context ?? "?"}`
      : language === "ocaml"
      ? ocamlDeclaredName(node) ?? nameCapture?.node.text ?? null
      : language === "dart"
      ? nameCapture?.node.text ?? dartDeclaredName(node)
      : language === "css"
      ? cssDeclaredName(node) ?? nameCapture?.node.text ?? null
      : nameCapture?.node.text ?? null;

    let nodeEnd = language === "csharp" && node.type === "file_scoped_namespace_declaration"
      ? tree.rootNode.endIndex
      : node.endIndex;
    if (
      language === "php" && node.type === "namespace_definition" &&
      node.childForFieldName("body") === null
    ) {
      nodeEnd = tree.rootNode.namedChildren.find(
        (child) => child.type === "namespace_definition" && child.startIndex > node.startIndex,
      )?.startIndex ?? tree.rootNode.endIndex;
    }
    if (
      language === "scala" && node.type === "package_clause" &&
      node.childForFieldName("body") === null
    ) nodeEnd = tree.rootNode.endIndex;
    if (language === "kotlin" && node.type === "package_header") {
      nodeEnd = tree.rootNode.endIndex;
    }
    if (
      language === "dart" &&
      ["function_signature", "method_signature"].includes(node.type) &&
      node.nextNamedSibling?.type === "function_body"
    ) nodeEnd = node.nextNamedSibling.endIndex;
    if (language === "html" && node.type === "element") {
      const tag = node.namedChildren.find(
        (child) => child.type === "start_tag" || child.type === "self_closing_tag",
      );
      const hasEndTag = node.namedChildren.some((child) => child.type === "end_tag");
      if (tag && !hasEndTag) nodeEnd = tag.endIndex;
    }

    entities.push({
      kind,
      nodeType: node.type,
      name: name ?? (match.captures.some((capture) => capture.name === "default_export")
        ? "default"
        : null),
      nodeStart: node.startIndex,
      nodeEnd,
      startRow: node.startPosition.row,
      start: node.startIndex,
      end: nodeEnd,
      overloadSignature: match.captures.some((capture) => capture.name === "overload"),
      children: [],
    });
  }
  return entities;
}
