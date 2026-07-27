import type { Node as SyntaxNode, Tree } from "web-tree-sitter";

import type {
  CallBindingKind,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
} from "../../types";
import { factOwner, factSpan, walkSyntax } from "../fact-helpers";

interface Binding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

interface ImportEntry {
  source: string;
  imported: string;
  local: string | null;
  evidence: SyntaxNode;
}

function importEntries(node: SyntaxNode): ImportEntry[] {
  const paths = node.namedChildren
    .filter((child) => child.type === "identifier")
    .map((path) => path.text);
  const selector = node.namedChildren.find(
    (child) =>
      child.type === "namespace_selectors" ||
      child.type === "namespace_wildcard",
  );
  if (!selector) {
    const renamed = node.namedChildren.find(
      (child) =>
        child.type === "arrow_renamed_identifier" ||
        child.type === "as_renamed_identifier",
    );
    if (renamed) {
      const imported = renamed.childForFieldName("name")?.text;
      const alias = renamed.childForFieldName("alias")?.text;
      if (!imported || !alias) return [];
      return [
        {
          source: paths.join("."),
          imported,
          local: alias === "_" ? null : alias,
          evidence: renamed,
        },
      ];
    }
    if (paths.length === 0) return [];
    const imported = paths.at(-1)!;
    return [
      {
        source: paths.slice(0, -1).join("."),
        imported,
        local: imported,
        evidence: node,
      },
    ];
  }
  const source = paths.join(".");
  if (selector.type === "namespace_wildcard") {
    const imported = selector.text === "given" ? "given" : "*";
    return [{ source, imported, local: null, evidence: selector }];
  }

  const entries: ImportEntry[] = [];
  for (let index = 0; index < selector.children.length; index++) {
    const child = selector.children[index]!;
    if (child.type === "identifier") {
      entries.push({
        source,
        imported: child.text,
        local: child.text,
        evidence: child,
      });
    } else if (
      child.type === "arrow_renamed_identifier" ||
      child.type === "as_renamed_identifier"
    ) {
      const imported = child.childForFieldName("name")?.text;
      const alias = child.childForFieldName("alias")?.text;
      if (imported && alias) {
        entries.push({
          source,
          imported,
          local: alias === "_" ? null : alias,
          evidence: child,
        });
      }
    } else if (child.type === "namespace_wildcard") {
      entries.push({ source, imported: "*", local: null, evidence: child });
    } else if (child.type === "given") {
      const type = selector.children
        .slice(index + 1)
        .find(
          (candidate) =>
            candidate.isNamed &&
            ["type_identifier", "generic_type", "compound_type"].includes(
              candidate.type,
            ),
        );
      if (type) {
        entries.push({
          source,
          imported: `given ${type.text}`,
          local: null,
          evidence: type,
        });
        index = selector.children.indexOf(type);
      } else {
        entries.push({
          source,
          imported: "given",
          local: null,
          evidence: child,
        });
      }
    }
  }
  return entries;
}

function importFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact[] {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return importEntries(node).map(
    (entry): ImportFact => ({
      kind: "import",
      source: entry.source,
      imported: entry.imported,
      local: entry.local,
      typeOnly: false,
      static: false,
      global: false,
      owner,
      ...factSpan(entry.evidence, starts),
    }),
  );
}

function patternNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (
    ["type_identifier", "stable_identifier", "wildcard", "alternative_pattern"]
      .includes(node.type)
  ) {
    return [];
  }
  const named = node.childForFieldName("name");
  if (named?.type === "identifier") {
    if (["parameter", "class_parameter", "binding"].includes(node.type)) {
      return [named.text];
    }
    if (node.type === "bind_pattern") {
      return [
        named.text,
        ...node.namedChildren
          .filter((child) => child.id !== named.id)
          .flatMap(patternNames),
      ];
    }
  }
  return node.namedChildren.flatMap(patternNames);
}

function parameterNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (["parameter", "class_parameter", "binding"].includes(node.type)) {
    return patternNames(node.childForFieldName("name") ?? node);
  }
  return node.namedChildren.flatMap(parameterNames);
}

function declaredChunk(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  kinds: Set<SourceChunk["kind"]>,
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return owner?.name === name && kinds.has(owner.kind) ? owner : null;
}

const TYPE_NODES = new Set([
  "class_definition",
  "object_definition",
  "trait_definition",
  "enum_definition",
  "type_definition",
  "package_object",
  "given_definition",
]);

