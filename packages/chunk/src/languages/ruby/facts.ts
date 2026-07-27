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

function stringValue(node: SyntaxNode | null): string | null {
  if (!node || node.type !== "string") return null;
  if (node.namedChildren.some((child) => child.type !== "string_content"))
    return null;
  const value = node.text;
  return value.length >= 2 ? value.slice(1, -1) : "";
}

function loaderFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact | null {
  const method = node.childForFieldName("method")?.text;
  if (
    !method ||
    !["require", "require_relative", "load", "autoload"].includes(method)
  ) return null;
  if (node.childForFieldName("receiver")) return null;
  if (resolve(node, method, chunks).kind !== "unknown") return null;
  const argumentsNode = node.childForFieldName("arguments");
  const argument = argumentsNode?.namedChildren[method === "autoload" ? 1 : 0] ??
    null;
  const source = stringValue(argument);
  if (source === null) return null;
  const symbol = method === "autoload"
    ? argumentsNode?.namedChildren[0]?.text.replace(/^:/, "") ?? null
    : null;
  return {
    kind: "import",
    source,
    imported: method,
    local: symbol,
    typeOnly: false,
    static: false,
    global: false,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, starts),
  };
}

function names(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (
    [
      "identifier",
      "constant",
      "instance_variable",
      "class_variable",
      "global_variable",
    ].includes(node.type)
  )
    return [node.text];
  if (
    [
      "optional_parameter",
      "keyword_parameter",
      "splat_parameter",
      "hash_splat_parameter",
      "block_parameter",
      "destructured_parameter",
    ].includes(node.type)
  ) {
    const name = node.childForFieldName("name");
    return name ? [name.text] : node.namedChildren.flatMap(names);
  }
  return node.namedChildren.flatMap(names);
}

function patternNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (
    [
      "constant",
      "scope_resolution",
      "pin",
      "alternative_pattern",
      "string",
      "integer",
      "float",
      "nil",
      "true",
      "false",
    ].includes(node.type)
  ) return [];
  if (["splat_parameter", "hash_splat_parameter"].includes(node.type)) {
    return patternNames(node.childForFieldName("name"));
  }
  return node.namedChildren.flatMap(patternNames);
}

function lexicalBinderNames(node: SyntaxNode): string[] {
  if (node.type === "for") {
    return patternNames(node.childForFieldName("pattern"));
  }
  if (node.type === "rescue") {
    return names(node.childForFieldName("variable"));
  }
  if (node.type === "in_clause") {
    return patternNames(node.childForFieldName("pattern"));
  }
  return [];
}

function declaredChunk(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
  kinds: Set<SourceChunk["kind"]>,
): SourceChunkRef | null {
  const found = factOwner(chunks, node.startIndex, node.endIndex);
  return found?.name === name && kinds.has(found.kind) ? found : null;
}

function declaration(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  if (
    node.type === "assignment" &&
    names(node.childForFieldName("left")).includes(name)
  ) {
    const target = declaredChunk(
      node,
      name,
      chunks,
      new Set(["function", "constant"]),
    );
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (node.type === "method" || node.type === "singleton_method") {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks, new Set(["method"]));
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (node.type === "class" || node.type === "module") {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(
      node,
      name,
      chunks,
      new Set(["class", "module"]),
    );
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  return null;
}

function localAssignmentBinding(
  scope: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  const stack = [...scope.namedChildren];
  const matches: Binding[] = [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      [
        "method",
        "singleton_method",
        "lambda",
        "block",
        "do_block",
        "class",
        "module",
      ].includes(node.type)
    ) {
      continue;
    }
    if (
      node.type === "assignment" &&
      names(node.childForFieldName("left")).includes(name)
    ) {
      const binding = declaration(node, name, chunks);
      if (binding) matches.push(binding);
    }
    if (lexicalBinderNames(node).includes(name)) {
      matches.push({ kind: "local", target: null });
    }
    stack.push(...node.namedChildren);
  }
  if (matches.length === 1) return matches[0]!;
  return matches.length > 1 ? { kind: "local", target: null } : null;
}

function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (
    [
      "identifier",
      "constant",
      "instance_variable",
      "class_variable",
      "global_variable",
      "self",
      "super",
    ].includes(node.type)
  )
    return node.text;
  if (node.type === "scope_resolution")
    return expressionRoot(node.namedChildren[0] ?? null);
  if (node.type === "call")
    return expressionRoot(node.childForFieldName("receiver"));
  if (node.type === "parenthesized_statements")
    return expressionRoot(node.namedChildren[0] ?? null);
  return null;
}

