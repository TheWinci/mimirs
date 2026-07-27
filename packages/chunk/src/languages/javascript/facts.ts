import type { Node as SyntaxNode, Tree } from "web-tree-sitter";

import type {
  CallBindingKind,
  ExportFact,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
} from "../../types";
import {
  extractCommonJsFacts,
  staticRequireBinding,
  staticRequireSource,
} from "../ecmascript/commonjs";
import {
  factOwner,
  factSpan,
  syntaxDescendants,
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
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
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
  return pattern.namedChildren.flatMap((child) => bindingNames(child));
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

function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (node.type === "export_statement") {
    for (const child of node.namedChildren) {
      const binding = declarationBinding(child, name, chunks);
      if (binding) return binding;
    }
    return null;
  }

  if (node.type === "import_statement") {
    const clause = node.namedChildren.find((child) => child.type === "import_clause");
    if (!clause) return null;
    const locals = [
      ...clause.namedChildren
        .filter((child) => child.type === "identifier")
        .map((child) => child.text),
      ...syntaxDescendants(clause, "namespace_import").flatMap((namespace) =>
        namespace.namedChildren
          .filter((child) => child.type === "identifier")
          .map((child) => child.text)
      ),
      ...syntaxDescendants(clause, "import_specifier").flatMap((specifier) => {
        const imported = specifier.childForFieldName("name")?.text;
        return [specifier.childForFieldName("alias")?.text ?? imported].filter(
          (value): value is string => value !== undefined,
        );
      }),
    ];
    return locals.includes(name) ? { kind: "import", target: null } : null;
  }

  if (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration"
  ) {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = callableDeclaredBy(node, name, chunks);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    for (const declarator of syntaxDescendants(node, "variable_declarator")) {
      if (!bindingNames(declarator.childForFieldName("name")).includes(name)) continue;
      const value = declarator.childForFieldName("value");
      if (value && staticRequireBinding(value) !== null) {
        return { kind: "import", target: null };
      }
      const target = callableDeclaredBy(declarator, name, chunks);
      return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
    }
  }

  if (node.type === "class_declaration") {
    return node.childForFieldName("name")?.text === name
      ? { kind: "local", target: null }
      : null;
  }
  return null;
}

