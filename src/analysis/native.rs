//! Native declarations and retrieval share one parse and one entity query.
use anyhow::{Context, Result};
use tree_sitter::{Language as Grammar, Parser};

use super::{Analysis, Diagnostic, Entity, Fact, LineIndex, Scope, Span, language::Language};
use crate::{retrieval::ts_v2, source::SourceFile};

pub(super) const JAVA: Language = Language {
    identity: "java/default/tree-sitter-0.27.0/java-0.23.5/extractor-2",
    extensions: &["java"],
    extract: |source| extract(source, tree_sitter_java::LANGUAGE.into(), "java"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const C: Language = Language {
    identity: "c/default/tree-sitter-0.27.0/tree-sitter-c-0.24.1/extractor-2",
    extensions: &["c", "h"],
    extract: |source| extract(source, tree_sitter_c::LANGUAGE.into(), "c"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const CPP: Language = Language {
    identity: "cpp/default/tree-sitter-0.27.0/tree-sitter-cpp-0.23.4/extractor-2",
    extensions: &["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
    extract: |source| extract(source, tree_sitter_cpp::LANGUAGE.into(), "cpp"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const CSHARP: Language = Language {
    identity: "csharp/default/tree-sitter-0.27.0/tree-sitter-c-sharp-0.23.1/extractor-2",
    extensions: &["cs"],
    extract: |source| extract(source, tree_sitter_c_sharp::LANGUAGE.into(), "csharp"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const RUBY: Language = Language {
    identity: "ruby/default/tree-sitter-0.27.0/tree-sitter-ruby-0.23.1/extractor-2",
    extensions: &["rb"],
    extract: |source| extract(source, tree_sitter_ruby::LANGUAGE.into(), "ruby"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const PHP: Language = Language {
    identity: "php/default/tree-sitter-0.27.0/tree-sitter-php-0.24.2/extractor-2",
    extensions: &["php"],
    extract: |source| extract(source, tree_sitter_php::LANGUAGE_PHP.into(), "php"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const SCALA: Language = Language {
    identity: "scala/default/tree-sitter-0.27.0/tree-sitter-scala-0.24.0/extractor-2",
    extensions: &["scala", "sc"],
    extract: |source| extract(source, tree_sitter_scala::LANGUAGE.into(), "scala"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const HTML: Language = Language {
    identity: "html/default/tree-sitter-0.27.0/tree-sitter-html-0.23.2/extractor-2",
    extensions: &["html", "htm"],
    extract: |source| extract(source, tree_sitter_html::LANGUAGE.into(), "html"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const CSS: Language = Language {
    identity: "css/default/tree-sitter-0.27.0/tree-sitter-css-0.25.0/extractor-2",
    extensions: &["css"],
    extract: |source| extract(source, tree_sitter_css::LANGUAGE.into(), "css"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const KOTLIN: Language = Language {
    identity: "kotlin/default/tree-sitter-0.27.0/tree-sitter-kotlin-ng-1.1.0/extractor-2",
    extensions: &["kt", "kts"],
    extract: |source| extract(source, tree_sitter_kotlin_ng::LANGUAGE.into(), "kotlin"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const LUA: Language = Language {
    identity: "lua/default/tree-sitter-0.27.0/tree-sitter-lua-0.4.1/extractor-2",
    extensions: &["lua"],
    extract: |source| extract(source, tree_sitter_lua::LANGUAGE.into(), "lua"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const ZIG: Language = Language {
    identity: "zig/default/tree-sitter-0.27.0/tree-sitter-zig-1.1.2/extractor-2",
    extensions: &["zig"],
    extract: |source| extract(source, tree_sitter_zig::LANGUAGE.into(), "zig"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const ELIXIR: Language = Language {
    identity: "elixir/default/tree-sitter-0.27.0/tree-sitter-elixir-0.3.5/extractor-2",
    extensions: &["ex", "exs"],
    extract: |source| extract(source, tree_sitter_elixir::LANGUAGE.into(), "elixir"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const BASH: Language = Language {
    identity: "bash/default/tree-sitter-0.27.0/tree-sitter-bash-0.25.1/extractor-2",
    extensions: &["sh", "bash"],
    extract: |source| extract(source, tree_sitter_bash::LANGUAGE.into(), "bash"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const TOML: Language = Language {
    identity: "toml/default/tree-sitter-0.27.0/tree-sitter-toml-ng-0.7.0/extractor-2",
    extensions: &["toml"],
    extract: |source| extract(source, tree_sitter_toml_ng::LANGUAGE.into(), "toml"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const YAML: Language = Language {
    identity: "yaml/default/tree-sitter-0.27.0/tree-sitter-yaml-0.7.1/extractor-2",
    extensions: &["yaml", "yml"],
    extract: |source| extract(source, tree_sitter_yaml::LANGUAGE.into(), "yaml"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const HASKELL: Language = Language {
    identity: "haskell/default/tree-sitter-0.27.0/tree-sitter-haskell-0.23.1/extractor-2",
    extensions: &["hs"],
    extract: |source| extract(source, tree_sitter_haskell::LANGUAGE.into(), "haskell"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const OCAML: Language = Language {
    identity: "ocaml/default/tree-sitter-0.27.0/tree-sitter-ocaml-0.24.2/extractor-2",
    extensions: &["ml"],
    extract: |source| extract(source, tree_sitter_ocaml::LANGUAGE_OCAML.into(), "ocaml"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const OCAML_INTERFACE: Language = Language {
    identity: "ocaml/interface/tree-sitter-0.27.0/ocaml-0.24.2/extractor-2",
    extensions: &["mli"],
    extract: |source| {
        extract(
            source,
            tree_sitter_ocaml::LANGUAGE_OCAML_INTERFACE.into(),
            "ocaml_interface",
        )
    },
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

pub(super) const DART: Language = Language {
    identity: "dart/default/tree-sitter-0.27.0/dart-orchard-0.6.0/extractor-2",
    extensions: &["dart"],
    extract: |source| extract(source, tree_sitter_dart::LANGUAGE.into(), "dart"),
    is_native: true,
    #[cfg(test)]
    chunking: super::language::Chunking::Paragraphs,
};

fn extract(source: SourceFile, grammar: Grammar, language: &str) -> Result<Analysis> {
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .with_context(|| format!("cannot initialize {language} parser"))?;
    let tree = parser
        .parse(&source.text, None)
        .context("native parser returned no tree")?;
    let root = tree.root_node();
    let declarations = ts_v2::declarations(&source.text, root, &grammar, language)?;
    let lines = LineIndex::new(&source.text);
    let mut analysis = Analysis {
        source_chunks: Vec::new(),
        scopes: vec![Scope {
            kind: "file".into(),
            span: lines.span(0, source.text.len()),
            parent: None,
            owner: None,
        }],
        source,
        entities: Vec::new(),
        facts: Vec::new(),
        diagnostics: Vec::new(),
    };
    let mut ancestors = Vec::<usize>::new();
    for declaration in &declarations {
        if declaration.kind == "comment" || declaration.node_start == declaration.node_end {
            continue;
        }
        while ancestors.last().is_some_and(|&id| {
            let parent = &analysis.entities[id].span;
            parent.end < declaration.node_end || parent.end <= declaration.node_start
        }) {
            ancestors.pop();
        }
        let parent = ancestors.last().copied();
        let id = analysis.entities.len();
        let span = lines.span(declaration.node_start, declaration.node_end);
        analysis.entities.push(Entity {
            kind: ts_v2::classified_kind(
                language,
                &declaration.node_type,
                &declaration.kind,
                parent.map(|id| analysis.entities[id].kind.as_str()),
            )
            .into(),
            name: declaration.name.clone(),
            span: span.clone(),
            parent,
        });
        let scope = analysis.scopes.len();
        analysis.scopes.push(Scope {
            kind: "item".into(),
            span,
            parent: Some(parent.map_or(0, |id| id + 1)),
            owner: Some(id),
        });
        ancestors.push(id);
        if let Some(node) =
            root.descendant_for_byte_range(declaration.node_start, declaration.syntax_end)
        {
            let start = declaration.node_start;
            let end = node
                .child_by_field_name("body")
                .or_else(|| {
                    node.named_children(&mut node.walk())
                        .find(|n| matches!(n.kind(), "block" | "declaration_list" | "do_block"))
                })
                .map_or(declaration.syntax_end, |body| body.start_byte())
                .min(declaration.node_end);
            let end = start + analysis.source.text[start..end].trim_end().len();
            if end > start {
                analysis
                    .facts
                    .push(fact("signature", lines.span(start, end), id, scope));
            }
            let mut first = node;
            // Some grammars put a declaration list between its first item and
            // the leading comment. Preserve adjacency across that wrapper.
            while first.prev_named_sibling().is_none()
                && let Some(wrapper) = first
                    .parent()
                    .filter(|p| p.start_byte() == first.start_byte())
            {
                first = wrapper;
            }
            while let Some(doc) = first
                .prev_named_sibling()
                .filter(|n| n.kind().contains("comment") || n.kind() == "haddock")
            {
                let gap = &analysis.source.text[doc.end_byte()..first.start_byte()];
                let line_start = analysis.source.text[..doc.start_byte()]
                    .rfind('\n')
                    .map_or(0, |i| i + 1);
                if doc.start_byte() < analysis.scopes[parent.map_or(0, |id| id + 1)].span.start
                    || !gap.trim().is_empty()
                    || gap.bytes().filter(|b| *b == b'\n').count() > 1
                    || !analysis.source.text[line_start..doc.start_byte()]
                        .trim()
                        .is_empty()
                {
                    break;
                }
                // Leading documentation belongs to the surrounding scope.
                analysis.facts.push(fact(
                    "doc",
                    Span::of(doc, &analysis.source.text),
                    id,
                    parent.map_or(0, |id| id + 1),
                ));
                first = doc;
            }
        }
    }
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.is_error() || node.is_missing() {
            analysis.diagnostics.push(Diagnostic {
                kind: if node.is_missing() {
                    format!("missing {}", node.kind())
                } else {
                    "ERROR".into()
                },
                span: Span::of(node, &analysis.source.text),
                column: node.start_position().column + 1,
            });
        }
        stack.extend(node.children(&mut node.walk()));
    }
    analysis
        .diagnostics
        .sort_by_key(|d| (d.span.start, d.span.end));
    analysis.facts.sort_by_key(|f| (f.span.start, f.span.end));
    analysis.source_chunks = ts_v2::build_chunks(
        &analysis.source.text,
        root,
        language,
        &analysis.entities,
        declarations,
    );
    Ok(analysis)
}

fn fact(kind: &str, span: Span, owner: usize, scope: usize) -> Fact {
    Fact {
        kind: kind.into(),
        span,
        owner: Some(owner),
        scope,
        evidence: Vec::new(),
        related: None,
    }
}

#[cfg(test)]
#[path = "../../tests/unit/native_languages.rs"]
mod tests;
