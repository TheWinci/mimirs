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

type UseKind = "class" | "function" | "const";

interface UseEntry {
  source: string;
  kind: UseKind;
  local: string;
  evidence: SyntaxNode;
}

function terminal(path: string): string {
  return path.split("\\").at(-1) ?? path;
}

function useKind(node: SyntaxNode, clause: SyntaxNode): UseKind {
  const children = [...node.children, ...clause.children];
  if (children.some((child) => child.type === "function")) return "function";
  if (children.some((child) => child.type === "const")) return "const";
  return "class";
}

function useEntries(node: SyntaxNode): UseEntry[] {
  const group = node.childForFieldName("body");
  const prefix = group
    ? (node.namedChildren.find((child) => child.type === "namespace_name")
        ?.text ?? "")
    : "";
  const clauses =
    group?.namedChildren.filter(
      (child) => child.type === "namespace_use_clause",
    ) ??
    node.namedChildren.filter((child) => child.type === "namespace_use_clause");
  return clauses.flatMap((clause): UseEntry[] => {
    const kind = useKind(node, clause);
    const alias = clause.childForFieldName("alias")?.text ?? null;
    const target = clause.namedChildren.find(
      (child) => child.id !== clause.childForFieldName("alias")?.id,
    )?.text;
    if (!target) return [];
    const source = prefix ? `${prefix}\\${target}` : target;
    return [
      {
        source,
        kind,
        local: alias ?? terminal(source),
        evidence: clause,
      },
    ];
  });
}

function useFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact[] {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return useEntries(node).map(
    (entry): ImportFact => ({
      kind: "import",
      source: entry.source,
      imported: entry.kind,
      local: entry.local,
      typeOnly: entry.kind === "const",
      static: entry.kind === "function",
      global: false,
      owner,
      ...factSpan(entry.evidence, starts),
    }),
  );
}

function literalString(node: SyntaxNode | null): string | null {
  if (!node || !["encapsed_string", "string"].includes(node.type)) return null;
  if (node.namedChildren.some((child) => child.type !== "string_content"))
    return null;
  const value = node.text;
  return value.length >= 2 ? value.slice(1, -1) : "";
}

const RUNTIME_IMPORTS = new Set([
  "require_expression",
  "require_once_expression",
  "include_expression",
  "include_once_expression",
]);

function runtimeImportFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact[] | null {
  const expression = node.namedChildren[0] ?? null;
  const unwrapped =
    expression?.type === "parenthesized_expression"
      ? (expression.namedChildren[0] ?? null)
      : expression;
  const source = literalString(unwrapped);
  if (source === null) return null;
  return [
    {
      kind: "import",
      source,
      imported: node.type.replace(/_expression$/, ""),
      local: null,
      typeOnly: false,
      static: false,
      global: false,
      owner: factOwner(chunks, node.startIndex, node.endIndex),
      ...factSpan(node, starts),
    },
  ];
}

function variableNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "variable_name") return [node.text];
  if (
    node.type === "simple_parameter" ||
    node.type === "variadic_parameter" ||
    node.type === "property_promotion_parameter"
  ) {
    const name = node.childForFieldName("name");
    return name ? [name.text] : [];
  }
  if (
    node.type === "formal_parameters" ||
    node.type === "anonymous_function_use_clause"
  ) {
    return node.namedChildren.flatMap(variableNames);
  }
  return node.namedChildren.flatMap(variableNames);
}

function declaredChunk(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  kinds: Set<SourceChunk["kind"]>,
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  const normalized = name.replace(/^\$/, "");
  return owner?.name === normalized && kinds.has(owner.kind) ? owner : null;
}

const TYPE_NODES = new Set([
  "class_declaration",
  "interface_declaration",
  "trait_declaration",
  "enum_declaration",
]);

function assignedVariableNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "variable_name") return [node.text];
  if (
    ["list_literal", "array_creation_expression", "pair", "by_ref"].includes(
      node.type,
    )
  ) return node.namedChildren.flatMap(assignedVariableNames);
  return [];
}

function assignmentBinding(
  assignment: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (!assignedVariableNames(assignment.childForFieldName("left")).includes(name)) {
    return null;
  }
  const target = declaredChunk(
    assignment,
    name,
    chunks,
    new Set(["function"]),
  );
  return target
    ? { kind: "source-chunk", target }
    : { kind: "local", target: null };
}

