//! The active TS v2 source tree, before the 4,000 UTF-16-unit window projection.
//! It shares the language parser with analysis; facts and raw source owners stay
//! independent of retrieval's adjusted spans and collapsed import/overload groups.
use crate::analysis::{Entity as Owner, LineIndex, Span};
use anyhow::Result;
use std::{
    collections::{BTreeMap, HashSet},
    sync::OnceLock,
};
use tree_sitter::{Node, Query, QueryCursor, StreamingIterator};

mod declarators;
mod kinds;
mod markdown;
mod names;
use kinds::node_kind;
mod windows;
pub use windows::project;

pub const POLICY: &str = "ts-v2-source-windows-4000-path-average-256-32-1";

pub fn documents(analysis: &crate::analysis::Analysis) -> Result<Vec<super::split::Document>> {
    crate::storage::analysis::validate(analysis)?;
    let normalized = super::normalized::Source::new(&analysis.source.text);
    let lines = LineIndex::new(&analysis.source.text);
    let mut parts = std::collections::HashMap::new();
    project(&analysis.source.text, &analysis.source_chunks, 4000)?
        .into_iter()
        .map(|window| {
            let part = parts.entry(window.chunk).or_insert(0);
            let document = super::split::Document {
                source_chunk: Some(window.chunk),
                owner: analysis.source_chunks[window.chunk].owner,
                part: *part,
                text: format!(
                    "File: {}\n{}",
                    analysis.source.path,
                    &normalized.text[normalized.normalized_offset(window.start)?
                        ..normalized.normalized_offset(window.end)?]
                ),
                evidence: vec![super::Evidence {
                    record: super::Record::Source,
                    span: lines.span(window.start, window.end),
                }],
            };
            *part += 1;
            Ok(document)
        })
        .collect()
}

#[derive(serde::Serialize)]
pub struct Preview {
    pub source_chunk: usize,
    pub owner: Option<usize>,
    pub kind: String,
    pub name: Option<String>,
    pub context: String,
    pub text: String,
    pub span: Span,
}

