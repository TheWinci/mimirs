import type { Node as SyntaxNode, Tree } from "web-tree-sitter";
import type {
  ImportFact,
  SourceChunk,
  SourceFact,
} from "../../types";
import { factOwnerWhere, factSpan, walkSyntax } from "../fact-helpers";

function findOwnerSkippingTag(
  chunks: SourceChunk[],
  start: number,
  end: number,
  tag: string,
) {
  return factOwnerWhere(
    chunks,
    start,
    end,
    (chunk) => chunk.kind !== "element" || chunk.name?.toLowerCase() !== tag,
  );
}

function startTag(node: SyntaxNode): SyntaxNode | null {
  return (
    node.namedChildren.find(
      (child) =>
        child.type === "start_tag" || child.type === "self_closing_tag",
    ) ?? null
  );
}

function attributeValue(node: SyntaxNode): string | null {
  const value = node.namedChildren.find(
    (child) => child.type !== "attribute_name",
  );
  if (!value) return "";
  if (value.type === "quoted_attribute_value") {
    return (
      value.namedChildren.find((child) => child.type === "attribute_value")
        ?.text ?? ""
    );
  }
  return value.text;
}

function attributes(
  node: SyntaxNode,
): Map<string, { value: string; node: SyntaxNode }> {
  const values = new Map<string, { value: string; node: SyntaxNode }>();
  for (const attribute of node.namedChildren.filter(
    (child) => child.type === "attribute",
  )) {
    const name = attribute.namedChildren
      .find((child) => child.type === "attribute_name")
      ?.text.toLowerCase();
    const value = attributeValue(attribute);
    if (name && value !== null) values.set(name, { value, node: attribute });
  }
  return values;
}

function staticReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    /^(?:data|javascript|mailto|tel):/i.test(trimmed) ||
    trimmed.startsWith("#") ||
    /\{\{|\}\}|\$\{|<%|%>/.test(trimmed)
  )
    return null;
  return trimmed;
}

function srcsetReferences(value: string): string[] {
  const references: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (cursor < value.length && /[\s,]/.test(value[cursor]!)) cursor++;
    const start = cursor;
    while (cursor < value.length && !/\s/.test(value[cursor]!)) cursor++;
    let raw = value.slice(start, cursor);
    let trailingCommas = 0;
    while (raw.endsWith(",")) {
      raw = raw.slice(0, -1);
      trailingCommas++;
    }
    if (trailingCommas === 0) {
      let parentheses = 0;
      while (cursor < value.length) {
        const character = value[cursor++]!;
        if (character === "(") parentheses++;
        else if (character === ")" && parentheses > 0) parentheses--;
        else if (character === "," && parentheses === 0) break;
      }
    }
    const source = staticReference(raw);
    if (source) references.push(source);
  }
  return references;
}

const ASSET_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  img: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  iframe: ["src"],
  embed: ["src"],
  object: ["data"],
  input: ["src"],
  track: ["src"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
};

function elementFacts(
  node: SyntaxNode,
  chunks: SourceChunk[],
  starts: number[],
): ImportFact[] {
  const tagNode = startTag(node);
  const tag = tagNode?.namedChildren
    .find((child) => child.type === "tag_name")
    ?.text.toLowerCase();
  if (!tagNode || !tag) return [];
  const attrs = attributes(tagNode);
  const entries: Array<{
    source: string;
    imported: string;
    evidence: SyntaxNode;
  }> = [];
  if (tag === "script") {
    const source = attrs.get("src");
    const path = source ? staticReference(source.value) : null;
    if (path)
      entries.push({
        source: path,
        imported: "script",
        evidence: source!.node,
      });
  } else if (tag === "link") {
    const href = attrs.get("href");
    const path = href ? staticReference(href.value) : null;
    const rels = new Set(attrs.get("rel")?.value.toLowerCase().split(/\s+/) ?? []);
    for (const rel of ["stylesheet", "modulepreload", "preload", "icon", "manifest"]) {
      if (path && rels.has(rel)) {
        entries.push({ source: path, imported: rel, evidence: href!.node });
      }
    }
  }
  for (const attributeName of ASSET_ATTRIBUTES[tag] ?? []) {
    if (tag === "input" && attrs.get("type")?.value.toLowerCase() !== "image") {
      continue;
    }
    const attribute = attrs.get(attributeName);
    const source = attribute ? staticReference(attribute.value) : null;
    if (source) {
      entries.push({
        source,
        imported: `asset:${tag}.${attributeName}`,
        evidence: attribute!.node,
      });
    }
  }
  const srcsetAttribute = tag === "link"
    ? attrs.get("imagesrcset")
    : ["img", "source"].includes(tag)
    ? attrs.get("srcset")
    : null;
  if (srcsetAttribute) {
    for (const source of srcsetReferences(srcsetAttribute.value)) {
      entries.push({
        source,
        imported: `asset:${tag}.${tag === "link" ? "imagesrcset" : "srcset"}`,
        evidence: srcsetAttribute.node,
      });
    }
  }
  const owner = findOwnerSkippingTag(
    chunks,
    node.startIndex,
    node.endIndex,
    tag,
  );
  return entries.map((entry) => ({
    kind: "import",
    source: entry.source,
    imported: entry.imported,
    local: null,
    typeOnly: false,
    static: false,
    global: false,
    owner,
    ...factSpan(entry.evidence, starts),
  }));
}

export function extractHtmlFacts(
  tree: Tree,
  chunks: SourceChunk[],
  starts: number[],
): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const node of walkSyntax(tree.rootNode)) {
    if (["element", "script_element", "style_element"].includes(node.type)) {
      facts.push(...elementFacts(node, chunks, starts));
    }
  }
  return facts.sort(
    (a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset,
  );
}
