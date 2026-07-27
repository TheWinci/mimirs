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
  factOwnerWhere,
  factSpan,
  syntaxDescendants,
  walkSyntax,
} from "../fact-helpers";

interface ResolvedCallBinding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  if (!path) return prefix;
  return `${prefix}::${path}`;
}

function terminal(path: string): string {
  return path.split("::").at(-1) ?? path;
}

function useLeaves(node: SyntaxNode, prefix = ""): Array<{
  source: string;
  local: string | null;
  evidence: SyntaxNode;
}> {
  if (node.type === "use_declaration") {
    const argument = node.childForFieldName("argument");
    return argument ? useLeaves(argument, prefix) : [];
  }
  if (node.type === "scoped_use_list") {
    const path = joinPath(prefix, node.childForFieldName("path")?.text ?? "");
    const list = node.childForFieldName("list");
    return list ? useLeaves(list, path) : [];
  }
  if (node.type === "use_list") {
    return node.namedChildren.flatMap((child) => useLeaves(child, prefix));
  }
  if (node.type === "use_as_clause") {
    const source = joinPath(prefix, node.childForFieldName("path")?.text ?? "");
    const local = node.childForFieldName("alias")?.text ?? terminal(source);
    return source ? [{ source, local, evidence: node }] : [];
  }
  if (node.type === "use_wildcard") {
    const path = node.text === "*" ? "" : node.text.replace(/::\*$/, "");
    const source = joinPath(prefix, path);
    return source ? [{ source, local: null, evidence: node }] : [];
  }
  if (node.type === "self") {
    return prefix ? [{ source: prefix, local: terminal(prefix), evidence: node }] : [];
  }
  if (
    node.type === "identifier" || node.type === "type_identifier" ||
    node.type === "scoped_identifier" || node.type === "crate" || node.type === "super"
  ) {
    const source = joinPath(prefix, node.text);
    return [{ source, local: terminal(source), evidence: node }];
  }
  return [];
}

function importFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return useLeaves(node).map((leaf): ImportFact => ({
    kind: "import",
    source: leaf.source,
    imported: "*",
    local: leaf.local,
    typeOnly: false,
    static: false,
    global: false,
    owner,
    ...factSpan(leaf.evidence, lineStarts),
  }));
}

function externalModuleFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact | null {
  if (node.childForFieldName("body") !== null) return null;
  const name = node.childForFieldName("name");
  if (!name) return null;
  return {
    kind: "import",
    source: name.text,
    imported: "module",
    local: name.text,
    typeOnly: false,
    static: true,
    global: false,
    owner: factOwnerWhere(
      chunks,
      node.startIndex,
      node.endIndex,
      (chunk) => chunk.kind !== "module" || chunk.name !== name.text,
    ),
    ...factSpan(name, lineStarts),
  };
}

function externalCrateFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact | null {
  const name = node.childForFieldName("name");
  if (!name) return null;
  const alias = node.childForFieldName("alias");
  return {
    kind: "import",
    source: name.text,
    imported: "*",
    local: alias?.text ?? name.text,
    typeOnly: false,
    static: false,
    global: false,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(name, lineStarts),
  };
}

function patternBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") {
    return node.text !== "_" && node.text[0] === node.text[0]?.toLowerCase()
      ? [node.text]
      : [];
  }
  if (
    node.type === "shorthand_field_identifier" ||
    node.type === "shorthand_field_identifier_pattern"
  ) return [node.text];
  if (node.type === "self") return ["self"];
  if (
    node.type === "scoped_identifier" || node.type === "field_expression" ||
    node.type === "type_identifier"
  ) return [];
  if (node.type === "match_pattern") {
    return patternBindings(node.namedChildren[0] ?? null);
  }
  if (node.type === "tuple_struct_pattern" || node.type === "struct_pattern") {
    const type = node.childForFieldName("type");
    return node.namedChildren
      .filter((child) => child.id !== type?.id)
      .flatMap((child) => patternBindings(child));
  }
  if (node.type === "field_pattern") {
    const pattern = node.childForFieldName("pattern");
    return pattern
      ? patternBindings(pattern)
      : patternBindings(node.childForFieldName("name"));
  }
  return node.namedChildren.flatMap((child) => patternBindings(child));
}

function parameterBindings(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "parameters" || node.type === "closure_parameters") {
    return node.namedChildren.flatMap((child) => parameterBindings(child));
  }
  if (node.type === "parameter") {
    return patternBindings(node.childForFieldName("pattern"));
  }
  if (node.type === "self_parameter") return ["self"];
  return patternBindings(node);
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

const CALLABLE_KINDS = new Set<SourceChunk["kind"]>(["function", "method", "macro"]);
const TYPE_KINDS = new Set<SourceChunk["kind"]>(["type", "struct", "enum", "trait"]);
const VARIANT_KINDS = new Set<SourceChunk["kind"]>(["constant"]);