pub fn preview(analysis: &crate::analysis::Analysis) -> Result<Vec<Preview>> {
    crate::storage::analysis::validate(analysis)?;
    let lines = LineIndex::new(&analysis.source.text);
    project(&analysis.source.text, &analysis.source_chunks, 4000)?
        .into_iter()
        .map(|w| {
            let chunk = &analysis.source_chunks[w.chunk];
            Ok(Preview {
                source_chunk: w.chunk,
                owner: chunk.owner,
                kind: chunk.kind.clone(),
                name: chunk.name.clone(),
                context: format!("File: {}", analysis.source.path),
                text: analysis.source.text[w.start..w.end].to_owned(),
                span: lines.span(w.start, w.end),
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Chunk {
    pub kind: String,
    pub name: Option<String>,
    pub span: Span,
    pub parent: Option<usize>,
    pub owner: Option<usize>,
}

pub(crate) struct Entity {
    pub node_type: String,
    pub kind: String,
    pub name: Option<String>,
    pub node_start: usize,
    pub node_end: usize,
    pub syntax_end: usize,
    start_row: usize,
    start: usize,
    end: usize,
    overload: bool,
    children: Vec<Entity>,
}

#[derive(Clone)]
struct TreeChunk {
    kind: String,
    name: Option<String>,
    start: usize,
    end: usize,
    children: Vec<TreeChunk>,
}

impl TreeChunk {
    fn new(kind: &str, name: Option<String>, start: usize, end: usize) -> Self {
        Self {
            kind: kind.into(),
            name,
            start,
            end,
            children: Vec::new(),
        }
    }
}

struct Comments {
    spans: Vec<(usize, usize)>,
    lines: BTreeMap<usize, (usize, usize)>,
}

fn query(language: &str, grammar: &tree_sitter::Language) -> Result<&'static Query> {
    static RUST: OnceLock<Result<Query, String>> = OnceLock::new();
    static PYTHON: OnceLock<Result<Query, String>> = OnceLock::new();
    static JS: OnceLock<Result<Query, String>> = OnceLock::new();
    static TS: OnceLock<Result<Query, String>> = OnceLock::new();
    static TSX: OnceLock<Result<Query, String>> = OnceLock::new();
    static GO: OnceLock<Result<Query, String>> = OnceLock::new();
    static C: OnceLock<Result<Query, String>> = OnceLock::new();
    static CPP: OnceLock<Result<Query, String>> = OnceLock::new();
    static CSHARP: OnceLock<Result<Query, String>> = OnceLock::new();
    static RUBY: OnceLock<Result<Query, String>> = OnceLock::new();
    static PHP: OnceLock<Result<Query, String>> = OnceLock::new();
    static SCALA: OnceLock<Result<Query, String>> = OnceLock::new();
    static HTML: OnceLock<Result<Query, String>> = OnceLock::new();
    static CSS: OnceLock<Result<Query, String>> = OnceLock::new();
    static KOTLIN: OnceLock<Result<Query, String>> = OnceLock::new();
    static LUA: OnceLock<Result<Query, String>> = OnceLock::new();
    static ZIG: OnceLock<Result<Query, String>> = OnceLock::new();
    static ELIXIR: OnceLock<Result<Query, String>> = OnceLock::new();
    static BASH: OnceLock<Result<Query, String>> = OnceLock::new();
    static TOML: OnceLock<Result<Query, String>> = OnceLock::new();
    static JAVA: OnceLock<Result<Query, String>> = OnceLock::new();
    let (slot, text) = match language {
        "rust" => (&RUST, include_str!("ts_v2/queries/rust.scm")),
        "python" => (&PYTHON, include_str!("ts_v2/queries/python.scm")),
        "javascript" => (&JS, include_str!("ts_v2/queries/javascript.scm")),
        "typescript" => (&TS, include_str!("ts_v2/queries/typescript.scm")),
        "tsx" => (&TSX, include_str!("ts_v2/queries/typescript.scm")),
        "go" => (&GO, include_str!("ts_v2/queries/go.scm")),
        "c" => (&C, include_str!("ts_v2/queries/c.scm")),
        "cpp" => (&CPP, include_str!("ts_v2/queries/cpp.scm")),
        "csharp" => (&CSHARP, include_str!("ts_v2/queries/csharp.scm")),
        "ruby" => (&RUBY, include_str!("ts_v2/queries/ruby.scm")),
        "php" => (&PHP, include_str!("ts_v2/queries/php.scm")),
        "scala" => (&SCALA, include_str!("ts_v2/queries/scala.scm")),
        "html" => (&HTML, include_str!("ts_v2/queries/html.scm")),
        "css" => (&CSS, include_str!("ts_v2/queries/css.scm")),
        "kotlin" => (&KOTLIN, include_str!("ts_v2/queries/kotlin.scm")),
        "lua" => (&LUA, include_str!("ts_v2/queries/lua.scm")),
        "zig" => (&ZIG, include_str!("ts_v2/queries/zig.scm")),
        "elixir" => (&ELIXIR, include_str!("ts_v2/queries/elixir.scm")),
        "bash" => (&BASH, include_str!("ts_v2/queries/bash.scm")),
        "toml" => (&TOML, include_str!("ts_v2/queries/toml.scm")),
        "java" => (&JAVA, include_str!("ts_v2/queries/java.scm")),
        _ => anyhow::bail!("unsupported retrieval grammar {language}"),
    };
    slot.get_or_init(|| Query::new(grammar, text).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| anyhow::anyhow!("cannot compile {language} retrieval query: {e}"))
}

pub fn from_tree(
    source: &str,
    root: Node<'_>,
    grammar: &tree_sitter::Language,
    language: &str,
    owners: &[Owner],
) -> Result<Vec<Chunk>> {
    let flat = declarations(source, root, grammar, language)?;
    Ok(build_chunks(source, root, language, owners, flat))
}

pub(crate) fn declarations(
    source: &str,
    root: Node<'_>,
    grammar: &tree_sitter::Language,
    language: &str,
) -> Result<Vec<Entity>> {
    let query = query(language, grammar)?;
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, root, source.as_bytes());
    let names = query.capture_names();
    let mut flat = Vec::new();
    let mut seen = HashSet::new();
    while let Some(m) = matches.next() {
        let Some(item) = m
            .captures()
            .iter()
            .find(|c| names[c.index as usize] == "item")
        else {
            continue;
        };
        let node = item.node;
        if language == "cpp"
            && node.parent().is_some_and(|p| {
                p.kind() == "template_declaration" && declarators::template(p) == Some(node)
            })
        {
            continue;
        }
        if language == "scala"
            && node.kind() == "class_parameter"
            && !names::scala_parameter_is_field(node, source)
        {
            continue;
        }
        if language == "kotlin"
            && node.kind() == "class_parameter"
            && !names::word(text(node, source), "val")
            && !names::word(text(node, source), "var")
        {
            continue;
        }
        if language == "bash"
            && node.kind() == "variable_assignment"
            && node.parent().is_some_and(|n| n.kind() == "command")
        {
            continue;
        }
        if !seen.insert(node.start_byte()) {
            continue;
        }
        let captured = m
            .captures()
            .iter()
            .find(|c| names[c.index as usize] == "name")
            .map(|c| text(c.node, source).to_owned());
        let context = m
            .captures()
            .iter()
            .find(|c| names[c.index as usize] == "context")
            .map(|c| text(c.node, source));
        let special = |name: &str| m.captures().iter().any(|c| names[c.index as usize] == name);
        let mut kind = node_kind(node.kind()).to_owned();
        if special("docstring") {
            kind = "comment".into();
        }
        if node.kind() == "variable_declarator"
            && node.child_by_field_name("value").is_some_and(|n| {
                matches!(
                    n.kind(),
                    "arrow_function" | "function_expression" | "lambda_expression"
                )
            })
        {
            kind = "function".into();
        }
        if (language == "go"
            && ((node.kind() == "short_var_declaration"
                && contains(node.child_by_field_name("right"), "func_literal"))
                || (node.kind() == "var_spec"
                    && contains(node.child_by_field_name("value"), "func_literal"))))
            || (language == "rust"
                && node.kind() == "let_declaration"
                && contains(node.child_by_field_name("value"), "closure_expression"))
        {
            kind = "function".into();
        }
        if language == "go" && node.kind() == "type_spec" {
            kind = match node.child_by_field_name("type").map(|n| n.kind()) {
                Some("struct_type") => "struct",
                Some("interface_type") => "interface",
                _ => "type",
            }
            .into();
        }
        if language == "java" && node.kind() == "block" {
            kind = "initializer".into();
        }
        if language == "c" && node.kind() == "declaration" {
            kind = declarators::kind(node, source, false).into();
        }
        if language == "cpp" {
            match node.kind() {
                "declaration" | "field_declaration" => {
                    kind = declarators::kind(node, source, true).into()
                }
                "template_declaration" => kind = declarators::template_kind(node).into(),
                "function_definition" if declarators::qualified_method(node, source) => {
                    kind = "method".into()
                }
                _ => {}
            }
            if node.kind() == "declaration" && contains(Some(node), "lambda_expression") {
                kind = "function".into();
            }
        }
        if language == "csharp"
            && node.kind() == "variable_declarator"
            && contains(Some(node), "lambda_expression")
        {
            kind = "function".into();
        }
        if language == "ruby" && node.kind() == "assignment" {
            kind = if contains(node.child_by_field_name("right"), "lambda") {
                "function"
            } else {
                "constant"
            }
            .into();
        }
        if language == "php" {
            if node.kind() == "property_declaration" {
                kind = "field".into();
            }
            if node.kind() == "assignment_expression"
                && node
                    .child_by_field_name("right")
                    .is_some_and(|n| matches!(n.kind(), "arrow_function" | "anonymous_function"))
            {
                kind = "function".into();
            }
        }
        let captured = captured.map(|n| {
            if language == "php" {
                n.strip_prefix('$').unwrap_or(&n).to_owned()
            } else {
                n
            }
        });
        if language == "scala"
            && matches!(node.kind(), "val_definition" | "var_definition")
            && contains(node.child_by_field_name("value"), "lambda_expression")
        {
            kind = "function".into();
        }
        if language == "kotlin" {
            if node.kind() == "class_declaration" {
                kind = names::kotlin_class_kind(node, source).into();
            }
            if node.kind() == "property_declaration" {
                kind = if contains(Some(node), "lambda_literal") {
                    "function"
                } else {
                    "variable"
                }
                .into();
            }
        }
        if language == "lua" {
            if node.kind() == "function_declaration" {
                kind = if node
                    .child_by_field_name("name")
                    .is_some_and(|n| n.kind() == "method_index_expression")
                {
                    "method"
                } else {
                    "function"
                }
                .into();
            }
            if matches!(
                node.kind(),
                "variable_declaration" | "assignment_statement" | "field"
            ) && names::lua_function(node)
            {
                kind = "function".into();
            }
        }
        if language == "zig" {
            if node.kind() == "variable_declaration" {
                kind = names::zig_kind(node, source).into();
            }
            if node.kind() == "identifier"
                && node
                    .parent()
                    .is_some_and(|n| n.kind() == "error_set_declaration")
            {
                kind = "constant".into();
            }
        }
        if language == "elixir" {
            if node.kind() == "binary_operator"
                && contains(node.child_by_field_name("right"), "anonymous_function")
            {
                kind = "function".into();
            }
            kind = match context {
                Some("defmodule") => "module",
                Some("defprotocol") => "trait",
                Some("defimpl") => "impl",
                Some("defstruct") => "struct",
                Some("type" | "typep" | "opaque") => "type",
                Some("callback" | "macrocallback") => "method",
                Some("import" | "alias" | "use" | "require") => "import",
                _ => &kind,
            }
            .into();
        }
        let captured = if language == "elixir" {
            names::elixir(node, source, context, captured.as_deref())
        } else {
            captured
        };
        if language == "bash" {
            if node.kind() == "variable_assignment" {
                kind = names::bash_kind(node, source).into();
            }
            if matches!(context, Some("source" | ".")) {
                kind = "import".into();
            }
        }
        let name = declared_name(node, source, language)
            .or(captured)
            .or_else(|| special("default_export").then(|| "default".into()));
        let mut node_end =
            if language == "csharp" && node.kind() == "file_scoped_namespace_declaration" {
                root.end_byte()
            } else {
                node.end_byte()
            };
        if language == "php"
            && node.kind() == "namespace_definition"
            && node.child_by_field_name("body").is_none()
        {
            node_end = root
                .named_children(&mut root.walk())
                .find(|n| n.kind() == "namespace_definition" && n.start_byte() > node.start_byte())
                .map_or(root.end_byte(), |n| n.start_byte());
        }
        if language == "scala"
            && node.kind() == "package_clause"
            && node.child_by_field_name("body").is_none()
        {
            node_end = root.end_byte();
        }
        if language == "html" && node.kind() == "element" {
            let tag = node
                .named_children(&mut node.walk())
                .find(|n| matches!(n.kind(), "start_tag" | "self_closing_tag"));
            let closed = node
                .named_children(&mut node.walk())
                .any(|n| n.kind() == "end_tag");
            if !closed && let Some(tag) = tag {
                node_end = tag.end_byte();
            }
        }
        if language == "kotlin" && node.kind() == "package_header" {
            node_end = root.end_byte();
        }
        flat.push(Entity {
            node_type: node.kind().into(),
            kind,
            name,
            node_start: node.start_byte(),
            node_end,
            syntax_end: node.end_byte(),
            start_row: node.start_position().row,
            start: node.start_byte(),
            end: node_end,
            overload: special("overload"),
            children: Vec::new(),
        });
    }
    flat.sort_by_key(|e| (e.node_start, std::cmp::Reverse(e.node_end)));
    Ok(flat)
}

pub(crate) fn build_chunks(
    source: &str,
    root: Node<'_>,
    language: &str,
    owners: &[Owner],
    flat: Vec<Entity>,
) -> Vec<Chunk> {
    let mut entities = nest(flat);
    let comments = comments(root, source, language);
    let starts = line_starts(source);
    adjust(
        &mut entities,
        source,
        &starts,
        language,
        &comments.lines,
        Parent {
            floor: None,
            end: source.len(),
            kind: None,
        },
    );
    entities = collapse(entities, source);
    let tree = emit_level(source, &starts, &comments.spans, &entities, 0, source.len());
    flatten(tree, source, owners)
}

fn text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    &source[node.start_byte()..node.end_byte()]
}
fn contains(node: Option<Node<'_>>, kind: &str) -> bool {
    let Some(node) = node else { return false };
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if node.kind() == kind {
            return true;
        }
        stack.extend(node.named_children(&mut node.walk()));
    }
    false
}

fn declared_name(node: Node<'_>, source: &str, language: &str) -> Option<String> {
    if language == "zig" {
        if node.kind() == "test_declaration" {
            return Some(
                node.named_children(&mut node.walk())
                    .find(|n| n.kind() == "string")
                    .map_or("(anonymous test)", |n| names::unquote(text(n, source)))
                    .into(),
            );
        }
        if node.kind() == "comptime_declaration" {
            return Some("comptime".into());
        }
    }
    if language == "lua" {
        return names::lua(node, source);
    }
    if language == "kotlin" {
        if node.kind() == "companion_object" {
            return Some(
                node.child_by_field_name("name")
                    .map_or("(companion)", |n| text(n, source))
                    .into(),
            );
        }
        if node.kind() == "secondary_constructor" {
            return Some("constructor".into());
        }
    }
    if language == "css"
        && matches!(
            node.kind(),
            "media_statement" | "supports_statement" | "scope_statement" | "at_rule"
        )
    {
        let end = node
            .named_children(&mut node.walk())
            .find(|n| n.kind() == "block")
            .map_or(node.end_byte(), |n| n.start_byte());
        let name = source[node.start_byte()..end]
            .trim()
            .trim_end_matches(';')
            .trim();
        return (!name.is_empty()).then(|| name.to_owned());
    }
    if language == "scala" {
        return names::scala(node, source);
    }
    if language == "php" {
        return names::php(node, source);
    }
    if language == "ruby" {
        if node.kind() == "singleton_class" {
            return Some(format!(
                "singleton {}",
                node.child_by_field_name("value")
                    .map_or("?", |n| text(n, source))
            ));
        }
        if node.kind() == "assignment" {
            return node
                .child_by_field_name("left")
                .map(|n| text(n, source).into());
        }
    }
    if language == "csharp" {
        return names::csharp(node, source);
    }
    if matches!(language, "c" | "cpp") {
        return declarators::declared_name(node, source);
    }
    if language == "rust" && node.kind() == "impl_item" {
        let ty = text(node.child_by_field_name("type")?, source);
        return Some(node.child_by_field_name("trait").map_or_else(
            || ty.to_owned(),
            |tr| format!("{} for {ty}", text(tr, source)),
        ));
    }
    if language == "java" && node.kind() == "field_declaration" {
        let names: Vec<_> = node
            .named_children(&mut node.walk())
            .filter(|n| n.kind() == "variable_declarator")
            .filter_map(|n| n.child_by_field_name("name"))
            .map(|n| text(n, source))
            .collect();
        return (!names.is_empty()).then(|| names.join(", "));
    }
    if language != "go" {
        return None;
    }
    let mut names = Vec::new();
    match node.kind() {
        "field_declaration" => {
            for child in node.named_children(&mut node.walk()) {
                if child.kind() == "field_identifier" {
                    names.push(text(child, source));
                }
            }
            if names.is_empty() {
                return node
                    .child_by_field_name("type")
                    .map(|n| text(n, source).to_owned());
            }
        }
        "const_spec" | "var_spec" => {
            let boundary = node
                .child_by_field_name("type")
                .map_or(node.end_byte(), |n| n.start_byte())
                .min(
                    node.child_by_field_name("value")
                        .map_or(node.end_byte(), |n| n.start_byte()),
                );
            for child in node.named_children(&mut node.walk()) {
                if child.kind() == "identifier" && child.end_byte() <= boundary {
                    names.push(text(child, source));
                }
            }
        }
        "short_var_declaration" => {
            let left = node.child_by_field_name("left")?;
            for child in left.named_children(&mut left.walk()) {
                if child.kind() == "identifier" {
                    names.push(text(child, source));
                }
            }
        }
        _ => return None,
    }
    (!names.is_empty()).then(|| names.join(", "))
}

fn nest(flat: Vec<Entity>) -> Vec<Entity> {
    fn insert(level: &mut Vec<Entity>, entity: Entity) {
        if let Some(parent) = level.last_mut()
            && parent.node_end > entity.node_start
        {
            if entity.node_end > parent.node_end
                || (entity.node_start == parent.node_start && entity.node_end == parent.node_end)
            {
                return;
            }
            insert(&mut parent.children, entity);
        } else {
            level.push(entity);
        }
    }
    let mut roots = Vec::new();
    for entity in flat {
        insert(&mut roots, entity);
    }
    roots
}

fn line_starts(source: &str) -> Vec<usize> {
    std::iter::once(0)
        .chain(source.match_indices('\n').map(|(i, _)| i + 1))
        .collect()
}
fn row(starts: &[usize], byte: usize) -> usize {
    starts.partition_point(|&i| i <= byte) - 1
}

fn comments(root: Node<'_>, source: &str, language: &str) -> Comments {
    let starts = line_starts(source);
    let mut result = Comments {
        spans: Vec::new(),
        lines: BTreeMap::new(),
    };
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        let (sr, er) = (node.start_position().row, node.end_position().row);
        if language == "python" && node.kind() == "decorator" {
            for i in sr..=er {
                result.lines.insert(i, (sr, er));
            }
        }
        if node.kind().contains("comment") {
            result.spans.push((node.start_byte(), node.end_byte()));
            let pure_start = source[starts[sr]..node.start_byte()].trim().is_empty();
            let pure_end = source
                [node.end_byte()..starts.get(er + 1).copied().unwrap_or(source.len())]
                .trim()
                .is_empty();
            for i in sr..=er {
                if (i != sr || pure_start) && (i != er || pure_end) {
                    result.lines.insert(i, (sr, er));
                }
            }
        } else {
            stack.extend(node.children(&mut node.walk()));
        }
    }
    result.spans.sort_unstable();
    result
}