function calleeRoot(callee: SyntaxNode): string | null {
  if (callee.type === "identifier") return callee.text;
  if (callee.type === "member_expression" || callee.type === "subscript_expression") {
    const object = callee.childForFieldName("object");
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
  while (current) {
    if (
      current.type === "function_declaration" ||
      current.type === "function_expression" ||
      current.type === "arrow_function" ||
      current.type === "method_definition" ||
      current.type === "generator_function_declaration"
    ) {
      const parameters = current.childForFieldName("parameters");
      if (parameters) {
        for (const parameter of parameters.namedChildren) {
          if (bindingNames(parameter).includes(name)) {
            return { kind: "local", target: null };
          }
        }
      }
    }

    if (current.type === "catch_clause") {
      if (bindingNames(current.childForFieldName("parameter")).includes(name)) {
        return { kind: "local", target: null };
      }
    }

    if (current.type === "program" || current.type === "statement_block") {
      for (const child of current.namedChildren) {
        const binding = declarationBinding(child, name, chunks);
        if (binding) return binding;
      }
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

function extractImports(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const source = stringValue(node.childForFieldName("source"));
  if (source === null) return [];
  const clause = node.namedChildren.find((child) => child.type === "import_clause");
  if (!clause) {
    return [{
      kind: "import",
      source,
      imported: null,
      local: null,
      typeOnly: false,
      static: false,
      global: false,
      owner: null,
      ...factSpan(node, lineStarts),
    }];
  }

  const facts: ImportFact[] = [];
  const defaultBinding = clause.namedChildren.find((child) => child.type === "identifier");
  if (defaultBinding) {
    facts.push({
      kind: "import",
      source,
      imported: "default",
      local: defaultBinding.text,
      typeOnly: false,
      static: false,
      global: false,
      owner: factOwner(chunks, node.startIndex, node.endIndex),
      ...factSpan(defaultBinding, lineStarts),
    });
  }

  const namespace = clause.namedChildren.find((child) => child.type === "namespace_import");
  if (namespace) {
    const local = namespace.namedChildren.find((child) => child.type === "identifier");
    facts.push({
      kind: "import",
      source,
      imported: "*",
      local: local?.text ?? null,
      typeOnly: false,
      static: false,
      global: false,
      owner: factOwner(chunks, node.startIndex, node.endIndex),
      ...factSpan(namespace, lineStarts),
    });
  }

  const namedImports = clause.namedChildren.find((child) => child.type === "named_imports");
  if (namedImports) {
    for (const specifier of namedImports.namedChildren.filter(
      (child) => child.type === "import_specifier",
    )) {
      const imported = specifier.childForFieldName("name")?.text ?? null;
      const local = specifier.childForFieldName("alias")?.text ?? imported;
      facts.push({
        kind: "import",
        source,
        imported,
        local,
        typeOnly: false,
        static: false,
        global: false,
        owner: factOwner(chunks, node.startIndex, node.endIndex),
        ...factSpan(specifier, lineStarts),
      });
    }
  }
  return facts;
}

function declaredNames(node: SyntaxNode): string[] {
  for (const child of node.namedChildren) {
    if (child.type === "string" || child.type === "export_clause") continue;
    const name = child.childForFieldName("name");
    if (name) return [name.text];
    if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      const names: string[] = [];
      for (const declarator of syntaxDescendants(child, "variable_declarator")) {
        const declared = declarator.childForFieldName("name");
        if (declared?.type === "identifier") names.push(declared.text);
      }
      return names;
    }
  }
  return [];
}

function extractExports(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ExportFact[] {
  const source = stringValue(node.childForFieldName("source"));
  const names = declaredNames(node);
  const evidence = factSpan(node, lineStarts);
  const clause = node.namedChildren.find((child) => child.type === "export_clause");

  if (clause) {
    return clause.namedChildren
      .filter((child) => child.type === "export_specifier")
      .map((specifier): ExportFact => {
        const local = specifier.childForFieldName("name")?.text ?? null;
        return {
          kind: "export",
          exported: specifier.childForFieldName("alias")?.text ?? local ?? "default",
          local,
          source,
          typeOnly: false,
          owner: null,
          ...factSpan(specifier, lineStarts),
        };
      });
  }

  const namespace = node.namedChildren.find((child) => child.type === "namespace_export");
  if (namespace) {
    const exported = namespace.namedChildren.find((child) => child.type === "identifier");
    if (exported) {
      return [{
        kind: "export",
        exported: exported.text,
        local: "*",
        source,
        typeOnly: false,
        owner: null,
        ...factSpan(namespace, lineStarts),
      }];
    }
  }

  if (/^export\s+\*/.test(node.text)) {
    return [{
      kind: "export",
      exported: "*",
      local: null,
      source,
      typeOnly: false,
      owner: null,
      ...evidence,
    }];
  }

  if (/^export\s+default\b/.test(node.text)) {
    return [{
      kind: "export",
      exported: "default",
      local: names[0] ?? null,
      source,
      typeOnly: false,
      owner: null,
      ...evidence,
    }];
  }
  return names.map((name): ExportFact => ({
    kind: "export",
    exported: name,
    local: name,
    source,
    typeOnly: false,
    owner: null,
    ...evidence,
  }));
}

/** Extract JavaScript facts from the same parse used to build source chunks. */
export function extractJavaScriptFacts(
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact[] {
  const facts: SourceFact[] = extractCommonJsFacts(tree, chunks, lineStarts);
  const stack: SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "import_statement") {
      facts.push(...extractImports(node, chunks, lineStarts));
    } else if (node.type === "export_statement") {
      facts.push(...extractExports(node, chunks, lineStarts));
    } else if (
      node.type === "call_expression" &&
      staticRequireSource(node) === null
    ) {
      const callee = node.childForFieldName("function");
      if (callee) {
        const binding = resolveCallBinding(node, callee, chunks);
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
    for (let index = node.namedChildren.length - 1; index >= 0; index--) {
      stack.push(node.namedChildren[index]!);
    }
  }
  return facts.sort(
    (left, right) => left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset || left.kind.localeCompare(right.kind),
  );
}