function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (node.type === "val_definition" || node.type === "var_definition") {
    if (!patternNames(node.childForFieldName("pattern")).includes(name)) {
      return null;
    }
    const target = declaredChunk(node, name, chunks, new Set(["function"]));
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (
    node.type === "function_definition" ||
    node.type === "function_declaration"
  ) {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(
      node,
      name,
      chunks,
      new Set(["function", "method"]),
    );
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (TYPE_NODES.has(node.type)) {
    const declared = node.childForFieldName("name")?.text;
    if (declared !== name) return null;
    const target = declaredChunk(
      node,
      name,
      chunks,
      new Set(["class", "trait", "enum", "type", "module", "given"]),
    );
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (node.type === "import_declaration") {
    return importEntries(node).some((entry) => entry.local === name)
      ? { kind: "import", target: null }
      : null;
  }
  if (node.type === "assignment_expression") {
    const left = node.childForFieldName("left") ?? node.namedChildren[0] ?? null;
    return left?.type === "identifier" && left.text === name
      ? { kind: "local", target: null }
      : null;
  }
  return null;
}

function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (["identifier", "type_identifier", "this", "super"].includes(node.type))
    return node.text;
  if (node.type === "field_expression")
    return expressionRoot(node.childForFieldName("value"));
  if (node.type === "generic_function")
    return expressionRoot(node.childForFieldName("function"));
  if (node.type === "call_expression")
    return expressionRoot(node.childForFieldName("function"));
  if (node.type === "parenthesized_expression")
    return expressionRoot(node.namedChildren[0] ?? null);
  return null;
}

const MEMBER_SCOPES = new Set([
  "template_body",
  "enum_body",
  "with_template_body",
]);

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function controlBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
): Binding | null {
  if (scope.type === "for_expression") {
    const enumerators = scope.childForFieldName("enumerators") ??
      scope.namedChildren.find((child) => child.type === "enumerators");
    const body = scope.childForFieldName("body") ??
      scope.namedChildren.at(-1) ?? null;
    for (const enumerator of enumerators?.namedChildren ?? []) {
      if (enumerator.type !== "enumerator") continue;
      const pattern = enumerator.namedChildren[0] ?? null;
      if (
        patternNames(pattern).includes(name) &&
        (call.startIndex >= enumerator.endIndex || contains(body, call))
      ) return { kind: "local", target: null };
    }
  }
  if (scope.type === "case_clause") {
    const pattern = scope.childForFieldName("pattern") ??
      scope.namedChildren[0] ?? null;
    if (
      patternNames(pattern).includes(name) &&
      call.startIndex >= (pattern?.endIndex ?? scope.endIndex)
    ) return { kind: "local", target: null };
  }
  return null;
}

function scopedBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  includeFutureValues: boolean,
): Binding | null {
  const candidates: Binding[] = [];
  for (const child of scope.namedChildren) {
    const hoisted =
      TYPE_NODES.has(child.type) ||
      child.type === "function_definition" ||
      child.type === "function_declaration";
    if (!hoisted && !includeFutureValues && child.endIndex > call.startIndex)
      continue;
    const binding = declarationBinding(child, name, chunks);
    if (binding) candidates.push(binding);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) return { kind: "local", target: null };
  return null;
}

function resolve(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding {
  if (name === "this" || name === "super")
    return { kind: "local", target: null };
  let current: SyntaxNode | null = call.parent;
  while (current) {
    const control = controlBinding(current, call, name);
    if (control) return control;
    if (
      current.type === "function_definition" ||
      current.type === "function_declaration" ||
      current.type === "lambda_expression" ||
      current.type === "extension_definition"
    ) {
      for (const parameters of current.childrenForFieldName("parameters")) {
        if (parameterNames(parameters).includes(name))
          return { kind: "local", target: null };
      }
      const direct = current.childForFieldName("parameters");
      if (parameterNames(direct).includes(name))
        return { kind: "local", target: null };
    }
    if (current.type === "class_definition") {
      const parameters = current.childForFieldName("class_parameters") ??
        current.namedChildren.find(
          (child) => child.type === "class_parameters",
        );
      const body = current.childForFieldName("body") ??
        current.namedChildren.find((child) => child.type === "template_body");
      if (
        contains(body ?? null, call) &&
        parameterNames(parameters ?? null).includes(name)
      ) {
        return { kind: "local", target: null };
      }
    }
    if (current.type === "block" || current.type === "indented_block") {
      const binding = scopedBinding(current, call, name, chunks, false);
      if (binding) return binding;
    } else if (MEMBER_SCOPES.has(current.type)) {
      const binding = scopedBinding(current, call, name, chunks, true);
      if (binding) return binding;
    } else if (
      current.type === "compilation_unit" ||
      current.type === "package_clause"
    ) {
      const binding = scopedBinding(current, call, name, chunks, false);
      if (binding) return binding;
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

function callFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact | null {
  let callee: string | null = null;
  let root: string | null = null;
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    callee = fn?.text ?? null;
    root = expressionRoot(fn);
  } else if (node.type === "generic_function") {
    if (
      node.parent?.type === "call_expression" &&
      node.parent.childForFieldName("function")?.id === node.id
    ) {
      return null;
    }
    callee = node.text;
    root = expressionRoot(node);
  } else if (node.type === "infix_expression") {
    const left = node.childForFieldName("left");
    const operator = node.childForFieldName("operator");
    const right = node.childForFieldName("right");
    callee = left && operator ? `${left.text} ${operator.text}` : null;
    root = expressionRoot(operator?.text.endsWith(":") ? right : left);
  } else if (node.type === "instance_expression") {
    const type = node.namedChildren.find((child) =>
      ["type_identifier", "generic_type", "compound_type"].includes(child.type),
    );
    callee = type?.text ?? null;
    root = expressionRoot(type ?? null);
  }
  if (!callee) return null;
  const binding = root
    ? resolve(node, root, chunks)
    : { kind: "unknown" as const, target: null };
  return {
    kind: "call",
    callee,
    binding: binding.kind,
    target: binding.target,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, starts),
  };
}

const CALL_NODES = new Set([
  "call_expression",
  "generic_function",
  "infix_expression",
  "instance_expression",
]);

export function extractScalaFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "import_declaration") {
      facts.push(...importFacts(node, chunks, starts));
    } else if (CALL_NODES.has(node.type)) {
      const fact = callFact(node, chunks, starts);
      if (fact) facts.push(fact);
    }
  }
  return facts.sort(
    (left, right) =>
      left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset ||
      left.kind.localeCompare(right.kind),
  );
}