fn decorator(line: &str, language: &str) -> bool {
    let line = line.trim();
    match language {
        "python" => line.starts_with('@'),
        "typescript" | "tsx" | "javascript" => {
            line.starts_with('@') && !line.starts_with("@interface")
        }
        "rust" => line.starts_with("#[") || line.starts_with("#!["),
        _ => false,
    }
}

pub(crate) fn classified_kind<'a>(
    language: &str,
    node_type: &str,
    kind: &'a str,
    parent: Option<&str>,
) -> &'a str {
    if kind == "function"
        && ((language == "python" && parent == Some("class"))
            || (language == "rust" && matches!(parent, Some("impl" | "trait")))
            || (language == "cpp" && matches!(parent, Some("class" | "struct"))))
    {
        return "method";
    }
    if language == "python" && parent == Some("class") && kind == "variable" {
        return "field";
    }
    if language == "scala" {
        if matches!(parent, Some("class" | "trait" | "enum" | "given" | "impl"))
            && kind == "function"
            && matches!(node_type, "function_definition" | "function_declaration")
        {
            return "method";
        }
        if matches!(
            parent,
            Some("class" | "trait" | "enum" | "given" | "impl" | "module")
        ) && kind == "variable"
        {
            return "field";
        }
    }
    if language == "kotlin"
        && matches!(
            parent,
            Some("class" | "interface" | "enum" | "record" | "annotation_type")
        )
    {
        if kind == "function" && node_type == "function_declaration" {
            return "method";
        }
        if node_type == "property_declaration" {
            return "field";
        }
    }
    if language == "zig" {
        if matches!(parent, Some("struct" | "enum" | "type")) && kind == "function" {
            return "method";
        }
        if parent == Some("enum") && node_type == "container_field" {
            return "constant";
        }
    }
    kind
}

