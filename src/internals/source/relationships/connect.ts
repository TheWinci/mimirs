import { posix } from "node:path";

import type {
  CallFact,
  ExportFact,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceFact,
} from "@winci/bun-chunk";
import { SOURCE_FACT_LANGUAGE_EXTENSIONS } from "@winci/bun-chunk";

import {
  chunkRef,
  context,
  localResourcePath,
  normalized,
  resolveProjectResource,
  RESOURCE_LANGUAGES,
  uniqueFiles,
} from "./shared.ts";
import {
  isCallable,
  namedChunkTargets,
  resolveLocalHeader,
  uniqueTarget,
} from "./targets.ts";
import type { ResolvedTarget } from "./targets.ts";
import {
  resolveEcmaScriptImport,
  importedEcmaScriptTarget,
} from "./languages/ecmascript.ts";
import {
  DartLibraryIndex,
  buildDartLibraryIndex,
  resolveDartUri,
  resolveDartImport,
  dartCallTarget,
} from "./languages/dart.ts";
import {
  OcamlModuleIndex,
  buildOcamlModuleIndex,
  resolveOcamlImport,
  ocamlCallTarget,
} from "./languages/ocaml.ts";
import {
  HaskellModuleIndex,
  buildHaskellModuleIndex,
  resolveHaskellImport,
  haskellCallTarget,
} from "./languages/haskell.ts";
import {
  ElixirModuleIndex,
  buildElixirModuleIndex,
  resolveElixirImport,
  elixirCallTarget,
} from "./languages/elixir.ts";
import {
  PhpSymbolIndex,
  PHP_RUNTIME_IMPORTS,
  resolvePhpRuntimeImport,
  buildPhpSymbolIndex,
  resolvePhpUse,
  phpCallTarget,
} from "./languages/php.ts";
import {
  resolveBashSource,
  bashSourcedTarget,
} from "./languages/bash.ts";
import {
  resolveZigImport,
  zigImportedTarget,
} from "./languages/zig.ts";
import {
  luaModulePaths,
  resolveLuaRequire,
} from "./languages/lua.ts";
import {
  resolveRubyRequire,
  buildRubyConstantIndex,
  rubyCallTarget,
} from "./languages/ruby.ts";
import {
  cppIncludedTarget,
} from "./languages/cpp.ts";
import {
  cIncludedTarget,
} from "./languages/c.ts";
import {
  PythonModuleIndex,
  buildPythonModuleIndex,
  resolvePythonImport,
  pythonImportedTarget,
} from "./languages/python.ts";
import {
  CSharpTypeIndex,
  buildCSharpTypeIndex,
  resolveCSharpImport,
  csharpCallTarget,
} from "./languages/csharp.ts";
import {
  JavaTypeIndex,
  buildJavaTypeIndex,
  resolveJavaImport,
  javaCallTarget,
} from "./languages/java.ts";
import {
  GoPackageIndex,
  buildGoPackageIndex,
  resolveGoPackage,
  goImportedTarget,
  goSamePackageTarget,
} from "./languages/go.ts";
import {
  KotlinSymbolIndex,
  buildKotlinSymbolIndex,
  kotlinSymbols,
  resolveKotlinImport,
  kotlinCallTarget,
} from "./languages/kotlin.ts";
import {
  ScalaSymbolIndex,
  buildScalaSymbolIndex,
  scalaSymbols,
  resolveScalaImport,
  scalaCallTarget,
} from "./languages/scala.ts";
import {
  RustModuleIndex,
  buildRustModuleIndex,
  rustContainingModule,
  selectRustModule,
  resolveRustImport,
  rustCallTarget,
} from "./languages/rust.ts";
import type {
  AnalyzedSourceFile,
  CallRelationship,
  FileContext,
  ImportRelationship,
  ReExportRelationship,
  SourceRelationshipOptions,
  SourceRelationshipResult,
  UnresolvedCall,
  UnresolvedImport,
  UnresolvedReExport,
} from "./types.ts";

