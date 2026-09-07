use anyhow::{Context, Result};
use tree_sitter::Parser;

use super::language::Language;
#[cfg(test)]
use super::language::{Chunking, DeclarationRules};
use super::{Analysis, Diagnostic, Entity, Fact, LineIndex, Scope, Span};
use crate::source::SourceFile;

mod entities;
mod facts;
mod imports;
mod references;
mod scopes;
mod signatures;

pub(super) const LANGUAGE: Language = Language {
    identity: "rust/default/tree-sitter-0.27.0/rust-0.24.2/extractor-2/source-facts-1",
    extensions: &["rs"],
    extract,
    is_native: true,
    #[cfg(test)]
    chunking: Chunking::Declarations(DeclarationRules {
        containers: &["module", "impl", "trait"],
        leading_facts: &["doc", "attribute"],
        signature_fact: "signature",
    }),
};

fn extract(source: SourceFile) -> Result<Analysis> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .context("cannot initialize Rust parser")?;
    let tree = parser
        .parse(&source.text, None)
        .context("Rust parser returned no tree")?;
    let lines = LineIndex::new(&source.text);
    let entities = entities::extract(tree.root_node(), &source.text);
    let nodes = facts::nodes(tree.root_node());
    let mut facts = facts::extract(&nodes, &source.text, &entities);
    facts.extend(signatures::extract(&nodes, &source.text, &entities, &lines));
    facts.extend(imports::extract(&nodes, &source.text, &entities));
    let (scopes, bindings) = scopes::extract(&nodes, &source.text, &entities, &lines);
    facts.extend(bindings);
    facts.extend(references::extract(&nodes, &source.text, &entities, &facts));
    for fact in &mut facts {
        fact.scope = scopes::containing(&scopes, &fact.span);
    }
    facts.sort_by_key(|fact| (fact.span.start, fact.span.end));
    for id in 0..facts.len() {
        if facts[id].kind == "import_member" {
            facts[id].related = facts[id]
                .evidence
                .iter()
                .find(|e| e.role == "declaration")
                .and_then(|e| {
                    facts
                        .iter()
                        .position(|f| f.kind == "import" && f.span == e.span)
                });
        }
    }
    let mut diagnostics = Vec::new();
    let mut cursor = tree.walk();
    loop {
        let node = cursor.node();
        diagnostics.extend(Diagnostic::from_node(node, &source.text));
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                let source_chunks = crate::retrieval::ts_v2::from_tree(
                    &source.text,
                    tree.root_node(),
                    &tree_sitter_rust::LANGUAGE.into(),
                    "rust",
                    &entities,
                )?;
                return Ok(Analysis {
                    source_facts: super::source_facts::extract(
                        "rust",
                        &source.text,
                        tree.root_node(),
                        &source_chunks,
                    ),
                    source_chunks,
                    source,
                    diagnostics,
                    entities,
                    facts,
                    scopes,
                });
            }
        }
    }
}
