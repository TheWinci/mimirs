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
  chunkRef,
  factOwner,
  factSpan,
  syntaxDescendants,
} from "../fact-helpers";

interface ResolvedCallBinding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

function findEnclosingModule(
  chunks: SourceChunk[],
  startOffset: number,
  endOffset: number,
  declaredName: string | null,
  owner: SourceChunkRef | null = null,
): SourceChunkRef | null {
  for (const chunk of chunks) {
    if (chunk.startOffset > startOffset || chunk.endOffset < endOffset) continue;
    const nextOwner = chunk.kind === "module" && chunk.name !== null && chunk.name !== declaredName
      ? chunkRef(chunk)
      : owner;
    return findEnclosingModule(chunk.children, startOffset, endOffset, declaredName, nextOwner);
  }
  return owner;
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
    const requireClause = node.namedChildren.find(
      (child) => child.type === "import_require_clause",
    );
    if (requireClause) {
      const local = requireClause.namedChildren.find(
        (child) => child.type === "identifier",
      );
      return local?.text === name ? { kind: "import", target: null } : null;
    }
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

  if (
    node.type === "lexical_declaration" || node.type === "variable_declaration" ||
    node.type === "using_declaration"
  ) {
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

  if (
    node.type === "class_declaration" || node.type === "enum_declaration" ||
    node.type === "internal_module"
  ) {
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
          const pattern = parameter.childForFieldName("pattern") ?? parameter;
          if (bindingNames(pattern).includes(name)) return { kind: "local", target: null };
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
  const requireClause = node.namedChildren.find(
    (child) => child.type === "import_require_clause",
  );
  const source = stringValue(
    node.childForFieldName("source") ?? requireClause?.childForFieldName("source") ?? null,
  );
  if (source === null) return [];
  if (requireClause) {
    const local = requireClause.namedChildren.find(
      (child) => child.type === "identifier",
    );
    return [{
      kind: "import",
      source,
      imported: "*",
      local: local?.text ?? null,
      typeOnly: false,
      static: false,
      global: false,
      owner: factOwner(chunks, node.startIndex, node.endIndex),
      ...factSpan(requireClause, lineStarts),
    }];
  }
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
  const wholeTypeOnly = /^import\s+type\b/.test(node.text);
  const defaultBinding = clause.namedChildren.find((child) => child.type === "identifier");
  if (defaultBinding) {
    facts.push({
      kind: "import",
      source,
      imported: "default",
      local: defaultBinding.text,
      typeOnly: wholeTypeOnly,
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
      typeOnly: wholeTypeOnly,
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
        typeOnly: wholeTypeOnly || /^type\b/.test(specifier.text.trim()),
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
  if (/^export\s*=/.test(node.text)) {
    const local = node.namedChildren.find((child) => child.type === "identifier");
    return [{
      kind: "export",
      exported: "default",
      local: local?.text ?? null,
      source: null,
      typeOnly: false,
      owner: findEnclosingModule(chunks, node.startIndex, node.endIndex, null),
      ...factSpan(node, lineStarts),
    }];
  }
  const wholeTypeOnly = /^export\s+type\b/.test(node.text);
  const names = declaredNames(node);
  const owner = findEnclosingModule(
    chunks,
    node.startIndex,
    node.endIndex,
    names[0] ?? null,
  );
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
          typeOnly: wholeTypeOnly || /^type\b/.test(specifier.text.trim()),
          owner,
          ...factSpan(specifier, lineStarts),
        };
      });
  }

  if (/^export\s+\*/.test(node.text)) {
    return [{
      kind: "export",
      exported: "*",
      local: null,
      source,
      typeOnly: wholeTypeOnly,
      owner,
      ...evidence,
    }];
  }

  const isDefault = /^export\s+default\b/.test(node.text);
  if (isDefault) {
    return [{
      kind: "export",
      exported: "default",
      local: names[0] ?? null,
      source,
      typeOnly: false,
      owner,
      ...evidence,
    }];
  }
  return names.map((name): ExportFact => ({
    kind: "export",
    exported: name,
    local: name,
    source,
    typeOnly: wholeTypeOnly,
    owner,
    ...evidence,
  }));
}

/** Extract TypeScript facts from the same parse used to build source chunks. */
export function extractTypeScriptFacts(
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
  const sorted = facts.sort(
    (left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset ||
      left.kind.localeCompare(right.kind),
  );
  const collapsed: SourceFact[] = [];
  for (const fact of sorted) {
    const previous = collapsed[collapsed.length - 1];
    if (
      fact.kind === "export" && previous?.kind === "export" &&
      fact.exported === previous.exported && fact.local === previous.local &&
      fact.source === previous.source && fact.typeOnly === previous.typeOnly &&
      fact.owner?.kind === previous.owner?.kind && fact.owner?.name === previous.owner?.name
    ) {
      previous.endOffset = Math.max(previous.endOffset, fact.endOffset);
      previous.endLine = Math.max(previous.endLine, fact.endLine);
      continue;
    }
    collapsed.push(fact);
  }
  return collapsed;
}