struct Parent<'a> {
    floor: Option<usize>,
    end: usize,
    kind: Option<&'a str>,
}

fn adjust(
    entities: &mut [Entity],
    source: &str,
    starts: &[usize],
    language: &str,
    comments: &BTreeMap<usize, (usize, usize)>,
    parent: Parent<'_>,
) {
    let mut previous = parent.floor;
    for i in 0..entities.len() {
        let next_row = entities.get(i + 1).map(|e| e.start_row);
        let entity = &mut entities[i];
        entity.kind =
            classified_kind(language, &entity.node_type, &entity.kind, parent.kind).into();
        let mut attached = entity.start_row;
        let mut cursor = entity.start_row;
        while cursor > 0 && previous.is_none_or(|p| cursor - 1 > p) {
            let i = cursor - 1;
            let line = &source[starts[i]..starts.get(i + 1).copied().unwrap_or(source.len())];
            if line.trim().is_empty() {
                break;
            }
            if let Some(&(start, _)) = comments.get(&i)
                && comments.contains_key(&start)
            {
                attached = start.max(previous.map_or(0, |p| p + 1));
                cursor = attached;
            } else if decorator(line, language) {
                attached = i;
                cursor = i;
            } else {
                break;
            }
        }
        if attached < entity.start_row {
            entity.start = starts[attached];
        } else if previous.is_none_or(|p| p < entity.start_row) {
            entity.start = starts[entity.start_row];
        }
        let end_row = row(starts, entity.start.max(entity.node_end.saturating_sub(1)));
        let end = if next_row.is_none_or(|next| next > end_row) {
            starts.get(end_row + 1).copied().unwrap_or(source.len())
        } else {
            entity.node_end
        };
        entity.end = end.max(entity.node_end).min(parent.end);
        adjust(
            &mut entity.children,
            source,
            starts,
            language,
            comments,
            Parent {
                floor: Some(entity.start_row),
                end: entity.end,
                kind: Some(&entity.kind),
            },
        );
        previous = Some(row(starts, entity.start.max(entity.end.saturating_sub(1))));
    }
}

