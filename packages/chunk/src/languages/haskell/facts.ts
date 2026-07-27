import type { Node as SyntaxNode, Tree } from "web-tree-sitter";
import type {
  CallBindingKind,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
} from "../../types";
import { chunkRef, factOwner, factSpan, walkSyntax } from "../fact-helpers";

interface Binding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

function importNames(node: SyntaxNode): SyntaxNode[] {
  const list = node.childForFieldName("names");
  return (
    list?.namedChildren.filter((child) => child.type === "import_name") ?? []
  );
}

function importedName(node: SyntaxNode): string | null {
  const name =
    node.childForFieldName("variable")?.text ??
    node.childForFieldName("type")?.text ??
    node.childForFieldName("prefix_id")?.text ??
    node.namedChildren[0]?.text ??
    null;
  return name?.replace(/^\((.*)\)$/, "$1") ?? null;
}

function importedNames(node: SyntaxNode): Array<{
  name: string;
  evidence: SyntaxNode;
}> {
  const names: Array<{ name: string; evidence: SyntaxNode }> = [];
  const parent = importedName(node);
  if (parent) names.push({ name: parent, evidence: node });
  const children = node.namedChildren.find((child) => child.type === "children");
  for (const child of children?.namedChildren ?? []) {
    const name = child.text.replace(/^\((.*)\)$/, "$1");
    if (name !== "..") names.push({ name, evidence: child });
  }
  return names;
}

function importFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact[] {
  const source = node.childForFieldName("module")?.text;
  if (!source) return [];
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  const base = {
    kind: "import" as const,
    source,
    typeOnly: false,
    static: false,
    global: false,
    owner,
  };
  const qualified = node.children.some((child) => child.type === "qualified");
  if (qualified) {
    const alias =
      node.childForFieldName("alias")?.text ?? source.split(".").at(-1)!;
    const hiding = node.children.some((child) => child.type === "hiding");
    const filters = importNames(node)
      .flatMap(importedNames)
      .map(({ name, evidence }) => ({
        ...base,
        imported: `qualified ${hiding ? "hiding " : ""}${name}`,
        local: null,
        ...factSpan(evidence, starts),
      }));
    return [
      { ...base, imported: "*", local: alias, ...factSpan(node, starts) },
      ...filters,
    ];
  }
  const names = importNames(node);
  const hiding = node.children.some((child) => child.type === "hiding");
  if (names.length === 0) {
    return [{ ...base, imported: "*", local: null, ...factSpan(node, starts) }];
  }
  return names
    .flatMap(importedNames)
    .map(({ name, evidence }) => ({
      ...base,
      imported: `${hiding ? "hiding " : ""}${name}`,
      local: hiding ? null : name,
      ...factSpan(evidence, starts),
    }));
}

function patternNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "variable") return [node.text];
  return node.namedChildren.flatMap(patternNames);
}

function chunkTargets(chunks: SourceChunk[], name: string): SourceChunkRef[] {
  return chunks
    .filter(
      (chunk) =>
        chunk.name === name &&
        (chunk.kind === "function" || chunk.kind === "type"),
    )
    .map(chunkRef);
}

function declarationTargets(
  root: SyntaxNode,
  chunks: SourceChunk[],
): Map<string, SourceChunkRef[]> {
  const targets = new Map<string, SourceChunkRef[]>();
  for (const node of walkSyntax(root)) {
    if (node.type !== "data_type" && node.type !== "newtype") continue;
    const target = factOwner(chunks, node.startIndex, node.endIndex);
    if (!target || target.kind !== "type") continue;
    for (const declaration of walkSyntax(node)) {
      const name = declaration.type === "constructor"
        ? declaration.text
        : declaration.type === "field"
        ? declaration.childForFieldName("name")?.text
        : null;
      if (!name) continue;
      const existing = targets.get(name) ?? [];
      if (!existing.some((candidate) => candidate.startOffset === target.startOffset)) {
        existing.push(target);
      }
      targets.set(name, existing);
    }
  }
  return targets;
}