function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (node.type === "expression_statement") {
    const assignment = node.namedChildren.find(
      (child) => child.type === "assignment_expression",
    );
    return assignment ? assignmentBinding(assignment, name, chunks) : null;
  }
  if (node.type === "assignment_expression") {
    return assignmentBinding(node, name, chunks);
  }
  if (
    node.type === "unset_statement" &&
    variableNames(node).includes(name)
  ) return { kind: "unknown", target: null };
  if (
    node.type === "function_definition" ||
    node.type === "method_declaration"
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
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(
      node,
      name,
      chunks,
      new Set(["class", "interface", "trait", "enum"]),
    );
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (node.type === "namespace_use_declaration") {
    const imported = useEntries(node).some((entry) => entry.local === name);
    return imported ? { kind: "import", target: null } : null;
  }
  return null;
}

function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "variable_name") return node.text;
  if (node.type === "name") return node.text;
  if (node.type === "qualified_name") return node.text.split("\\")[0] ?? null;
  if (node.type === "relative_name") return node.text;
  if (node.type === "member_access_expression")
    return expressionRoot(node.childForFieldName("object"));
  if (node.type === "parenthesized_expression")
    return expressionRoot(node.namedChildren[0] ?? null);
  return null;
}

function enclosingBlockNamespace(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === "namespace_definition" &&
      current.childForFieldName("body") !== null
    )
      return current;
    current = current.parent;
  }
  return null;
}

function programScopeChildren(
  program: SyntaxNode,
  call: SyntaxNode,
): SyntaxNode[] {
  if (enclosingBlockNamespace(call)) return [];
  const namespaces = program.namedChildren.filter(
    (child) =>
      child.type === "namespace_definition" &&
      child.childForFieldName("body") === null,
  );
  const active = namespaces
    .filter((namespace) => namespace.startIndex <= call.startIndex)
    .at(-1);
  if (!active) {
    const first = namespaces[0]?.startIndex ?? program.endIndex;
    return program.namedChildren.filter((child) => child.startIndex < first);
  }
  const next = namespaces.find(
    (namespace) => namespace.startIndex > active.startIndex,
  );
  const end = next?.startIndex ?? program.endIndex;
  return program.namedChildren.filter(
    (child) => child.startIndex >= active.startIndex && child.startIndex < end,
  );
}

interface BindingEvent {
  visibleAt: number;
  binding: Binding;
}

const NESTED_FUNCTION_SCOPES = new Set([
  "function_definition",
  "method_declaration",
  "arrow_function",
  "anonymous_function",
  "class_declaration",
  "interface_declaration",
  "trait_declaration",
  "enum_declaration",
]);

function functionScopedBinding(
  body: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  const events: BindingEvent[] = [];
  const stack = [...body.namedChildren].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (NESTED_FUNCTION_SCOPES.has(node.type)) continue;
    if (node.type === "assignment_expression") {
      const binding = assignmentBinding(node, name, chunks);
      if (binding) events.push({ visibleAt: node.endIndex, binding });
    } else if (node.type === "foreach_statement") {
      const loopBody = node.childForFieldName("body");
      const iterable = node.namedChildren[0] ?? null;
      const binders = node.namedChildren.filter(
        (child) => child.id !== iterable?.id && child.id !== loopBody?.id,
      );
      if (binders.flatMap(variableNames).includes(name)) {
        events.push({
          visibleAt: loopBody?.startIndex ?? node.endIndex,
          binding: { kind: "local", target: null },
        });
      }
    } else if (node.type === "catch_clause") {
      const caught = node.childForFieldName("name");
      const catchBody = node.childForFieldName("body");
      if (variableNames(caught).includes(name)) {
        events.push({
          visibleAt: catchBody?.startIndex ?? node.endIndex,
          binding: { kind: "local", target: null },
        });
      }
    } else if (
      node.type === "global_declaration" ||
      node.type === "static_variable_declaration"
    ) {
      if (variableNames(node).includes(name)) {
        events.push({
          visibleAt: node.endIndex,
          binding: { kind: "local", target: null },
        });
      }
    } else if (node.type === "unset_statement") {
      if (variableNames(node).includes(name)) {
        events.push({
          visibleAt: node.endIndex,
          binding: { kind: "unknown", target: null },
        });
      }
    }
    for (let index = node.namedChildren.length - 1; index >= 0; index--) {
      stack.push(node.namedChildren[index]!);
    }
  }
  return events
    .filter((event) => event.visibleAt <= call.startIndex)
    .sort((left, right) => left.visibleAt - right.visibleAt)
    .at(-1)?.binding ?? null;
}