function resolveImport(
  file: FileContext,
  fact: ImportFact,
  files: Map<string, FileContext>,
  pythonModules: PythonModuleIndex,
  rustModules: RustModuleIndex,
): FileContext | null {
  if (file.result.language === "python") {
    return resolvePythonImport(file, fact, pythonModules);
  }
  if (file.result.language === "rust") {
    return resolveRustImport(file, fact, rustModules)?.module.file ?? null;
  }
  return resolveEcmaScriptImport(file.path, fact.source, files);
}

function importedTarget(
  file: FileContext,
  callee: string,
  files: Map<string, FileContext>,
  pythonModules: PythonModuleIndex,
  goPackages: GoPackageIndex,
  options: SourceRelationshipOptions,
): ResolvedTarget | null {
  if (file.result.language === "python") {
    return pythonImportedTarget(file, callee, pythonModules);
  }
  if (file.result.language === "go") {
    return goImportedTarget(file, callee, goPackages, options);
  }
  return importedEcmaScriptTarget(file, callee, files);
}

function unresolvedImportIsLocal(
  file: FileContext,
  fact: ImportFact,
  files: Map<string, FileContext>,
  pythonModules: PythonModuleIndex,
  rustModules: RustModuleIndex,
  javaTypes: JavaTypeIndex,
  csharpTypes: CSharpTypeIndex,
  phpSymbols: PhpSymbolIndex,
  scalaSymbols: ScalaSymbolIndex,
  kotlinSymbols: KotlinSymbolIndex,
  elixirModules: ElixirModuleIndex,
  haskellModules: HaskellModuleIndex,
  ocamlModules: OcamlModuleIndex,
  dartLibraries: DartLibraryIndex,
  options: SourceRelationshipOptions,
): boolean {
  if (file.result.language === "python") {
    if (fact.source.startsWith(".")) return true;
    const root = fact.source.split(".")[0];
    return root !== undefined && [...pythonModules.keys()].some(
      (name) => name === root || name.startsWith(`${root}.`),
    );
  }
  if (file.result.language === "go") {
    return fact.source.startsWith(".") ||
      options.goModulePath !== undefined && options.goModulePath !== null &&
        (fact.source === options.goModulePath ||
          fact.source.startsWith(`${options.goModulePath}/`));
  }
  if (file.result.language === "rust") {
    if (
      fact.imported === "module" || fact.source === "crate" ||
      /^(?:crate|self|super)::/.test(fact.source)
    ) return true;
    const current = rustContainingModule(file, fact.startOffset, rustModules);
    const root = fact.source.split("::")[0];
    return current !== null && root !== undefined &&
      selectRustModule(rustModules, current.root, [root]) !== null;
  }
  if (file.result.language === "java") {
    if (fact.imported === "module") return false;
    const root = fact.source.split(".")[0];
    return root !== undefined && [...javaTypes.packages.keys()].some(
      (packageName) => packageName === root || packageName.startsWith(`${root}.`),
    );
  }
  if (file.result.language === "csharp") {
    const root = fact.source.replace(/^global::/, "").split(/[.:]/)[0];
    return root !== undefined && [...csharpTypes.namespaces.keys()].some(
      (namespaceName) => namespaceName === root || namespaceName.startsWith(`${root}.`),
    );
  }
  if (file.result.language === "ruby") {
    if (fact.imported === "require_relative") return true;
    const root = fact.source.replace(/\.rb$/, "").split("/")[0];
    return root !== undefined && [...files.values()].some((candidate) =>
      candidate.result.language === "ruby" &&
      (candidate.path.startsWith(`${root}/`) || candidate.path.startsWith(`lib/${root}/`))
    );
  }
  if (file.result.language === "lua") {
    if (luaModulePaths(fact.source).some((path) => files.has(path))) return true;
    const root = fact.source.split(/[./]/)[0];
    return root !== undefined && [...files.values()].some(
      (candidate) => candidate.result.language === "lua" &&
        candidate.path.startsWith(`${root}/`),
    );
  }
  if (file.result.language === "zig") {
    return fact.imported !== "c-header" && fact.source.endsWith(".zig");
  }
  if (file.result.language === "elixir") {
    const root = fact.source.split(".")[0];
    return root !== undefined && [...elixirModules.keys()].some(
      (moduleName) => moduleName === root || moduleName.startsWith(`${root}.`),
    );
  }
  if (file.result.language === "bash") {
    return !fact.source.startsWith("/") && fact.source.includes("/") &&
      !normalized(fact.source).startsWith("../");
  }
  if (file.result.language === "haskell") {
    const root = fact.source.split(".")[0];
    return root !== undefined && [...haskellModules.keys()].some(
      (moduleName) => moduleName === root || moduleName.startsWith(`${root}.`),
    );
  }
  if (file.result.language === "ocaml") {
    const root = fact.source.split(".")[0];
    return root !== undefined && [...ocamlModules.keys()].some(
      (moduleName) => moduleName === root || moduleName.startsWith(`${root}.`),
    );
  }
  if (file.result.language === "dart") {
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(fact.source) && /[/.]/.test(fact.source)) {
      return true;
    }
    const root = fact.source.split(".")[0];
    return root !== undefined && [...dartLibraries.keys()].some(
      (libraryName) => libraryName === root || libraryName.startsWith(`${root}.`),
    );
  }
  if (RESOURCE_LANGUAGES.has(file.result.language ?? "")) {
    return localResourcePath(file, fact.source) !== null;
  }
  if (file.result.language === "php") {
    if (PHP_RUNTIME_IMPORTS.has(fact.imported ?? "")) {
      if (fact.source.startsWith(".")) return true;
      const root = fact.source.split("/")[0];
      return root !== undefined && [...files.values()].some(
        (candidate) => candidate.result.language === "php" &&
          (candidate.path === fact.source || candidate.path.startsWith(`${root}/`)),
      );
    }
    const root = fact.source.replace(/^\\/, "").split("\\")[0];
    return root !== undefined && [...phpSymbols.namespaces.keys()].some(
      (namespaceName) => namespaceName === root || namespaceName.startsWith(`${root}\\`),
    );
  }
  if (file.result.language === "scala") {
    const root = fact.source.split(".")[0];
    return root !== undefined && [...scalaSymbols.packages.keys()].some(
      (packageName) => packageName === root || packageName.startsWith(`${root}.`),
    );
  }
  if (file.result.language === "kotlin") {
    const root = fact.source.split(".")[0];
    return root !== undefined && [...kotlinSymbols.packages.keys()].some(
      (packageName) => packageName === root || packageName.startsWith(`${root}.`),
    );
  }
  if (file.result.language === "c" || file.result.language === "cpp") {
    return fact.imported === null && /^"[^"]+"$/.test(fact.source);
  }
  return fact.source.startsWith(".");
}