fn blank_line(text: &str) -> bool {
    text.split_once('\n').is_some_and(|(_, rest)| {
        rest.split('\n')
            .next()
            .is_some_and(|line| line.bytes().all(|b| b == b' ' || b == b'\t'))
            && rest.contains('\n')
    })
}

fn collapse(entities: Vec<Entity>, source: &str) -> Vec<Entity> {
    let mut imports: Vec<Entity> = Vec::new();
    for entity in entities {
        if let Some(previous) = imports.last_mut()
            && previous.kind == "import"
            && entity.kind == "import"
            && previous.children.is_empty()
            && entity.children.is_empty()
        {
            let between = &source[previous.end..entity.start];
            if between.trim().is_empty() && !blank_line(between) {
                previous.end = entity.end;
                previous.node_end = entity.node_end;
                previous.name = None;
                continue;
            }
        }
        imports.push(entity);
    }
    let mut result: Vec<Entity> = Vec::new();
    for mut entity in imports {
        if let Some(previous) = result.last_mut()
            && previous.overload
            && matches!(previous.kind.as_str(), "function" | "method")
            && entity.kind == previous.kind
            && entity.name == previous.name
            && source[previous.end..entity.start].trim().is_empty()
        {
            previous.node_end = entity.node_end;
            previous.end = entity.end;
            previous.overload = entity.overload;
            previous.children.append(&mut entity.children);
            continue;
        }
        result.push(entity);
    }
    for entity in &mut result {
        entity.children = collapse(std::mem::take(&mut entity.children), source);
    }
    result
}

