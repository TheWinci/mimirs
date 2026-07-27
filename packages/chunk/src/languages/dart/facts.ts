import type { Node as SyntaxNode, Tree } from "web-tree-sitter";
import type {
  CallBindingKind,
  ExportFact,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
  SourceSpan,
} from "../../types";
import {
  chunkRef,
  factOwner,
  factSpan,
  syntaxDescendants,
} from "../fact-helpers";

interface Binding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

function offsetToLine(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function spanRange(start: number, end: number, starts: number[]): SourceSpan {
  return {
    startOffset: start,
    endOffset: end,
    startLine: offsetToLine(starts, start),
    endLine: offsetToLine(starts, Math.max(start, end - 1)),
  };
}

function descendants(node: SyntaxNode, type: string): SyntaxNode[] {
  return [
    ...(node.type === type ? [node] : []),
    ...syntaxDescendants(node, type),
  ];
}

function unquote(value: string): string {
  return value.replace(/^[rR]?(["'])(.*)\1$/s, "$2");
}

function uriNodes(node: SyntaxNode): SyntaxNode[] {
  return descendants(node, "uri");
}

function shownNames(node: SyntaxNode): string[] | null {
  let shown: Set<string> | null = null;
  const hidden = new Set<string>();
  for (const combinator of descendants(node, "combinator")) {
    const names = combinator.namedChildren
      .filter((child) => child.type === "identifier")
      .map((child) => child.text);
    if (/^\s*hide\b/.test(combinator.text)) {
      for (const name of names) hidden.add(name);
    } else if (names.length > 0) {
      shown = shown === null
        ? new Set(names)
        : new Set(names.filter((name) => shown!.has(name)));
    }
  }
  if (shown === null) return null;
  for (const name of hidden) shown.delete(name);
  return [...shown];
}

function importAlias(node: SyntaxNode): string | null {
  const specification = descendants(node, "import_specification")[0];
  if (!specification) return null;
  const combinator = descendants(specification, "combinator")[0];
  return (
    specification.namedChildren.find(
      (child) => child.type === "identifier" && child.id !== combinator?.id,
    )?.text ?? null
  );
}

function importFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const owner =
    node.type === "part_of_directive"
      ? null
      : factOwner(chunks, node.startIndex, node.endIndex);
  if (node.type === "part_directive" || node.type === "part_of_directive") {
    const source =
      node.type === "part_directive"
        ? unquote(
            uriNodes(node)[0]?.namedChildren[0]?.text ??
              uriNodes(node)[0]?.text ??
              "",
          )
        : (node.namedChildren.find(
            (child) => child.type === "dotted_identifier_list",
          )?.text ?? unquote(uriNodes(node)[0]?.text ?? ""));
    if (!source) return [];
    return [
      {
        kind: "import",
        source,
        imported: node.type === "part_directive" ? "part" : "part of",
        local: null,
        typeOnly: false,
        static: false,
        global: false,
        owner,
        ...factSpan(node, starts),
      },
    ];
  }
  if (node.type !== "import_or_export") return [];
  const exported = descendants(node, "library_export").length > 0;
  const uris = uriNodes(node);
  if (exported) {
    const source = unquote(
      uris[0]?.namedChildren[0]?.text ?? uris[0]?.text ?? "",
    );
    if (!source) return [];
    const shown = shownNames(node);
    const names = shown === null || shown.length === 0 ? ["*"] : shown;
    return names.map<ExportFact>((name) => ({
      kind: "export",
      exported: name,
      local: name === "*" ? null : name,
      source,
      typeOnly: false,
      owner,
      ...factSpan(node, starts),
    }));
  }
  const alias = importAlias(node);
  const shown = shownNames(node);
  return uris.flatMap<ImportFact>((uri, index) => {
    const source = unquote(uri.namedChildren[0]?.text ?? uri.text);
    if (!source) return [];
    const base = {
      kind: "import" as const,
      source,
      typeOnly: false,
      static: false,
      global: false,
      owner,
      ...factSpan(index === 0 ? node : uri, starts),
    };
    if (index > 0) return [{ ...base, imported: "conditional", local: alias }];
    if (alias) return [{ ...base, imported: "*", local: alias }];
    if (shown !== null && shown.length > 0) {
      return shown.map((name) => ({
        ...base,
        imported: name,
        local: name,
      }));
    }
    return [{ ...base, imported: "*", local: null }];
  });
}

function chunkTargets(
  chunks: SourceChunk[],
  name: string,
  nested = false,
): SourceChunkRef[] {
  const values: SourceChunkRef[] = [];
  for (const chunk of chunks) {
    if (
      chunk.name === name &&
      (chunk.kind === "function" || chunk.kind === "class") &&
      (!nested || chunk.kind === "function")
    )
      values.push(chunkRef(chunk));
    values.push(...chunkTargets(chunk.children, name, true));
  }
  return values;
}

function parameterNames(node: SyntaxNode): string[] {
  const parameters =
    node.type === "function_expression"
      ? node.childForFieldName("parameters")
      : (descendants(node, "formal_parameter_list")[0] ?? null);
  if (!parameters) return [];
  return descendants(parameters, "formal_parameter")
    .flatMap((parameter) => parameter.childForFieldName("name")?.text ?? [])
    .filter(Boolean);
}

function localNames(node: SyntaxNode): string[] {
  if (node.type === "initialized_variable_definition") {
    return node.childForFieldName("name")?.text
      ? [node.childForFieldName("name")!.text]
      : [];
  }
  if (node.type === "local_function_declaration") {
    return descendants(node, "function_signature")[0]?.childForFieldName("name")
      ?.text
      ? [
          descendants(node, "function_signature")[0]!.childForFieldName("name")!
            .text,
        ]
      : [];
  }
  if (node.type === "pattern_variable_declaration") {
    const pattern = node.namedChildren.find((child) => child.type.endsWith("_pattern"));
    return pattern ? declarationPatternNames(pattern) : [];
  }
  return [];
}

function patternVariableNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  return descendants(node, "variable_pattern").flatMap((pattern) =>
    pattern.namedChildren.filter((child) => child.type === "identifier").at(-1)?.text ?? []
  );
}

function declarationPatternNames(node: SyntaxNode): string[] {
  const names = patternVariableNames(node);
  for (const pattern of descendants(node, "constant_pattern")) {
    const identifier = pattern.namedChildren.find((child) => child.type === "identifier");
    if (identifier) names.push(identifier.text);
  }
  return [...new Set(names)];
}

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function declarationBinding(
  declaration: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (!localNames(declaration).includes(name)) return null;
  const owner = factOwner(chunks, declaration.startIndex, declaration.endIndex);
  return owner?.kind === "function" && owner.name === name
    ? { kind: "source-chunk", target: owner }
    : { kind: "local", target: null };
}

function directDeclarations(node: SyntaxNode): SyntaxNode[] {
  return [node, ...node.namedChildren].filter((candidate) => localNames(candidate).length > 0);
}

function controlBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (scope.type === "for_statement") {
    const parts = scope.namedChildren.find((child) => child.type === "for_loop_parts");
    const body = scope.childForFieldName("body");
    const declaration = parts?.namedChildren.find(
      (child) => child.type === "local_variable_declaration",
    );
    if (declaration && declaration.endIndex <= call.startIndex) {
      for (const candidate of directDeclarations(declaration)) {
        const binding = declarationBinding(candidate, name, chunks);
        if (binding) return binding;
      }
    }
    const direct = parts?.childForFieldName("name")?.text === name;
    const pattern = parts?.namedChildren.find((child) => child.type.endsWith("_pattern"));
    if (
      contains(body, call) &&
      (direct || (pattern ? declarationPatternNames(pattern).includes(name) : false))
    ) return { kind: "local", target: null };
  }
  if (scope.type === "try_statement") {
    const children = scope.namedChildren;
    for (let index = 0; index < children.length - 1; index++) {
      const clause = children[index]!;
      const body = children[index + 1]!;
      if (clause.type !== "catch_clause" || body.type !== "block" || !contains(body, call)) {
        continue;
      }
      const parameters = descendants(clause, "catch_parameters")[0];
      if (parameters?.namedChildren.some(
        (child) => child.type === "identifier" && child.text === name,
      )) return { kind: "local", target: null };
    }
  }
  if (scope.type === "if_statement") {
    const pattern = scope.namedChildren.find((child) => child.type.endsWith("_pattern"));
    const consequence = scope.childForFieldName("consequence");
    if (
      pattern && patternVariableNames(pattern).includes(name) &&
      call.startIndex >= pattern.endIndex && consequence && call.endIndex <= consequence.endIndex
    ) return { kind: "local", target: null };
  }
  if (scope.type === "switch_statement_case" || scope.type === "switch_expression_case") {
    const patterns = scope.namedChildren.filter((child) => child.type.endsWith("_pattern"));
    const lastPatternEnd = patterns.at(-1)?.endIndex ?? scope.startIndex;
    if (
      patterns.flatMap(patternVariableNames).includes(name) &&
      call.startIndex >= lastPatternEnd && contains(scope, call)
    ) return { kind: "local", target: null };
  }
  return null;
}

function importedBindings(root: SyntaxNode, before: number): Set<string> {
  const bindings = new Set<string>();
  for (const child of root.namedChildren) {
    if (child.startIndex > before || child.type !== "import_or_export")
      continue;
    const alias = importAlias(child);
    if (alias) {
      bindings.add(alias);
      continue;
    }
    for (const name of shownNames(child) ?? []) bindings.add(name);
  }
  return bindings;
}

function lexicalBinding(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  let current: SyntaxNode | null = call;
  while (current) {
    const control = controlBinding(current, call, name, chunks);
    if (control) return control;
    if (current.type === "function_body") {
      const signature = current.previousNamedSibling;
      if (
        signature &&
        ["function_signature", "method_signature"].includes(signature.type) &&
        parameterNames(signature).includes(name)
      )
        return { kind: "local", target: null };
    }
    if (
      [
        "function_expression",
        "method_signature",
        "function_signature",
      ].includes(current.type) &&
      parameterNames(current).includes(name)
    )
      return { kind: "local", target: null };
    if (current.type === "block") {
      for (const child of current.namedChildren) {
        if (child.endIndex > call.startIndex) break;
        for (const declaration of directDeclarations(child)) {
          const binding = declarationBinding(declaration, name, chunks);
          if (binding) return binding;
        }
      }
    } else if (current.type === "class_body") {
      if (current.namedChildren.some(
        (child) => child.type === "declaration" && dartMemberNames(child).includes(name),
      )) return { kind: "local", target: null };
    } else if (current.type === "extension_type_declaration") {
      const representation = current.namedChildren.find(
        (child) => child.type === "representation_declaration",
      );
      if (representation?.childForFieldName("name")?.text === name) {
        return { kind: "local", target: null };
      }
    }
    current = current.parent;
  }
  return null;
}

function dartMemberNames(node: SyntaxNode): string[] {
  return descendants(node, "initialized_identifier").flatMap((declaration) =>
    declaration.namedChildren.find((child) => child.type === "identifier")?.text ?? []
  );
}

function resolve(
  node: SyntaxNode,
  root: string | null,
  tree: Tree,
  chunks: SourceChunk[],
): Binding {
  if (!root) return { kind: "unknown", target: null };
  const lexical = lexicalBinding(node, root, chunks);
  if (lexical) return lexical;
  if (importedBindings(tree.rootNode, node.startIndex).has(root)) {
    return { kind: "import", target: null };
  }
  const targets = chunkTargets(chunks, root);
  return targets.length === 1
    ? { kind: "source-chunk", target: targets[0]! }
    : { kind: "unknown", target: null };
}

function selectorMember(node: SyntaxNode): string | null {
  if (node.type !== "selector") return null;
  if (descendants(node, "argument_part").length > 0) return null;
  const name = descendants(node, "identifier")[0]?.text;
  if (!name) return null;
  return node.text.includes("?.") || node.text.startsWith("?")
    ? `?.${name}`
    : `.${name}`;
}

function isCallBase(node: SyntaxNode): boolean {
  return ["identifier", "this", "super", "dot_shorthand"].includes(node.type);
}

function sequenceCalls(
  node: SyntaxNode,
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  const children = node.namedChildren;
  for (let index = 0; index < children.length; index++) {
    const base = children[index]!;
    if (!isCallBase(base)) continue;
    let callee = base.text;
    const root = base.type === "identifier" ? base.text : null;
    for (let cursor = index + 1; cursor < children.length; cursor++) {
      const selector = children[cursor]!;
      if (selector.type !== "selector") break;
      const member = selectorMember(selector);
      if (member) {
        callee += member;
        continue;
      }
      if (descendants(selector, "argument_part").length > 0) {
        const binding = resolve(base, root, tree, chunks);
        facts.push({
          kind: "call",
          callee,
          binding: binding.kind,
          target: binding.target,
          owner: factOwner(chunks, base.startIndex, selector.endIndex),
          ...spanRange(base.startIndex, selector.endIndex, starts),
        });
        callee += "()";
      }
    }
  }
  return facts;
}

function cascadeFact(
  node: SyntaxNode,
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact | null {
  const selector = node.namedChildren.find(
    (child) => child.type === "cascade_selector",
  );
  const name = selector ? descendants(selector, "identifier")[0]?.text : null;
  if (!name || descendants(node, "argument_part").length === 0) return null;
  let current: SyntaxNode | null = node.parent;
  while (current && current.type !== "initialized_variable_definition")
    current = current.parent;
  const root = current?.childForFieldName("name")?.text ?? null;
  const binding: Binding = root
    ? { kind: "local", target: null }
    : resolve(node, root, tree, chunks);
  return {
    kind: "call",
    callee: `${root ?? ""}..${name}`,
    binding: binding.kind,
    target: binding.target,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, starts),
  };
}

export function extractDartFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  const stack = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "annotation") continue;
    if (
      ["import_or_export", "part_directive", "part_of_directive"].includes(
        node.type,
      )
    ) {
      facts.push(...importFacts(node, chunks, starts));
    }
    facts.push(...sequenceCalls(node, tree, chunks, starts));
    if (node.type === "cascade_section") {
      const called = cascadeFact(node, tree, chunks, starts);
      if (called) facts.push(called);
    }
    for (let index = node.namedChildren.length - 1; index >= 0; index--) {
      stack.push(node.namedChildren[index]!);
    }
  }
  return facts.sort(
    (a, b) =>
      a.startOffset - b.startOffset ||
      a.endOffset - b.endOffset ||
      a.kind.localeCompare(b.kind),
  );
}