/** Connect already-analyzed source files without reparsing them. */
export function connectSourceFiles(
  input: AnalyzedSourceFile[],
  options: SourceRelationshipOptions = {},
): SourceRelationshipResult {
  const contexts = input.map(context);
  const files = new Map(contexts.map((file) => [file.path, file]));
  const pythonModules = buildPythonModuleIndex(contexts);
  const goPackages = buildGoPackageIndex(contexts);
  const rustModules = buildRustModuleIndex(contexts);
  const javaTypes = buildJavaTypeIndex(contexts);
  const csharpTypes = buildCSharpTypeIndex(contexts);
  const rubyConstants = buildRubyConstantIndex(contexts);
  const phpSymbols = buildPhpSymbolIndex(contexts);
  const scalaIndex = buildScalaSymbolIndex(contexts);
  const kotlinIndex = buildKotlinSymbolIndex(contexts);
  const elixirModules = buildElixirModuleIndex(contexts);
  const haskellModules = buildHaskellModuleIndex(contexts);
  const ocamlModules = buildOcamlModuleIndex(contexts);
  const dartLibraries = buildDartLibraryIndex(contexts);
  const importMap = new Map<string, ImportRelationship>();
  const reExportMap = new Map<string, ReExportRelationship>();
  const unresolvedImports: UnresolvedImport[] = [];
  const unresolvedReExports: UnresolvedReExport[] = [];

  for (const file of contexts) {
    for (const fact of file.imports) {
      const goTarget = file.result.language === "go"
        ? resolveGoPackage(file, fact, goPackages, options)
        : null;
      const javaTarget = file.result.language === "java"
        ? resolveJavaImport(fact, javaTypes)
        : null;
      const csharpTarget = file.result.language === "csharp"
        ? resolveCSharpImport(fact, csharpTypes)
        : null;
      const rubyTarget = file.result.language === "ruby"
        ? resolveRubyRequire(file, fact, files)
        : null;
      const phpTarget = file.result.language === "php"
        ? resolvePhpRuntimeImport(file, fact, files) ?? resolvePhpUse(fact, phpSymbols)
        : null;
      const scalaTarget = file.result.language === "scala"
        ? resolveScalaImport(fact, scalaIndex)
        : null;
      const kotlinTarget = file.result.language === "kotlin"
        ? resolveKotlinImport(fact, kotlinIndex)
        : null;
      const luaTarget = file.result.language === "lua"
        ? resolveLuaRequire(fact, files)
        : null;
      const zigTarget = file.result.language === "zig"
        ? resolveZigImport(file, fact, files)
        : null;
      const elixirTarget = file.result.language === "elixir"
        ? resolveElixirImport(fact, elixirModules)
        : null;
      const bashTarget = file.result.language === "bash"
        ? resolveBashSource(fact, files)
        : null;
      const haskellTarget = file.result.language === "haskell"
        ? resolveHaskellImport(fact, haskellModules)
        : null;
      const ocamlTarget = file.result.language === "ocaml"
        ? resolveOcamlImport(file, fact, ocamlModules)
        : null;
      const dartTarget = file.result.language === "dart"
        ? resolveDartImport(file, fact, files, dartLibraries)
        : null;
      const resourceTarget = RESOURCE_LANGUAGES.has(file.result.language ?? "")
        ? resolveProjectResource(file, fact.source, files, options)
        : null;
      const cTarget = file.result.language === "c" || file.result.language === "cpp"
        ? resolveLocalHeader(file, fact.source, files)
        : null;
      const fileTarget = [
        "go",
        "java",
        "csharp",
        "ruby",
        "php",
        "scala",
        "kotlin",
        "lua",
        "zig",
        "elixir",
        "bash",
        "haskell",
        "ocaml",
        "dart",
        "html",
        "css",
        "markdown",
        "c",
        "cpp",
      ].includes(
        file.result.language ?? "",
      )
        ? null
        : resolveImport(file, fact, files, pythonModules, rustModules);
      if (
        !goTarget && !javaTarget && !csharpTarget && !rubyTarget && !phpTarget &&
        !scalaTarget &&
        !kotlinTarget &&
        !luaTarget &&
        !zigTarget &&
        !elixirTarget &&
        !bashTarget &&
        !haskellTarget &&
        !ocamlTarget &&
        !dartTarget &&
        !resourceTarget &&
        !cTarget && !fileTarget
      ) {
        if (unresolvedImportIsLocal(
          file,
          fact,
          files,
          pythonModules,
          rustModules,
          javaTypes,
          csharpTypes,
          phpSymbols,
          scalaIndex,
          kotlinIndex,
          elixirModules,
          haskellModules,
          ocamlModules,
          dartLibraries,
          options,
        )) {
          unresolvedImports.push({ path: file.path, fact });
        }
        continue;
      }
      const targetKind = goTarget
        ? "package"
        : javaTarget?.targetKind ?? csharpTarget?.targetKind ?? scalaTarget?.targetKind ??
          kotlinTarget?.targetKind ?? "file";
      const targetPath = goTarget?.directory ?? javaTarget?.toPath ?? csharpTarget?.toPath ??
        rubyTarget?.path ?? phpTarget?.path ?? scalaTarget?.toPath ?? kotlinTarget?.toPath ??
        luaTarget?.path ??
        zigTarget?.path ??
        elixirTarget?.path ??
        bashTarget?.path ??
        haskellTarget?.path ??
        ocamlTarget?.path ??
        dartTarget?.path ??
        resourceTarget ??
        cTarget?.path ??
        fileTarget!.path;
      const key = `${file.path}\0${targetKind}\0${targetPath}\0${fact.source}`;
      const relationship = importMap.get(key);
      if (relationship) relationship.facts.push(fact);
      else {
        importMap.set(key, {
          kind: "import",
          fromPath: file.path,
          targetKind,
          toPath: targetPath,
          source: fact.source,
          facts: [fact],
        });
      }
    }

    for (const fact of file.exports) {
      if (fact.source === null) continue;
      const dartExport = file.result.language === "dart";
      if (!dartExport && !fact.source.startsWith(".")) continue;
      if (dartExport && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(fact.source)) continue;
      const target = dartExport
        ? resolveDartUri(file, fact.source, files)
        : resolveEcmaScriptImport(file.path, fact.source, files);
      if (!target) {
        unresolvedReExports.push({ path: file.path, fact });
        continue;
      }
      const key = `${file.path}\0${target.path}\0${fact.source}`;
      const relationship = reExportMap.get(key);
      if (relationship) relationship.facts.push(fact);
      else {
        reExportMap.set(key, {
          kind: "re-export",
          fromPath: file.path,
          toPath: target.path,
          source: fact.source,
          facts: [fact],
        });
      }
    }
  }

  const calls: CallRelationship[] = [];
  const unresolvedCalls: UnresolvedCall[] = [];
  for (const file of contexts) {
    for (const fact of file.calls) {
      let targetPath = file.path;
      let target = fact.binding === "source-chunk" ? fact.target : null;
      if (!target && file.result.language === "rust") {
        const rustTarget = rustCallTarget(file, fact, rustModules);
        if (rustTarget) {
          targetPath = rustTarget.path;
          target = rustTarget.chunk;
        }
      }
      if (!target && file.result.language === "java") {
        const javaTarget = javaCallTarget(file, fact, javaTypes);
        if (javaTarget) {
          targetPath = javaTarget.path;
          target = javaTarget.chunk;
        }
      }
      if (!target && file.result.language === "csharp") {
        const csharpTarget = csharpCallTarget(file, fact, csharpTypes);
        if (csharpTarget) {
          targetPath = csharpTarget.path;
          target = csharpTarget.chunk;
        }
      }
      if (!target && file.result.language === "ruby") {
        const rubyTarget = rubyCallTarget(file, fact, files, rubyConstants);
        if (rubyTarget) {
          targetPath = rubyTarget.path;
          target = rubyTarget.chunk;
        }
      }
      if (!target && file.result.language === "php") {
        const phpTarget = phpCallTarget(file, fact, phpSymbols);
        if (phpTarget) {
          targetPath = phpTarget.path;
          target = phpTarget.chunk;
        }
      }
      if (!target && file.result.language === "scala") {
        const scalaTarget = scalaCallTarget(file, fact, scalaIndex);
        if (scalaTarget) {
          targetPath = scalaTarget.path;
          target = scalaTarget.chunk;
        }
      }
      if (!target && file.result.language === "kotlin") {
        const kotlinTarget = kotlinCallTarget(file, fact, kotlinIndex);
        if (kotlinTarget) {
          targetPath = kotlinTarget.path;
          target = kotlinTarget.chunk;
        }
      }
      if (!target && file.result.language === "zig") {
        const zigTarget = zigImportedTarget(file, fact, files);
        if (zigTarget) {
          targetPath = zigTarget.path;
          target = zigTarget.chunk;
        }
      }
      if (!target && file.result.language === "elixir") {
        const elixirTarget = elixirCallTarget(file, fact, elixirModules);
        if (elixirTarget) {
          targetPath = elixirTarget.path;
          target = elixirTarget.chunk;
        }
      }
      if (!target && file.result.language === "bash") {
        const bashTarget = bashSourcedTarget(file, fact, files);
        if (bashTarget) {
          targetPath = bashTarget.path;
          target = bashTarget.chunk;
        }
      }
      if (!target && file.result.language === "haskell") {
        const haskellTarget = haskellCallTarget(file, fact, haskellModules);
        if (haskellTarget) {
          targetPath = haskellTarget.path;
          target = haskellTarget.chunk;
        }
      }
      if (!target && file.result.language === "ocaml") {
        const ocamlTarget = ocamlCallTarget(file, fact, ocamlModules);
        if (ocamlTarget) {
          targetPath = ocamlTarget.path;
          target = ocamlTarget.chunk;
        }
      }
      if (!target && file.result.language === "dart") {
        const dartTarget = dartCallTarget(file, fact, files, dartLibraries);
        if (dartTarget) {
          targetPath = dartTarget.path;
          target = dartTarget.chunk;
        }
      }
      if (!target && file.result.language === "c") {
        const cTarget = cIncludedTarget(file, fact, files);
        if (cTarget) {
          targetPath = cTarget.path;
          target = cTarget.chunk;
        }
      }
      if (!target && file.result.language === "cpp") {
        const cppTarget = cppIncludedTarget(file, fact, files);
        if (cppTarget) {
          targetPath = cppTarget.path;
          target = cppTarget.chunk;
        }
      }
      if (
        (file.result.language !== "rust" && file.result.language !== "java" &&
          file.result.language !== "csharp" &&
          file.result.language !== "ruby" &&
          file.result.language !== "php" &&
          file.result.language !== "scala" &&
          file.result.language !== "kotlin" &&
          file.result.language !== "lua" &&
          file.result.language !== "zig" &&
          file.result.language !== "elixir" &&
          file.result.language !== "bash" &&
          file.result.language !== "haskell" &&
          file.result.language !== "ocaml" &&
          file.result.language !== "dart" &&
          file.result.language !== "c" && file.result.language !== "cpp" &&
          fact.binding === "import") ||
        file.result.language === "go" && fact.binding === "unknown"
      ) {
        const imported = importedTarget(
          file,
          fact.callee,
          files,
          pythonModules,
          goPackages,
          options,
        );
        if (imported) {
          targetPath = imported.path;
          target = imported.chunk;
        }
      }
      if (!target && file.result.language === "go" && fact.binding === "unknown") {
        const samePackage = goSamePackageTarget(file, fact.callee, goPackages);
        if (samePackage) {
          targetPath = samePackage.path;
          target = samePackage.chunk;
        }
      }
      if (target) {
        calls.push({
          kind: "call",
          fromPath: file.path,
          from: fact.owner,
          toPath: targetPath,
          to: target,
          fact,
        });
      } else {
        unresolvedCalls.push({ path: file.path, fact });
      }
    }
  }

  const imports = [...importMap.values()].sort(
    (left, right) => left.fromPath.localeCompare(right.fromPath) ||
      left.toPath.localeCompare(right.toPath) || left.source.localeCompare(right.source),
  );
  const reExports = [...reExportMap.values()].sort(
    (left, right) => left.fromPath.localeCompare(right.fromPath) ||
      left.toPath.localeCompare(right.toPath) || left.source.localeCompare(right.source),
  );
  calls.sort(
    (left, right) => left.fromPath.localeCompare(right.fromPath) ||
      left.fact.startOffset - right.fact.startOffset,
  );
  unresolvedImports.sort(
    (left, right) => left.path.localeCompare(right.path) ||
      left.fact.startOffset - right.fact.startOffset,
  );
  unresolvedReExports.sort(
    (left, right) => left.path.localeCompare(right.path) ||
      left.fact.startOffset - right.fact.startOffset,
  );
  unresolvedCalls.sort(
    (left, right) => left.path.localeCompare(right.path) ||
      left.fact.startOffset - right.fact.startOffset,
  );
  return {
    imports,
    reExports,
    calls,
    unresolvedImports,
    unresolvedReExports,
    unresolvedCalls,
  };
}
