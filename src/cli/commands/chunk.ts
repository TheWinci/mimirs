import { extname } from "node:path";

import {
  chunkFile,
  SourceFileNotFoundError,
} from "../../internals/source/chunk.ts";
import { projectSourceWindows } from "../../internals/source/windows.ts";
import { renderChunkTree } from "../renderers/chunk-tree.ts";
import { renderSourceFacts } from "../renderers/source-facts.ts";
import { renderSourceWindowTree } from "../renderers/source-windows.ts";

const USAGE =
  "Usage: mimirs chunk -f <file> " +
  "[--tree | --facts | --windows [--window-size <characters>]]";

export const REVIEWED_SOURCE_WINDOW_LANGUAGE_BY_EXTENSION = new Map([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".cs", "csharp"],
  [".rb", "ruby"],
  [".php", "php"],
  [".scala", "scala"],
  [".sc", "scala"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".lua", "lua"],
  [".zig", "zig"],
  [".ex", "elixir"],
  [".exs", "elixir"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".hs", "haskell"],
  [".ml", "ocaml"],
  [".mli", "ocaml"],
  [".dart", "dart"],
  [".html", "html"],
  [".htm", "html"],
  [".css", "css"],
  [".toml", "toml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".txt", "text"],
]);

function supportsSourceWindows(
  filepath: string,
  language: string | null,
): boolean {
  if (language === "text") return true;
  return REVIEWED_SOURCE_WINDOW_LANGUAGE_BY_EXTENSION.get(
    extname(filepath).toLowerCase(),
  ) === language;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runChunk(args: string[]): Promise<number> {
  const filepath = flagValue(args, "-f");
  if (!filepath) {
    console.error(USAGE);
    return 2;
  }

  const views = ["--tree", "--facts", "--windows"].filter((flag) =>
    args.includes(flag)
  );
  if (views.length > 1) {
    console.error("Choose one of --tree, --facts, or --windows.");
    return 2;
  }
  if (args.includes("--window-size") && !args.includes("--windows")) {
    console.error("--window-size requires --windows.");
    return 2;
  }
  const rawWindowSize = flagValue(args, "--window-size");
  const windowSize = rawWindowSize === undefined
    ? undefined
    : Number(rawWindowSize);
  if (
    args.includes("--window-size") &&
    (!Number.isSafeInteger(windowSize) || windowSize! <= 0)
  ) {
    console.error("--window-size must be a positive integer.");
    return 2;
  }

  try {
    const result = await chunkFile(filepath);
    if (result.binary) {
      console.error(`Cannot chunk binary file: ${filepath}`);
      return 1;
    }
    if (
      args.includes("--windows") &&
      !supportsSourceWindows(filepath, result.language)
    ) {
      console.error(
        "Source windows currently support reviewed source-file extensions only.",
      );
      return 2;
    }

    const output = args.includes("--tree")
      ? renderChunkTree(filepath, result.chunks)
      : args.includes("--facts")
      ? renderSourceFacts(filepath, result.facts)
      : args.includes("--windows")
      ? renderSourceWindowTree(
          filepath,
          projectSourceWindows(filepath, result.chunks, {
            targetCharacters: windowSize,
          }),
        )
      : JSON.stringify({ file: filepath, ...result }, null, 2);
    console.log(output);
    return 0;
  } catch (error) {
    if (error instanceof SourceFileNotFoundError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}
