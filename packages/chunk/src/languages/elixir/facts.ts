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

function callTarget(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName("target");
}
function terminal(module: string): string {
  return module.split(".").at(-1) ?? module;
}
function directive(node: SyntaxNode): string | null {
  const value = callTarget(node)?.text;
  return ["alias", "import", "require", "use"].includes(value ?? "")
    ? value!
    : null;
}
function importEntries(node: SyntaxNode): ImportEntry[] {
  const kind = directive(node);
  if (!kind) return [];
  const args = node.namedChildren.find((child) => child.type === "arguments");
  if (!args) return [];
  const direct = args.namedChildren.find((child) => child.type === "alias");
  const dotted = args.namedChildren.find((child) => child.type === "dot");
  if (kind === "alias" && dotted) {
    const prefix = dotted.childForFieldName("left")?.text;
    const tuple = dotted.childForFieldName("right");
    if (prefix && tuple?.type === "tuple")
      return tuple.namedChildren
        .filter((child) => child.type === "alias")
        .map((child) => ({
          source: `${prefix}.${child.text}`,
          imported: kind,
          local: child.text,
          evidence: child,
        }));
  }
  if (!direct) return [];
  if (kind === "import") {
    const keywords = args.namedChildren.find(
      (child) => child.type === "keywords",
    );
    const filter = keywords?.namedChildren.find(
      (child) =>
        child.type === "pair" &&
        /^(only|except):/.test(child.text.trimStart()),
    );
    const filterKind = filter?.text.trimStart().startsWith("except:")
      ? "except"
      : "only";
    const selectors =
      filter?.namedChildren
        .flatMap((child) => child.namedChildren)
        .flatMap((child) => child.namedChildren)
        .filter((child) => child.type === "pair") ?? [];
    if (selectors.length > 0) {
      return selectors.map((selector) => {
        const name = selector.namedChildren
          .find((child) => child.type === "keyword")
          ?.text.replace(/:\s*$/, "");
        const arity = selector.namedChildren.find(
          (child) => child.type === "integer",
        )?.text;
        return {
          source: direct.text,
          imported:
            `${filterKind === "except" ? "except " : ""}${name}/${arity}`,
          local: filterKind === "only" ? (name ?? null) : null,
          evidence: selector,
        };
      });
    }
  }
  let local: string | null =
    kind === "alias" || kind === "require" ? terminal(direct.text) : null;
  const keywords = args.namedChildren.find(
    (child) => child.type === "keywords",
  );
  const asPair = keywords?.namedChildren.find(
    (child) =>
      child.type === "pair" && child.text.trimStart().startsWith("as:"),
  );
  const alias = asPair?.namedChildren.find((child) => child.type === "alias");
  if (alias) local = alias.text;
  return [{ source: direct.text, imported: kind, local, evidence: direct }];
}
function importFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact[] {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return importEntries(node).map((entry) => ({
    kind: "import",
    source: entry.source,
    imported: entry.imported,
    local: entry.local,
    typeOnly: false,
    static: directive(node) === "import",
    global: false,
    owner,
    ...factSpan(entry.evidence, starts),
  }));
}

const DEFINITIONS = new Set([
  "def",
  "defp",
  "defmacro",
  "defmacrop",
  "defguard",
  "defguardp",
  "defdelegate",
]);
const NON_CALLS = new Set([
  "defmodule",
  "defprotocol",
  "defimpl",
  "defstruct",
  "defexception",
  "alias",
  "import",
  "require",
  "use",
  "if",
  "unless",
  "case",
  "cond",
  "with",
  "for",
  "receive",
  "try",
  "quote",
  "unquote",
  "unquote_splicing",
]);
function definitionName(node: SyntaxNode): string | null {
  if (node.type !== "call" || !DEFINITIONS.has(callTarget(node)?.text ?? ""))
    return null;
  const args = node.namedChildren.find((child) => child.type === "arguments");
  let head = args?.namedChildren[0] ?? null;
  if (
    head?.type === "binary_operator" &&
    head.childForFieldName("operator")?.text === "when"
  )
    head = head.childForFieldName("left");
  if (head?.type === "identifier") return head.text;
  return head?.type === "call" ? (callTarget(head)?.text ?? null) : null;
}
function declaredChunk(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): SourceChunkRef | null {
  const owner = factOwner(chunks, node.startIndex, node.endIndex);
  return owner?.name === name && ["function", "method"].includes(owner.kind)
    ? owner
    : null;
}
function assignedAnonymous(node: SyntaxNode): string | null {
  return node.type === "binary_operator" &&
    node.childForFieldName("operator")?.text === "=" &&
    node.childForFieldName("right")?.type === "anonymous_function" &&
    node.childForFieldName("left")?.type === "identifier"
    ? node.childForFieldName("left")!.text
    : null;
}
function declarationBinding(
  node: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  const defined = definitionName(node);
  if (defined === name) {
    const target = declaredChunk(node, name, chunks);
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  const assigned = assignedAnonymous(node);
  if (assigned === name) {
    const target = declaredChunk(node, name, chunks);
    return target
      ? { kind: "source-chunk", target }
      : { kind: "local", target: null };
  }
  if (
    node.type === "call" &&
    importEntries(node).some((entry) => entry.local === name)
  )
    return { kind: "import", target: null };
  if (
    node.type === "binary_operator" &&
    node.childForFieldName("operator")?.text === "=" &&
    patternNames(node.childForFieldName("left")).includes(name)
  )
    return { kind: "local", target: null };
  return null;
}
function patternNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier" && /^[a-z_]/.test(node.text)) {
    return node.text === "_" ? [] : [node.text];
  }
  if (["alias", "atom", "keyword", "dot"].includes(node.type)) return [];
  if (
    node.type === "unary_operator" &&
    node.childForFieldName("operator")?.text === "^"
  ) return [];
  if (node.type === "pair") {
    return patternNames(node.namedChildren.at(-1) ?? null);
  }
  if (node.type === "call") {
    const args = node.namedChildren.find((child) => child.type === "arguments");
    return patternNames(args ?? null);
  }
  if (node.type === "binary_operator") {
    const operator = node.childForFieldName("operator")?.text;
    if (["when", "=", "<-", "\\\\"].includes(operator ?? "")) {
      return patternNames(node.childForFieldName("left"));
    }
  }
  return node.namedChildren.flatMap(patternNames);
}
function definitionParameters(node: SyntaxNode): string[] {
  const args = node.namedChildren.find((child) => child.type === "arguments");
  let head = args?.namedChildren[0] ?? null;
  if (
    head?.type === "binary_operator" &&
    head.childForFieldName("operator")?.text === "when"
  )
    head = head.childForFieldName("left");
  if (head?.type !== "call") return [];
  return patternNames(
    head.namedChildren.find((child) => child.type === "arguments") ?? null,
  );
}
function expressionRoot(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "alias") return node.text;
  if (node.type === "dot")
    return expressionRoot(node.childForFieldName("left"));
  return null;
}
function scopedBinding(
  scope: SyntaxNode,
  call: SyntaxNode,
  name: string,
  chunks: SourceChunk[],
): Binding | null {
  const found: Binding[] = [];
  for (const child of scope.namedChildren) {
    const hoisted = definitionName(child) !== null;
    if (!hoisted && child.endIndex > call.startIndex) continue;
    const binding = declarationBinding(child, name, chunks);
    if (binding) found.push(binding);
  }
  if (found.length === 1) return found[0]!;
  if (found.length > 1) return { kind: "local", target: null };
  return null;
}

