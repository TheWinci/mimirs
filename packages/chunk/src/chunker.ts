import type { Tree } from "web-tree-sitter";
import { chunkParagraphs, emitChunks } from "./entities/emission";
import { extractEntities } from "./entities/extract";
import {
  adjustSpans,
  buildEntityTree,
  classifyContainedEntities,
  collapseEntityGroupsDeep,
  collectComments,
} from "./entities/tree";
import { chunkMarkdown } from "./languages/markdown/chunker";
import { parse } from "./parsing/parser";
import type { Grammar } from "./parsing/parser";
import type { SourceChunkOptions, SourceChunkResult } from "./types";
import { extractMarkdownFacts } from "./languages/markdown/facts";
import { extractTextFacts } from "./languages/text/facts";
import { extractSourceFacts } from "./languages/registry";
import { prepareSource } from "./source-text";
import { extname } from "node:path";

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Chunk one file into an uncapped semantic source tree.
 *
 * Invariants:
 * - INV-C1: every chunk's text is a verbatim slice of the normalized source.
 * - INV-C2: the leaves partition the normalized source exactly.
 * - INV-C3: no size caps of any kind.
 * - INV-C4: every chunk is a named entity or an explicit gap/comment/
 *   paragraph/section chunk.
 * - INV-C5: deterministic.
 */
export async function chunk(
  filepath: string,
  code: string,
  options: SourceChunkOptions = {},
): Promise<SourceChunkResult> {
  const prepared = prepareSource(filepath, code, options.language);
  const { source, language, opaque, lineStarts } = prepared;

  if (prepared.binary) {
    return {
      language: null,
      strategy: "binary",
      binary: true,
      opaque: null,
      chunks: [],
      facts: [],
    };
  }

  const ext = extname(filepath).toLowerCase();

  if (!language) {
    if (ext === ".md" || ext === ".markdown") {
      const chunks = chunkMarkdown(source, lineStarts);
      return {
        language: "markdown",
        strategy: "markdown",
        binary: false,
        opaque,
        chunks,
        facts: extractMarkdownFacts(source, chunks, lineStarts),
      };
    }
    const chunks = chunkParagraphs(source, lineStarts);
    return {
      language: "text",
      strategy: "paragraph",
      binary: false,
      opaque,
      chunks,
      facts: extractTextFacts(source, chunks, lineStarts),
    };
  }

  const grammar: Grammar = language === "typescript" && ext === ".tsx"
    ? "tsx"
    : language === "ocaml" && ext === ".mli"
    ? "ocaml_interface"
    : language;
  let tree: Tree | null = null;
  try {
    tree = await parse(source, grammar);
  } catch {
    tree = null;
  }
  if (!tree) {
    // Grammar unavailable — explicit paragraph fallback, never silent loss.
    return {
      language,
      strategy: "paragraph",
      binary: false,
      opaque,
      chunks: chunkParagraphs(source, lineStarts),
      facts: [],
    };
  }

  try {
    const lines = source.split("\n");
    const { nodes: commentNodes, lineMap } = collectComments(tree, lines, language);
    const flat = await extractEntities(tree, language, grammar);
    let roots = buildEntityTree(flat);
    classifyContainedEntities(roots, language);
    adjustSpans(roots, source, lines, lineStarts, language, lineMap, -1, source.length);
    roots = collapseEntityGroupsDeep(roots, source);

    const chunks = emitChunks(source, lineStarts, commentNodes, roots);
    let facts = extractSourceFacts(language, tree, chunks, lineStarts);
    if (language === "python" && ext === ".pyi") {
      // Stub expressions declare types and signatures; they are not executed.
      facts = facts.filter((fact) => fact.kind === "import");
    }
    if (language === "ocaml" && ext === ".mli") {
      // Interfaces declare types and signatures; they do not execute calls.
      facts = facts.filter((fact) => fact.kind === "import");
    }
    return { language, strategy: "ast", binary: false, opaque, chunks, facts };
  } finally {
    tree.delete();
  }
}