function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  macroCall: boolean,
): ResolvedCallBinding | null {
  if (node.type === "use_declaration") {
    return useLeaves(node).some((leaf) => leaf.local === name)
      ? { kind: "import", target: null }
      : null;
  }
  if (node.type === "extern_crate_declaration") {
    const crate = node.childForFieldName("name");
    const alias = node.childForFieldName("alias");
    return crate && (alias?.text ?? crate.text) === name
      ? { kind: "import", target: null }
      : null;
  }
  if (node.type === "mod_item") {
    if (node.childForFieldName("name")?.text !== name) return null;
    return node.childForFieldName("body") === null
      ? { kind: "import", target: null }
      : { kind: "local", target: null };
  }
  if (node.type === "macro_definition") {
    if (!macroCall || node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks, CALLABLE_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (macroCall) return null;
  if (node.type === "function_item") {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks, CALLABLE_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (node.type === "let_declaration") {
    if (!patternBindings(node.childForFieldName("pattern")).includes(name)) return null;
    const target = declaredChunk(node, name, chunks, CALLABLE_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (
    node.type === "struct_item" || node.type === "union_item" || node.type === "enum_item" ||
    node.type === "trait_item" || node.type === "type_item"
  ) {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks, TYPE_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (node.type === "const_item" || node.type === "static_item") {
    return node.childForFieldName("name")?.text === name
      ? { kind: "local", target: null }
      : null;
  }
  return null;
}

function calleeRoot(callee: SyntaxNode): string | null {
  if (
    callee.type === "identifier" || callee.type === "type_identifier" ||
    callee.type === "self" || callee.type === "crate" || callee.type === "super"
  ) return callee.text;
  if (callee.type === "scoped_identifier") {
    const path = callee.childForFieldName("path");
    return path ? calleeRoot(path) : null;
  }
  if (callee.type === "field_expression") {
    const value = callee.childForFieldName("value");
    return value ? calleeRoot(value) : null;
  }
  if (callee.type === "generic_function" || callee.type === "generic_type") {
    const fn = callee.childForFieldName("function") ?? callee.childForFieldName("type");
    return fn ? calleeRoot(fn) : null;
  }
  if (callee.type === "call_expression") {
    const fn = callee.childForFieldName("function");
    return fn ? calleeRoot(fn) : null;
  }
  if (callee.type === "parenthesized_expression") {
    return callee.namedChildren[0] ? calleeRoot(callee.namedChildren[0]) : null;
  }
  return null;
}

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function directAssignmentBinding(
  node: SyntaxNode,
  name: string,
): ResolvedCallBinding | null {
  const expression = node.type === "expression_statement"
    ? node.namedChildren[0] ?? null
    : node;
  if (expression?.type !== "assignment_expression") return null;
  const left = expression.childForFieldName("left");
  return left?.type === "identifier" && left.text === name
    ? { kind: "local", target: null }
    : null;
}

function latestBlockBinding(
  block: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  macroCall: boolean,
): ResolvedCallBinding | null {
  let latest: ResolvedCallBinding | null = null;
  for (const child of block.namedChildren) {
    if (child.endIndex > call.startIndex) break;
    const binding = child.type === "let_declaration"
      ? declarationBinding(child, name, chunks, macroCall)
      : directAssignmentBinding(child, name);
    if (binding) latest = binding;
  }
  return latest;
}

function itemBinding(
  block: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  macroCall: boolean,
): ResolvedCallBinding | null {
  for (const child of block.namedChildren) {
    if (child.type === "let_declaration" || child.type === "expression_statement") continue;
    const binding = declarationBinding(child, name, chunks, macroCall);
    if (binding) return binding;
  }
  return null;
}

function conditionBindings(
  condition: SyntaxNode | null,
  call: SyntaxNode,
  name: string,
): ResolvedCallBinding | null {
  if (!condition) return null;
  const conditions = [condition, ...syntaxDescendants(condition)]
    .filter((node) => node.type === "let_condition");
  for (const letCondition of conditions) {
    const value = letCondition.childForFieldName("value");
    if (value && value.endIndex > call.startIndex) continue;
    if (patternBindings(letCondition.childForFieldName("pattern")).includes(name)) {
      return { kind: "local", target: null };
    }
  }
  return null;
}

function controlBinding(
  node: SyntaxNode,
  call: SyntaxNode,
  name: string,
): ResolvedCallBinding | null {
  if (node.type === "if_expression") {
    const condition = node.childForFieldName("condition");
    const consequence = node.childForFieldName("consequence");
    if (contains(condition, call) || contains(consequence, call)) {
      return conditionBindings(condition, call, name);
    }
  }
  if (node.type === "while_expression") {
    const condition = node.childForFieldName("condition");
    const body = node.childForFieldName("body");
    if (contains(condition, call) || contains(body, call)) {
      return conditionBindings(condition, call, name);
    }
  }
  if (
    node.type === "for_expression" && contains(node.childForFieldName("body"), call) &&
    patternBindings(node.childForFieldName("pattern")).includes(name)
  ) {
    return { kind: "local", target: null };
  }
  if (node.type === "match_arm") {
    const pattern = node.childForFieldName("pattern");
    if (patternBindings(pattern).includes(name)) {
      return { kind: "local", target: null };
    }
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
  const macroCall = call.type === "macro_invocation";

  let current: SyntaxNode | null = call.parent;
  while (current) {
    const controlled = controlBinding(current, call, name);
    if (controlled) return controlled;

    if (current.type === "function_item") {
      if (parameterBindings(current.childForFieldName("parameters")).includes(name)) {
        return { kind: "local", target: null };
      }
    } else if (current.type === "closure_expression") {
      if (parameterBindings(current.childForFieldName("parameters")).includes(name)) {
        return { kind: "local", target: null };
      }
    }

    if (current.type === "block") {
      const sequential = latestBlockBinding(current, call, name, chunks, macroCall);
      if (sequential) return sequential;
      const item = itemBinding(current, name, chunks, macroCall);
      if (item) return item;
    } else if (
      current.type === "source_file" ||
      (current.type === "declaration_list" && current.parent?.type === "mod_item")
    ) {
      for (const child of current.namedChildren) {
        const binding = declarationBinding(child, name, chunks, macroCall);
        if (binding) return binding;
      }
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

function scopedCallee(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "scoped_identifier") return node;
  if (node.type === "generic_function") {
    const fn = node.childForFieldName("function");
    return fn ? scopedCallee(fn) : null;
  }
  return null;
}

function associatedTargets(
  call: SyntaxNode,
  callee: SyntaxNode,
  binding: ResolvedCallBinding,
  chunks: SourceChunk[],
): SourceChunkRef[] {
  const scoped = scopedCallee(callee);
  const path = scoped?.childForFieldName("path") ?? null;
  const member = scoped?.childForFieldName("name")?.text;
  const root = path ? calleeRoot(path) : null;
  if (!scoped || root === null || member === undefined) return [];

  let sourceFile: SyntaxNode | null = call;
  while (sourceFile && sourceFile.type !== "source_file") sourceFile = sourceFile.parent;
  if (!sourceFile) return [];

  const targets: SourceChunkRef[] = [];
  if (binding.target?.kind === "enum") {
    for (const item of sourceFile.namedChildren) {
      if (item.type !== "enum_item" || item.childForFieldName("name")?.text !== root) continue;
      for (const variant of syntaxDescendants(item, "enum_variant")) {
        if (variant.childForFieldName("name")?.text !== member) continue;
        const target = declaredChunk(variant, member, chunks, VARIANT_KINDS);
        if (target) targets.push(target);
      }
    }
  }

  const impls = root === "Self"
    ? syntaxDescendants(sourceFile, "impl_item").filter((item) => contains(item, call))
    : sourceFile.namedChildren.filter(
      (item) =>
        item.type === "impl_item" && item.childForFieldName("trait") === null &&
        calleeRoot(item.childForFieldName("type") ?? item) === root,
    );
  for (const impl of impls) {
    const body = impl.childForFieldName("body");
    for (const item of body?.namedChildren ?? []) {
      if (item.type !== "function_item" || item.childForFieldName("name")?.text !== member) {
        continue;
      }
      const target = declaredChunk(item, member, chunks, CALLABLE_KINDS);
      if (target) targets.push(target);
    }
  }
  return targets;
}

function refineAssociatedCall(
  call: SyntaxNode,
  callee: SyntaxNode,
  binding: ResolvedCallBinding,
  chunks: SourceChunk[],
): ResolvedCallBinding {
  const scoped = scopedCallee(callee);
  if (!scoped) return binding;
  const targets = associatedTargets(call, callee, binding, chunks);
  if (targets.length === 1) return { kind: "source-chunk", target: targets[0]! };
  return binding.kind === "source-chunk" && binding.target !== null &&
      TYPE_KINDS.has(binding.target.kind)
    ? { kind: "local", target: null }
    : binding;
}

/** Extract Rust use paths, function calls, and macro invocations without export inference. */
export function extractRustFacts(
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "use_declaration") {
      facts.push(...importFacts(node, chunks, lineStarts));
    } else if (node.type === "extern_crate_declaration") {
      const fact = externalCrateFact(node, chunks, lineStarts);
      if (fact) facts.push(fact);
    } else if (node.type === "mod_item") {
      const fact = externalModuleFact(node, chunks, lineStarts);
      if (fact) facts.push(fact);
    } else if (node.type === "call_expression" || node.type === "macro_invocation") {
      const callee = node.childForFieldName(
        node.type === "call_expression" ? "function" : "macro",
      );
      if (callee) {
        const binding = refineAssociatedCall(
          node,
          callee,
          resolveCallBinding(node, callee, chunks),
          chunks,
        );
        facts.push({
          kind: "call",
          callee: node.type === "macro_invocation" ? `${callee.text}!` : callee.text,
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