function resolve(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding {
  if (["$this", "self", "static", "parent"].includes(name)) {
    return { kind: "local", target: null };
  }
  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (
      current.type === "function_definition" ||
      current.type === "method_declaration" ||
      current.type === "arrow_function" ||
      current.type === "anonymous_function"
    ) {
      if (
        variableNames(current.childForFieldName("parameters")).includes(name)
      ) {
        return { kind: "local", target: null };
      }
      if (
        current.type === "anonymous_function" &&
        variableNames(
          current.namedChildren.find(
            (child) => child.type === "anonymous_function_use_clause",
          ) ?? null,
        ).includes(name)
      )
        return { kind: "local", target: null };
      if (current.type === "anonymous_function") {
        return { kind: "unknown", target: null };
      }
      if (
        current.type === "function_definition" ||
        current.type === "method_declaration"
      ) {
        const body = current.childForFieldName("body");
        const binding = body
          ? functionScopedBinding(body, call, name, chunks)
          : null;
        if (binding) return binding;
      }
    }
    if (current.type === "compound_statement") {
      for (let index = current.namedChildren.length - 1; index >= 0; index--) {
        const child = current.namedChildren[index]!;
        if (child.endIndex > call.startIndex) continue;
        const binding = declarationBinding(child, name, chunks);
        if (binding) return binding;
      }
    } else if (
      current.type === "declaration_list" ||
      current.type === "program" ||
      current.type === "namespace_definition"
    ) {
      const children =
        current.type === "program"
          ? programScopeChildren(current, call)
          : current.namedChildren;
      const candidates = children
        .map((child) => declarationBinding(child, name, chunks))
        .filter((binding): binding is Binding => binding !== null);
      if (candidates.length === 1) return candidates[0]!;
      if (candidates.length > 1) return { kind: "local", target: null };
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
  if (
    node.childForFieldName("arguments")?.namedChildren.some(
      (child) => child.type === "variadic_placeholder",
    )
  ) return null;
  let callee: string | null = null;
  let root: string | null = null;
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function");
    callee = fn?.text ?? null;
    root = expressionRoot(fn);
  } else if (node.type === "scoped_call_expression") {
    const scope = node.childForFieldName("scope");
    const name = node.childForFieldName("name");
    callee = scope && name ? `${scope.text}::${name.text}` : null;
    root = expressionRoot(scope);
  } else if (
    node.type === "member_call_expression" ||
    node.type === "nullsafe_member_call_expression"
  ) {
    const object = node.childForFieldName("object");
    const name = node.childForFieldName("name");
    const operator =
      node.type === "nullsafe_member_call_expression" ? "?->" : "->";
    callee = object && name ? `${object.text}${operator}${name.text}` : null;
    root = expressionRoot(object);
  } else if (node.type === "object_creation_expression") {
    const type = node.namedChildren.find((child) =>
      ["name", "qualified_name", "relative_name"].includes(child.type),
    );
    callee = type?.text ?? null;
    root = expressionRoot(type ?? null);
  } else if (RUNTIME_IMPORTS.has(node.type)) {
    callee = node.type.replace(/_expression$/, "");
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
  "function_call_expression",
  "scoped_call_expression",
  "member_call_expression",
  "nullsafe_member_call_expression",
  "object_creation_expression",
]);

export function extractPhpFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "namespace_use_declaration") {
      facts.push(...useFacts(node, chunks, starts));
    } else if (RUNTIME_IMPORTS.has(node.type)) {
      const imported = runtimeImportFact(node, chunks, starts);
      if (imported) facts.push(...imported);
      else {
        const fact = callFact(node, chunks, starts);
        if (fact) facts.push(fact);
      }
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