function localDeclaration(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (
    node.type === "function" &&
    node.childForFieldName("name")?.text === name
  ) {
    const target = factOwner(chunks, node.startIndex, node.endIndex);
    return target?.kind === "function" && target.name === name
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (
    node.type === "bind" &&
    (node.childForFieldName("name")?.text === name ||
      patternNames(node.childForFieldName("pattern")).includes(name))
  ) {
    return { kind: "local", target: null };
  }
  return null;
}

function lexicalBinding(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (current.type === "function") {
      if (patternNames(current.childForFieldName("patterns")).includes(name)) {
        return { kind: "local", target: null };
      }
      if (current.childForFieldName("name")?.text === name) {
        const global = chunks
          .filter((chunk) => chunk.name === name && chunk.kind === "function")
          .map(chunkRef);
        if (global.length > 1) return { kind: "unknown", target: null };
        const target =
          global[0] ?? factOwner(chunks, current.startIndex, current.endIndex);
        if (target?.kind === "function" && target.name === name)
          return { kind: "source-chunk", target };
      }
      const localBinds = current.childForFieldName("binds");
      for (const declaration of localBinds?.namedChildren ?? []) {
        const binding = localDeclaration(declaration, name, chunks);
        if (binding) return binding;
      }
    }
    if (
      current.type === "lambda" &&
      patternNames(current.childForFieldName("patterns")).includes(name)
    ) {
      return { kind: "local", target: null };
    }
    if (current.type === "alternative") {
      const pattern = current.namedChildren[0] ?? null;
      if (
        pattern &&
        pattern.endIndex <= call.startIndex &&
        patternNames(pattern).includes(name)
      ) return { kind: "local", target: null };
    }
    if (current.type === "let_in" || current.type === "where") {
      const declarations = current.namedChildren.flatMap((child) =>
        child.type === "local_binds" ? child.namedChildren : [],
      );
      for (const declaration of declarations) {
        const binding = localDeclaration(declaration, name, chunks);
        if (binding) return binding;
      }
    }
    if (current.type === "do") {
      for (const statement of current.namedChildren) {
        if (statement.endIndex > call.startIndex) break;
        if (
          statement.type === "bind" &&
          patternNames(statement.childForFieldName("pattern")).includes(name)
        ) {
          return { kind: "local", target: null };
        }
      }
    }
    if (current.type === "list_comprehension") {
      const result = current.namedChildren[0] ?? null;
      const qualifiers = current.namedChildren.find(
        (child) => child.type === "qualifiers",
      );
      const inResult =
        result !== null &&
        result.startIndex <= call.startIndex &&
        result.endIndex >= call.endIndex;
      for (const qualifier of qualifiers?.namedChildren ?? []) {
        if (!inResult && qualifier.endIndex > call.startIndex) break;
        const patterns = qualifier.type === "generator"
          ? patternNames(qualifier.childForFieldName("pattern"))
          : qualifier.type === "let"
          ? qualifier.namedChildren
              .flatMap((child) => child.namedChildren)
              .flatMap((child) =>
                child.type === "bind"
                  ? patternNames(
                      child.childForFieldName("pattern") ??
                        child.childForFieldName("name"),
                    )
                  : [],
              )
          : [];
        if (patterns.includes(name)) return { kind: "local", target: null };
      }
    }
    current = current.parent;
  }
  return null;
}

function insidePattern(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node.parent;
  while (current && current.type !== "match" && current.type !== "function") {
    if (current.type === "patterns" || current.type === "pattern") return true;
    if (current.type === "alternative") {
      const pattern = current.namedChildren[0] ?? null;
      return pattern !== null &&
        pattern.startIndex <= node.startIndex &&
        pattern.endIndex >= node.endIndex;
    }
    current = current.parent;
  }
  return false;
}

function importedRoots(root: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "import") {
      const source = node.childForFieldName("module")?.text;
      const qualified = node.children.some(
        (child) => child.type === "qualified",
      );
      if (qualified && source) {
        names.add(
          node.childForFieldName("alias")?.text ?? source.split(".").at(-1)!,
        );
      } else if (!node.children.some((child) => child.type === "hiding")) {
        for (const item of importNames(node)) {
          for (const { name } of importedNames(item)) names.add(name);
        }
      }
    }
    stack.push(...node.namedChildren);
  }
  return names;
}

function calleeNode(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node.childForFieldName("function");
  while (current?.type === "apply")
    current = current.childForFieldName("function");
  return current;
}

function calleeRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "variable" || node.type === "constructor") return node.text;
  if (node.type === "qualified") return node.text.split(".")[0] ?? null;
  return (
    node.namedChildren.flatMap((child) => calleeRoot(child) ?? []).at(0) ?? null
  );
}

function resolve(
  node: SyntaxNode,
  root: string | null,
  chunks: SourceChunk[],
  imports: Set<string>,
  declarations: Map<string, SourceChunkRef[]>,
): Binding {
  if (!root) return { kind: "unknown", target: null };
  const lexical = lexicalBinding(node, root, chunks);
  if (lexical) return lexical;
  const targets = [
    ...chunkTargets(chunks, root),
    ...(declarations.get(root) ?? []),
  ].filter(
    (target, index, values) =>
      values.findIndex(
        (candidate) => candidate.startOffset === target.startOffset,
      ) === index,
  );
  if (targets.length > 0) {
    return targets.length === 1
      ? { kind: "source-chunk", target: targets[0]! }
      : { kind: "unknown", target: null };
  }
  if (imports.has(root)) return { kind: "import", target: null };
  return { kind: "unknown", target: null };
}

export function extractHaskellFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  const imports = importedRoots(tree.rootNode);
  const declarations = declarationTargets(tree.rootNode, chunks);
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "import")
      facts.push(...importFacts(node, chunks, starts));
    if (node.type === "apply" && !insidePattern(node)) {
      const parentFunction =
        node.parent?.type === "apply"
          ? node.parent.childForFieldName("function")
          : null;
      if (parentFunction?.id !== node.id) {
        const callee = calleeNode(node);
        const binding = resolve(
          node,
          calleeRoot(callee),
          chunks,
          imports,
          declarations,
        );
        facts.push({
          kind: "call",
          callee: callee?.text ?? node.text,
          binding: binding.kind,
          target: binding.target,
          owner: factOwner(chunks, node.startIndex, node.endIndex),
          ...factSpan(node, starts),
        });
      }
    }
    if (node.type === "infix" && !insidePattern(node)) {
      const operator = node.childForFieldName("operator");
      if (operator) {
        const binding = resolve(
          node,
          operator.text,
          chunks,
          imports,
          declarations,
        );
        facts.push({
          kind: "call",
          callee: operator.text,
          binding: binding.kind,
          target: binding.target,
          owner: factOwner(chunks, node.startIndex, node.endIndex),
          ...factSpan(node, starts),
        });
      }
    }
  }
  return facts.sort(
    (a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset,
  );
}
