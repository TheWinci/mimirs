//! Source facts compatible with the TS language extractors. These are distinct
//! from Rust's lower-level written-evidence records.
use super::{LineIndex, Span};
use crate::retrieval::ts_v2::Chunk;
use serde::{Deserialize, Serialize};
use tree_sitter::Node;

mod bash;
mod c;
mod cpp;
mod csharp;
mod css;
mod dart;
mod ecmascript;
mod elixir;
mod go;
mod haskell;
mod html;
mod java;
mod kotlin;
mod lua;
mod markdown;
mod ocaml;
mod php;
mod python;
mod ruby;
mod rust;
mod scala;
mod zig;

pub use markdown::extract as extract_markdown;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub start_offset: usize,
    pub end_offset: usize,
    pub start_line: usize,
    pub end_line: usize,
}

impl Location {
    pub fn from_span(span: &Span) -> Self {
        Self {
            start_offset: span.start,
            end_offset: span.end,
            start_line: span.line_start,
            end_line: span.line_end,
        }
    }

    pub fn span(&self) -> Span {
        Span {
            start: self.start_offset,
            end: self.end_offset,
            line_start: self.start_line,
            line_end: self.end_line,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRef {
    pub kind: String,
    pub name: String,
    #[serde(flatten)]
    pub location: Location,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Kind {
    Import {
        source: String,
        imported: Option<String>,
        local: Option<String>,
        #[serde(rename = "typeOnly")]
        type_only: bool,
        #[serde(rename = "static")]
        is_static: bool,
        global: bool,
    },
    Export {
        exported: String,
        local: Option<String>,
        source: Option<String>,
        #[serde(rename = "typeOnly")]
        type_only: bool,
    },
    Call {
        callee: String,
        binding: Binding,
        target: Option<ChunkRef>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Binding {
    SourceChunk,
    Import,
    Local,
    Unknown,
}

#[derive(Clone)]
struct Resolved {
    binding: Binding,
    target: Option<ChunkRef>,
}

impl Resolved {
    const LOCAL: Self = Self {
        binding: Binding::Local,
        target: None,
    };
    const UNKNOWN: Self = Self {
        binding: Binding::Unknown,
        target: None,
    };
    const IMPORT: Self = Self {
        binding: Binding::Import,
        target: None,
    };
    fn target(target: ChunkRef) -> Self {
        Self {
            binding: Binding::SourceChunk,
            target: Some(target),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fact {
    #[serde(flatten)]
    pub kind: Kind,
    pub owner: Option<ChunkRef>,
    #[serde(flatten)]
    pub location: Location,
}

pub(super) struct Context<'a> {
    source: &'a str,
    chunks: &'a [Chunk],
    lines: LineIndex,
}

impl Context<'_> {
    fn text(&self, node: Node<'_>) -> &str {
        &self.source[node.start_byte()..node.end_byte()]
    }

    fn owner(&self, node: Node<'_>) -> Option<ChunkRef> {
        self.owner_where(node, |_| true)
    }

    fn owner_where(&self, node: Node<'_>, accept: impl Fn(&Chunk) -> bool) -> Option<ChunkRef> {
        self.owner_range(node.start_byte(), node.end_byte(), accept)
    }

    fn owner_range(
        &self,
        start: usize,
        end: usize,
        accept: impl Fn(&Chunk) -> bool,
    ) -> Option<ChunkRef> {
        self.chunks
            .iter()
            .rev()
            .find(|chunk| {
                chunk.name.is_some()
                    && accept(chunk)
                    && chunk.span.start <= start
                    && chunk.span.end >= end
            })
            .map(|chunk| ChunkRef {
                kind: chunk.kind.clone(),
                name: chunk.name.clone().unwrap_or_default(),
                location: Location::from_span(&chunk.span),
            })
    }

    fn import(
        &self,
        source: String,
        imported: &str,
        node: Node<'_>,
        owner: Option<ChunkRef>,
    ) -> Fact {
        self.import_range(source, imported, node.start_byte(), node.end_byte(), owner)
    }

    fn import_range(
        &self,
        source: String,
        imported: &str,
        start: usize,
        end: usize,
        owner: Option<ChunkRef>,
    ) -> Fact {
        Fact {
            kind: Kind::Import {
                source,
                imported: Some(imported.into()),
                local: None,
                type_only: false,
                is_static: false,
                global: false,
            },
            owner,
            location: Location::from_span(&self.lines.span(start, end)),
        }
    }

    fn declared(&self, node: Node<'_>, name: &str, kinds: &[&str]) -> Option<ChunkRef> {
        self.owner(node)
            .filter(|owner| owner.name == name && kinds.contains(&owner.kind.as_str()))
    }

    fn call(
        &self,
        callee: String,
        node: Node<'_>,
        resolved: Resolved,
        owner: Option<ChunkRef>,
    ) -> Fact {
        Fact {
            kind: Kind::Call {
                callee,
                binding: resolved.binding,
                target: resolved.target,
            },
            owner,
            location: Location::from_span(&self.lines.span(node.start_byte(), node.end_byte())),
        }
    }
}

fn encloses(node: Node<'_>, target: Node<'_>) -> bool {
    node.start_byte() <= target.start_byte() && node.end_byte() >= target.end_byte()
}

fn children(node: Node<'_>) -> Vec<Node<'_>> {
    node.named_children(&mut node.walk()).collect()
}

fn named<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
    children(node).into_iter().find(|node| node.kind() == kind)
}

fn walk(root: Node<'_>) -> Vec<Node<'_>> {
    let mut stack = vec![root];
    let mut result = Vec::new();
    while let Some(node) = stack.pop() {
        result.push(node);
        stack.extend(children(node).into_iter().rev());
    }
    result
}

fn kind_order(kind: &Kind) -> u8 {
    match kind {
        Kind::Call { .. } => 0,
        Kind::Export { .. } => 1,
        Kind::Import { .. } => 2,
    }
}

pub fn extract(language: &str, source: &str, root: Node<'_>, chunks: &[Chunk]) -> Vec<Fact> {
    let context = Context {
        source,
        chunks,
        lines: LineIndex::new(source),
    };
    let mut facts = match language {
        "html" => html::extract(&context, root),
        "css" => css::extract(&context, root),
        "bash" => bash::extract(&context, root),
        "zig" => zig::extract(&context, root),
        "lua" => lua::extract(&context, root),
        "python" => python::extract(&context, root),
        "go" => go::extract(&context, root),
        "c" => c::extract(&context, root),
        "java" => java::extract(&context, root),
        "kotlin" => kotlin::extract(&context, root),
        "ruby" => ruby::extract(&context, root),
        "elixir" => elixir::extract(&context, root),
        "haskell" => haskell::extract(&context, root),
        "scala" => scala::extract(&context, root),
        "dart" => dart::extract(&context, root),
        "php" => php::extract(&context, root),
        "csharp" => csharp::extract(&context, root),
        "cpp" => cpp::extract(&context, root),
        "ocaml" | "ocaml_interface" => ocaml::extract(&context, root),
        "rust" => rust::extract(&context, root),
        "javascript" => ecmascript::extract(&context, root, false),
        "typescript" | "tsx" => ecmascript::extract(&context, root, true),
        _ => Vec::new(),
    };
    if language == "ocaml_interface" {
        facts.retain(|fact| matches!(fact.kind, Kind::Import { .. }));
    }
    facts.sort_by_key(|fact| {
        (
            fact.location.start_offset,
            fact.location.end_offset,
            kind_order(&fact.kind),
        )
    });
    facts
}