function inside(node: SyntaxNode, type: string): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.type === type) return true;
    current = current.parent;
  }
  return false;
}

function controlBinding(
  call: SyntaxNode,
  control: SyntaxNode,
  name: string,
): Binding | null {
  const kind = callTarget(control)?.text;
  if (kind !== "with" && kind !== "for") return null;
  if (kind === "with" && inside(call, "else_block")) return null;
  const args = control.namedChildren.find((child) => child.type === "arguments");
  if (!args) return null;
  for (const qualifier of args.namedChildren) {
    if (
      qualifier.endIndex > call.startIndex ||
      qualifier.type !== "binary_operator"
    ) continue;
    const operator = qualifier.childForFieldName("operator")?.text;
    if (!["<-", "="].includes(operator ?? "")) continue;
    if (patternNames(qualifier.childForFieldName("left")).includes(name)) {
      return { kind: "local", target: null };
    }
  }
  return null;
}
function resolve(
  call: SyntaxNode,
  root: string,
  chunks: SourceChunk[],
): Binding {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (
      current.type === "call" &&
      DEFINITIONS.has(callTarget(current)?.text ?? "") &&
      definitionParameters(current).includes(root)
    )
      return { kind: "local", target: null };
    if (
      current.type === "stab_clause" &&
      patternNames(current.childForFieldName("left")).includes(root)
    )
      return { kind: "local", target: null };
    if (current.type === "call") {
      const binding = controlBinding(call, current, root);
      if (binding) return binding;
    }
    if (["source", "do_block", "body"].includes(current.type)) {
      const binding = scopedBinding(current, call, root, chunks);
      if (binding) return binding;
    }
    current = current.parent;
  }
  return { kind: "unknown", target: null };
}
function insideAttribute(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === "unary_operator" &&
      current.childForFieldName("operator")?.text === "@"
    )
      return true;
    if (["source", "do_block", "body"].includes(current.type)) return false;
    current = current.parent;
  }
  return false;
}
function definitionHead(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  while (current?.parent && current.parent.type !== "arguments") {
    current = current.parent;
  }
  const args = current?.parent;
  const wrapper = args?.parent;
  if (
    args?.type !== "arguments" ||
    wrapper?.type !== "call" ||
    !DEFINITIONS.has(callTarget(wrapper)?.text ?? "")
  )
    return false;
  const first = args.namedChildren[0] ?? null;
  const head =
    first?.type === "binary_operator" &&
    first.childForFieldName("operator")?.text === "when"
      ? first.childForFieldName("left")
      : first;
  return (
    head !== null &&
    head.startIndex <= node.startIndex &&
    head.endIndex >= node.endIndex
  );
}
function callFact(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact | null {
  const target = callTarget(node);
  if (
    !target ||
    directive(node) ||
    NON_CALLS.has(target.text) ||
    DEFINITIONS.has(target.text) ||
    insideAttribute(node) ||
    definitionHead(node)
  )
    return null;
  const callee = target.text.endsWith(".")
    ? target.text.slice(0, -1)
    : target.text;
  const root = expressionRoot(target);
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
export function extractElixirFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (node.type === "call") {
      if (directive(node)) facts.push(...importFacts(node, chunks, starts));
      else {
        const fact = callFact(node, chunks, starts);
        if (fact) facts.push(fact);
      }
    }
  }
  return facts.sort(
    (a, b) =>
      a.startOffset - b.startOffset ||
      a.endOffset - b.endOffset ||
      a.kind.localeCompare(b.kind),
  );
}
