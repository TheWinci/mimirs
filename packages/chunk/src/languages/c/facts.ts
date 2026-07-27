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
  walkSyntax,
} from "../fact-helpers";

interface ResolvedCallBinding {
  kind: CallBindingKind;
  target: SourceChunkRef | null;
}

function includeFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  lineStarts: number[],
): ImportFact[] {
  const path = node.childForFieldName("path")?.text;
  if (!path) return [];
  return [{
    kind: "import",
    source: path,
    imported: null,
    local: null,
    typeOnly: false,
    static: false,
    global: false,
    owner: factOwner(chunks, node.startIndex, node.endIndex),
    ...factSpan(node, lineStarts),
  }];
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

function directDeclarators(node: SyntaxNode): SyntaxNode[] {
  if (node.type === "function_definition") {
    const declarator = node.childForFieldName("declarator");
    return declarator ? [declarator] : [];
  }
  return node.childrenForFieldName("declarator");
}

function matchingDeclarator(node: SyntaxNode, name: string): SyntaxNode | null {
  return directDeclarators(node).find((declarator) => declaratorName(declarator) === name) ?? null;
}

function parameterBindings(node: SyntaxNode): string[] {
  let declarator = node.childForFieldName("declarator");
  while (declarator && declarator.type !== "function_declarator") {
    declarator = declarator.type === "parenthesized_declarator"
      ? declarator.namedChildren[0] ?? null
      : declarator.childForFieldName("declarator");
  }
  const parameters = declarator?.childForFieldName("parameters");
  if (!parameters) return [];
  return parameters.namedChildren.flatMap((parameter) => {
    if (parameter.type !== "parameter_declaration") return [];
    const name = declaratorName(parameter.childForFieldName("declarator"));
    return name ? [name] : [];
  });
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

const CALLABLE_KINDS = new Set<SourceChunk["kind"]>(["function", "macro"]);

function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  if (node.type === "function_definition") {
    if (declaratorName(node.childForFieldName("declarator")) !== name) return null;
    const target = declaredChunk(node, name, chunks, CALLABLE_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (node.type === "declaration") {
    const declarator = matchingDeclarator(node, name);
    if (!declarator) return null;
    if (!declaratorIsFunction(declarator)) return { kind: "local", target: null };
    const target = declaredChunk(node, name, chunks, CALLABLE_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  if (node.type === "preproc_def" || node.type === "preproc_function_def") {
    if (node.childForFieldName("name")?.text !== name) return null;
    const target = declaredChunk(node, name, chunks, CALLABLE_KINDS);
    return target ? { kind: "source-chunk", target } : { kind: "local", target: null };
  }
  return null;
}

function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "field_expression") {
    return expressionRoot(node.childForFieldName("argument"));
  }
  if (node.type === "pointer_expression") {
    return expressionRoot(node.childForFieldName("argument"));
  }
  if (node.type === "parenthesized_expression") {
    return expressionRoot(node.namedChildren[0] ?? null);
  }
  if (node.type === "subscript_expression") {
    return expressionRoot(node.childForFieldName("argument"));
  }
  return null;
}

function contains(node: SyntaxNode | null, target: SyntaxNode): boolean {
  return node !== null && node.startIndex <= target.startIndex &&
    node.endIndex >= target.endIndex;
}

function assignmentBinding(
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

function visibleBeforeCall(node: SyntaxNode, call: SyntaxNode): boolean {
  if (node.endIndex <= call.startIndex) return true;
  return node.type === "function_definition" &&
    contains(node.childForFieldName("body"), call);
}

function insideDeclaration(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "declaration") return true;
    if (current.type === "function_definition") return false;
    current = current.parent;
  }
  return false;
}

function callOwner(
  call: SyntaxNode,
  chunks: SourceChunk[],
): SourceChunkRef | null {
  const owner = factOwner(chunks, call.startIndex, call.endIndex);
  if (owner?.kind !== "variable" || insideDeclaration(call)) return owner;

  return factOwnerWhere(
    chunks,
    call.startIndex,
    call.endIndex,
    (chunk) =>
      chunk.kind !== owner.kind || chunk.name !== owner.name ||
      chunk.startOffset !== owner.startOffset || chunk.endOffset !== owner.endOffset,
  );
}

function scopeBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): ResolvedCallBinding | null {
  const candidates = scope.namedChildren.filter(
    (child) => visibleBeforeCall(child, call) &&
      [
        "function_definition",
        "declaration",
        "preproc_def",
        "preproc_function_def",
        "preproc_call",
        "expression_statement",
      ].includes(child.type),
  );
  const bindings: Array<{ node: SyntaxNode; binding: ResolvedCallBinding }> = [];
  for (const candidate of candidates) {
    if (
      candidate.type === "preproc_call" &&
      candidate.childForFieldName("directive")?.text === "#undef" &&
      candidate.childForFieldName("argument")?.text.trim() === name
    ) {
      for (let index = bindings.length - 1; index >= 0; index--) {
        if (["preproc_def", "preproc_function_def"].includes(bindings[index]!.node.type)) {
          bindings.splice(index, 1);
        }
      }
      continue;
    }
    const binding = declarationBinding(candidate, name, chunks) ??
      assignmentBinding(candidate, name);
    if (binding) bindings.push({
      node: candidate,
      binding,
    });
  }

  const definition = bindings.find((candidate) => candidate.node.type === "function_definition");
  if (definition) return definition.binding;
  const latest = bindings.at(-1);
  return latest?.binding ?? null;
}

function resolveCallBinding(
  call: SyntaxNode,
  functionNode: SyntaxNode,
  chunks: SourceChunk[],
): ResolvedCallBinding {
  const name = expressionRoot(functionNode);
  if (!name) return { kind: "unknown", target: null };

  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (current.type === "for_statement") {
      const initializer = current.childForFieldName("initializer");
      if (
        initializer && !contains(initializer, call) &&
        contains(current, call)
      ) {
        const binding = declarationBinding(initializer, name, chunks);
        if (binding) return binding;
      }
    }
    if (current.type === "function_definition" && parameterBindings(current).includes(name)) {
      return { kind: "local", target: null };
    }
    if (
      current.type === "compound_statement" || current.type === "translation_unit" ||
      current.type === "preproc_if" || current.type === "preproc_ifdef" ||
      current.type === "preproc_else" || current.type === "preproc_elif"
    ) {
      const binding = scopeBinding(current, call, name, chunks);
      if (binding) return binding;
    }
    if (current.type === "preproc_else" || current.type === "preproc_elif") {
      current = current.parent?.parent ?? current.parent;
      continue;
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}

/** Extract C include directives and call expressions without preprocessing or linkage inference. */
export function extractCFacts(
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "preproc_include") {
      facts.push(...includeFact(node, chunks, lineStarts));
    } else if (node.type === "call_expression") {
      const functionNode = node.childForFieldName("function");
      if (functionNode) {
        const binding = resolveCallBinding(node, functionNode, chunks);
        facts.push({
          kind: "call",
          callee: functionNode.text,
          binding: binding.kind,
          target: binding.target,
          owner: callOwner(node, chunks),
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
