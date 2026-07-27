import type { Language } from "../types";
import {
  ENTITY_QUERY as BASH_ENTITIES,
  REFERENCE_QUERY as BASH_REFS,
} from "../languages/bash/queries";
import {
  ENTITY_QUERY as C_ENTITIES,
  REFERENCE_QUERY as C_REFS,
} from "../languages/c/queries";
import {
  ENTITY_QUERY as CPP_ENTITIES,
  REFERENCE_QUERY as CPP_REFS,
} from "../languages/cpp/queries";
import {
  ENTITY_QUERY as CSHARP_ENTITIES,
  REFERENCE_QUERY as CSHARP_REFS,
} from "../languages/csharp/queries";
import {
  ENTITY_QUERY as CSS_ENTITIES,
  REFERENCE_QUERY as CSS_REFS,
} from "../languages/css/queries";
import {
  ENTITY_QUERY as DART_ENTITIES,
  REFERENCE_QUERY as DART_REFS,
} from "../languages/dart/queries";
import {
  ENTITY_QUERY as ELIXIR_ENTITIES,
  REFERENCE_QUERY as ELIXIR_REFS,
} from "../languages/elixir/queries";
import {
  ENTITY_QUERY as GO_ENTITIES,
  REFERENCE_QUERY as GO_REFS,
} from "../languages/go/queries";
import {
  ENTITY_QUERY as HASKELL_ENTITIES,
  REFERENCE_QUERY as HASKELL_REFS,
} from "../languages/haskell/queries";
import {
  ENTITY_QUERY as HTML_ENTITIES,
  REFERENCE_QUERY as HTML_REFS,
} from "../languages/html/queries";
import {
  ENTITY_QUERY as JAVA_ENTITIES,
  REFERENCE_QUERY as JAVA_REFS,
} from "../languages/java/queries";
import {
  ENTITY_QUERY as JAVASCRIPT_ENTITIES,
  REFERENCE_QUERY as JAVASCRIPT_REFS,
} from "../languages/javascript/queries";
import {
  ENTITY_QUERY as KOTLIN_ENTITIES,
  REFERENCE_QUERY as KOTLIN_REFS,
} from "../languages/kotlin/queries";
import {
  ENTITY_QUERY as LUA_ENTITIES,
  REFERENCE_QUERY as LUA_REFS,
} from "../languages/lua/queries";
import {
  ENTITY_QUERY as OCAML_ENTITIES,
  REFERENCE_QUERY as OCAML_REFS,
} from "../languages/ocaml/queries";
import {
  ENTITY_QUERY as PHP_ENTITIES,
  REFERENCE_QUERY as PHP_REFS,
} from "../languages/php/queries";
import {
  ENTITY_QUERY as PYTHON_ENTITIES,
  REFERENCE_QUERY as PYTHON_REFS,
} from "../languages/python/queries";
import {
  ENTITY_QUERY as RUBY_ENTITIES,
  REFERENCE_QUERY as RUBY_REFS,
} from "../languages/ruby/queries";
import {
  ENTITY_QUERY as RUST_ENTITIES,
  REFERENCE_QUERY as RUST_REFS,
} from "../languages/rust/queries";
import {
  ENTITY_QUERY as SCALA_ENTITIES,
  REFERENCE_QUERY as SCALA_REFS,
} from "../languages/scala/queries";
import {
  ENTITY_QUERY as TOML_ENTITIES,
  REFERENCE_QUERY as TOML_REFS,
} from "../languages/toml/queries";
import {
  ENTITY_QUERY as TYPESCRIPT_ENTITIES,
  REFERENCE_QUERY as TYPESCRIPT_REFS,
} from "../languages/typescript/queries";
import {
  ENTITY_QUERY as YAML_ENTITIES,
  REFERENCE_QUERY as YAML_REFS,
} from "../languages/yaml/queries";
import {
  ENTITY_QUERY as ZIG_ENTITIES,
  REFERENCE_QUERY as ZIG_REFS,
} from "../languages/zig/queries";

/**
 * Tree-sitter query patterns per language.
 * Each language owns its patterns in languages/<language>/queries.ts.
 * Adapted from Zed editor's outline.scm patterns.
 */
export const QUERIES: Record<Language, string> = {
  bash: BASH_ENTITIES,
  c: C_ENTITIES,
  cpp: CPP_ENTITIES,
  csharp: CSHARP_ENTITIES,
  css: CSS_ENTITIES,
  dart: DART_ENTITIES,
  elixir: ELIXIR_ENTITIES,
  go: GO_ENTITIES,
  haskell: HASKELL_ENTITIES,
  html: HTML_ENTITIES,
  java: JAVA_ENTITIES,
  javascript: JAVASCRIPT_ENTITIES,
  kotlin: KOTLIN_ENTITIES,
  lua: LUA_ENTITIES,
  ocaml: OCAML_ENTITIES,
  php: PHP_ENTITIES,
  python: PYTHON_ENTITIES,
  ruby: RUBY_ENTITIES,
  rust: RUST_ENTITIES,
  scala: SCALA_ENTITIES,
  toml: TOML_ENTITIES,
  typescript: TYPESCRIPT_ENTITIES,
  yaml: YAML_ENTITIES,
  zig: ZIG_ENTITIES,
};

/**
 * Per-language identifier capture queries (Approach A — Phase A).
 * Languages with no call/identifier semantics (HTML, CSS, TOML, YAML) get
 * empty strings — no references emitted.
 */
export const REFERENCE_QUERIES: Record<Language, string> = {
  bash: BASH_REFS,
  c: C_REFS,
  cpp: CPP_REFS,
  csharp: CSHARP_REFS,
  css: CSS_REFS,
  dart: DART_REFS,
  elixir: ELIXIR_REFS,
  go: GO_REFS,
  haskell: HASKELL_REFS,
  html: HTML_REFS,
  java: JAVA_REFS,
  javascript: JAVASCRIPT_REFS,
  kotlin: KOTLIN_REFS,
  lua: LUA_REFS,
  ocaml: OCAML_REFS,
  php: PHP_REFS,
  python: PYTHON_REFS,
  ruby: RUBY_REFS,
  rust: RUST_REFS,
  scala: SCALA_REFS,
  toml: TOML_REFS,
  typescript: TYPESCRIPT_REFS,
  yaml: YAML_REFS,
  zig: ZIG_REFS,
};