function resolve(
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding {
  if (
    name === "self" ||
    name === "super" ||
    name.startsWith("@") ||
    name.startsWith("$")
  )
    return { kind: "local", target: null };
  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (
      ["method", "singleton_method", "lambda", "block", "do_block"].includes(
        current.type,
      )
    ) {
      const parameters = current.childForFieldName("parameters");
      if (names(parameters).includes(name))
        return { kind: "local", target: null };
      if (
        (current.type === "block" || current.type === "do_block") &&
        /^_[1-9]$/.test(name) &&
        parameters === null
      ) return { kind: "local", target: null };
      if (
        current.type === "method" ||
        current.type === "singleton_method" ||
        current.type === "lambda"
      ) {
        const body = current.childForFieldName("body");
        const local = body ? localAssignmentBinding(body, name, chunks) : null;
        if (local) return local;
      }
      if (current.type === "block" || current.type === "do_block") {
        const body = current.childForFieldName("body");
        const local = body ? localAssignmentBinding(body, name, chunks) : null;
        if (local) return local;
      }
    }
    if (["body_statement", "block_body", "program"].includes(current.type)) {
      if (current.type === "program") {
        const local = localAssignmentBinding(current, name, chunks);
        if (local) return local;
      }
      const candidates: Binding[] = [];
      for (const child of current.namedChildren) {
        const hoisted =
          child.type === "method" ||
          child.type === "singleton_method" ||
          child.type === "class" ||
          child.type === "module";
        if (!hoisted && child.startIndex > call.startIndex) continue;
        const binding = declaration(child, name, chunks);
        if (binding) candidates.push(binding);
      }
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
  if (node.type === "yield") {
    return {
      kind: "call",
      callee: "yield",
      binding: "local",
      target: null,
      owner: factOwner(chunks, node.startIndex, node.endIndex),
      ...factSpan(node, starts),
    };
  }
  let callee: string | null = null;
  let root: string | null = null;
  if (node.type === "call") {
    const method = node.childForFieldName("method");
    if (!method) return null;
    const receiver = node.childForFieldName("receiver");
    callee = receiver
      ? node.text.slice(0, method.endIndex - node.startIndex)
      : method.text;
    const assignment = node.parent?.type === "assignment" &&
      node.parent.childForFieldName("left")?.id === node.id;
    if (assignment) callee += "=";
    root = expressionRoot(receiver) ?? method.text;
  } else if (node.type === "binary") {
    const left = node.childForFieldName("left");
    const operator = node.children.find((child) =>
      !child.isNamed &&
      ["+", "-", "*", "/", "%", "**", "==", "!=", "<", "<=", ">", ">=", "<=>", "=~", "!~", "&", "|", "^", "<<", ">>"].includes(child.type)
    );
    if (!left || !operator) return null;
    callee = `${left.text}.${operator.type}`;
    root = expressionRoot(left);
  } else if (node.type === "unary") {
    const operand = node.childForFieldName("operand");
    const operator = node.children.find(
      (child) => !child.isNamed && ["+", "-", "~"].includes(child.type),
    );
    if (!operand || !operator) return null;
    callee = `${operand.text}.${operator.type}@`;
    root = expressionRoot(operand);
  } else if (node.type === "element_reference") {
    if (
      node.parent?.type === "assignment" &&
      node.parent.childForFieldName("left")?.id === node.id
    ) return null;
    const object = node.childForFieldName("object");
    if (!object) return null;
    callee = `${object.text}.[]`;
    root = expressionRoot(object);
  } else if (node.type === "assignment") {
    const left = node.childForFieldName("left");
    if (left?.type !== "element_reference") return null;
    const object = left.childForFieldName("object");
    if (!object) return null;
    callee = `${object.text}.[]=`;
    root = expressionRoot(object);
  }
  if (!callee) return null;
  const binding = resolve(node, root ?? callee, chunks);
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
  "call",
  "binary",
  "unary",
  "element_reference",
  "assignment",
]);

export function extractRubyFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (CALL_NODES.has(node.type)) {
      const imported = node.type === "call"
        ? loaderFact(node, chunks, starts)
        : null;
      if (imported) facts.push(imported);
      else {
        const fact = callFact(node, chunks, starts);
        if (fact) facts.push(fact);
      }
    } else if (node.type === "yield") {
      const fact = callFact(node, chunks, starts);
      if (fact) facts.push(fact);
    }
  }
  return facts.sort(
    (a, b) =>
      a.startOffset - b.startOffset ||
      a.endOffset - b.endOffset ||
      a.kind.localeCompare(b.kind),
  );
}