fn filler(
    source: &str,
    starts: &[usize],
    comments: &[(usize, usize)],
    start: usize,
    end: usize,
    output: &mut Vec<TreeChunk>,
) {
    if start >= end {
        return;
    }
    let mut blocks: Vec<(usize, usize)> = Vec::new();
    for &(cs, ce) in comments
        .iter()
        .filter(|&&(cs, ce)| cs >= start && ce <= end)
    {
        if let Some(previous) = blocks.last_mut() {
            let between = &source[previous.1..cs];
            if between.trim().is_empty() && !blank_line(between) {
                previous.1 = ce;
                continue;
            }
        }
        blocks.push((cs, ce));
    }
    let mut cursor = start;
    let remainder = |s, e, output: &mut Vec<TreeChunk>| {
        if s < e {
            output.push(TreeChunk::new(
                if source[s..e].trim().is_empty() {
                    "gap"
                } else {
                    "block"
                },
                None,
                s,
                e,
            ));
        }
    };
    for (mut bs, mut be) in blocks {
        let mut scan = be;
        while scan < end && matches!(source.as_bytes()[scan], b' ' | b'\t') {
            scan += 1;
        }
        if scan < end && source.as_bytes()[scan] == b'\n' {
            be = scan + 1;
        }
        let line = starts[row(starts, bs)];
        if line >= cursor && source[line..bs].trim().is_empty() {
            bs = line;
        }
        remainder(cursor, bs, output);
        output.push(TreeChunk::new("comment", None, bs, be));
        cursor = be;
    }
    remainder(cursor, end, output);
}

fn emit_level(
    source: &str,
    starts: &[usize],
    comments: &[(usize, usize)],
    entities: &[Entity],
    start: usize,
    end: usize,
) -> Vec<TreeChunk> {
    let mut output = Vec::new();
    let mut cursor = start;
    for entity in entities {
        let es = entity.start.max(cursor);
        let ee = entity.end.max(es).min(end);
        if ee <= es {
            continue;
        }
        filler(source, starts, comments, cursor, es, &mut output);
        let mut chunk = TreeChunk::new(&entity.kind, entity.name.clone(), es, ee);
        if !entity.children.is_empty() || comments.iter().any(|&(cs, ce)| cs >= es && ce <= ee) {
            chunk.children = emit_level(source, starts, comments, &entity.children, es, ee);
        }
        output.push(chunk);
        cursor = ee;
    }
    filler(source, starts, comments, cursor, end, &mut output);
    output
}

fn flatten(tree: Vec<TreeChunk>, source: &str, owners: &[Owner]) -> Vec<Chunk> {
    fn visit(
        tree: Vec<TreeChunk>,
        parent: Option<usize>,
        lines: &LineIndex,
        owners: &[Owner],
        output: &mut Vec<Chunk>,
    ) {
        for chunk in tree {
            let id = output.len();
            let owner = chunk.name.as_ref().and_then(|name| {
                owners.iter().position(|owner| {
                    owner.name.as_ref() == Some(name)
                        && owner.span.start >= chunk.start
                        && owner.span.end <= chunk.end
                })
            });
            output.push(Chunk {
                kind: chunk.kind,
                name: chunk.name,
                span: lines.span(chunk.start, chunk.end),
                parent,
                owner,
            });
            visit(chunk.children, Some(id), lines, owners, output);
        }
    }
    let mut output = Vec::new();
    visit(tree, None, &LineIndex::new(source), owners, &mut output);
    output
}

pub fn text_chunks(source: &str, path: &str) -> Vec<Chunk> {
    if path.ends_with(".md") || path.ends_with(".markdown") {
        return flatten(markdown::chunks(source), source, &[]);
    }
    let mut tree = Vec::new();
    let mut start = 0;
    let mut kind = None;
    let mut end = 0;
    for line in source.split_inclusive('\n') {
        let next = if line
            .trim_end_matches('\n')
            .bytes()
            .all(|b| matches!(b, b' ' | b'\t'))
        {
            "gap"
        } else {
            "paragraph"
        };
        if kind.is_some_and(|previous| previous != next) {
            tree.push(TreeChunk::new(kind.unwrap(), None, start, end));
            start = end;
        }
        kind = Some(next);
        end += line.len();
    }
    if start < end {
        tree.push(TreeChunk::new(kind.unwrap(), None, start, end));
    }
    flatten(tree, source, &[])
}

#[cfg(test)]
#[path = "../../tests/unit/ts_v2_source.rs"]
mod tests;
