use std::ops::Range;

use tree_sitter::{Language, Node};

use super::symbols::{Rules, Symbol};

pub const TYPESCRIPT: Rules = Rules {
    grammar: typescript_grammar,
    symbol,
    imports: &["import_statement"],
};

pub const TSX: Rules = Rules {
    grammar: tsx_grammar,
    symbol,
    imports: &["import_statement"],
};

fn typescript_grammar() -> Language {
    tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}

fn tsx_grammar() -> Language {
    tree_sitter_typescript::LANGUAGE_TSX.into()
}

/// Node kinds that are always symbols, with the kind they get. Their name is
/// the `name` field and their body the `body` field.
const DECLARATIONS: &[(&str, &str)] = &[
    ("function_declaration", "function"),
    ("generator_function_declaration", "function"),
    ("class_declaration", "class"),
    ("abstract_class_declaration", "class"),
    ("interface_declaration", "interface"),
    ("type_alias_declaration", "type"),
    ("enum_declaration", "enum"),
    ("internal_module", "namespace"),
    ("module", "namespace"),
    ("method_definition", "method"),
];

/// Kinds whose body holds symbols of their own.
const CONTAINERS: &[&str] = &["class", "namespace"];

/// Values that make a variable or class field a function.
const FUNCTION_VALUES: &[&str] = &[
    "arrow_function",
    "function_expression",
    "function",
    "generator_function",
];

fn symbol<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    match node.kind() {
        // `export …` and `declare …` wrap a declaration; the wrapper's span
        // keeps the keyword with the symbol.
        "export_statement" | "ambient_declaration" => wrapped_symbol(node, text),
        "lexical_declaration" | "variable_declaration" => variable(node, text),
        "public_field_definition" => function_field(node, text),
        kind => {
            let &(_, symbol_kind) = DECLARATIONS
                .iter()
                .find(|(node_kind, _)| *node_kind == kind)?;
            let body = node.child_by_field_name("body");
            Some(Symbol {
                kind: symbol_kind,
                name: field_text(node, "name", text),
                body: body.map(|body| body.byte_range()),
                members: body.filter(|_| CONTAINERS.contains(&symbol_kind)),
            })
        }
    }
}

/// The symbol inside `export` or `declare`. `export default` of an unnamed
/// function or class is named `default`.
fn wrapped_symbol<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    let mut cursor = node.walk();
    let children: Vec<Node> = node.named_children(&mut cursor).collect();
    if let Some(inner) = children
        .iter()
        .find_map(|&child| symbol(child, text).or_else(|| default_export(child)))
    {
        return Some(inner);
    }
    // `declare global { … }` holds declarations without a named wrapper.
    let block = children
        .into_iter()
        .find(|child| child.kind() == "statement_block")?;
    Some(Symbol {
        kind: "namespace",
        name: "global".into(),
        body: Some(block.byte_range()),
        members: Some(block),
    })
}

/// `export default () => {}` and similar unnamed values.
fn default_export<'tree>(value: Node<'tree>) -> Option<Symbol<'tree>> {
    if FUNCTION_VALUES.contains(&value.kind()) || value.kind() == "class" {
        let body = value.child_by_field_name("body");
        return Some(Symbol {
            kind: if value.kind() == "class" {
                "class"
            } else {
                "function"
            },
            name: "default".into(),
            body: body.map(|body| body.byte_range()),
            members: body.filter(|_| value.kind() == "class"),
        });
    }
    None
}

/// `const a = 1` is a constant; `const handle = () => {}` is a function named
/// by its variable. A declaration of several variables is named by its first.
fn variable<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    let mut cursor = node.walk();
    let declarator = node
        .named_children(&mut cursor)
        .find(|child| child.kind() == "variable_declarator")?;
    let name = field_text(declarator, "name", text);
    match function_body(declarator.child_by_field_name("value")) {
        Some(body) => Some(Symbol {
            kind: "function",
            name,
            body: Some(body),
            members: None,
        }),
        None => Some(Symbol {
            kind: if text[node.byte_range()].starts_with("const")
                || text[node.byte_range()].starts_with("export const")
            {
                "constant"
            } else {
                "variable"
            },
            name,
            body: None,
            members: None,
        }),
    }
}

/// A class field that holds a function is a method:
/// `handleClick = (event) => {…}`.
fn function_field<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    let body = function_body(node.child_by_field_name("value"))?;
    Some(Symbol {
        kind: "method",
        name: field_text(node, "name", text),
        body: Some(body),
        members: None,
    })
}

/// The body of a function value, or `None` when the value is not a function.
fn function_body(value: Option<Node>) -> Option<Range<usize>> {
    let value = value?;
    if !FUNCTION_VALUES.contains(&value.kind()) {
        return None;
    }
    value
        .child_by_field_name("body")
        .map(|body| body.byte_range())
}

fn field_text(node: Node, field: &str, text: &str) -> String {
    node.child_by_field_name(field)
        .map(|child| text[child.byte_range()].to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::symbols::symbol_chunks;
    use crate::chunk::symbols::tests::{check_invariants, outline};
    use crate::chunk::{Chunk, own_text};

    const QUEUE: &str = include_str!("samples/queue.ts");
    const CANVAS: &str = include_str!("samples/canvas.tsx");

    fn chunks(text: &str, rules: &Rules) -> Vec<Chunk> {
        let chunks = symbol_chunks(text, rules)
            .expect("the grammar loads")
            .expect("the sample parses");
        check_invariants(text, &chunks);
        chunks
    }

    #[test]
    fn each_declaration_and_method_is_a_chunk() {
        let expected = "\
constant DEFAULT_LIMIT 6-7
interface QueueOptions 9-12
type Priority 14-14
enum State 16-19
class Queue 21-38
method Queue.constructor 27-27
method Queue.push 29-29
method Queue.size 30-30
method Queue.drain 30-32
method Queue.handleDone 34-37
function createQueue 40-45
function schedule 47-49
namespace Scheduler 51-53
function Scheduler.start 52-52
namespace global 55-59
interface global.Window 56-58
function default 61-63
imports - 3-4
lines - 1-1
lines - 65-67
";
        assert_eq!(outline(&chunks(QUEUE, &TYPESCRIPT)), expected);
    }

    #[test]
    fn a_class_outline_keeps_declarations_and_leaves_out_bodies() {
        let chunks = chunks(QUEUE, &TYPESCRIPT);
        let queue = chunks
            .iter()
            .position(|chunk| chunk.name.as_deref() == Some("Queue"))
            .expect("Queue is a chunk");
        let outline = own_text(QUEUE, &chunks, queue);
        assert!(outline.contains("  push(task: Task) …\n"), "{outline}");
        assert!(outline.contains("  size() … drain() …\n"), "{outline}");
        assert!(
            outline.contains("private handleDone = (task: Task) => …;"),
            "{outline}"
        );
        assert!(outline.contains("private items: Task[] = [];"), "{outline}");
        assert!(!outline.contains("this.items.push"), "{outline}");
    }

    #[test]
    fn symbols_sharing_a_line_are_separate_chunks() {
        let chunks = chunks(QUEUE, &TYPESCRIPT);
        let text_of = |name: &str| {
            let chunk = chunks
                .iter()
                .find(|chunk| chunk.name.as_deref() == Some(name))
                .expect("chunk exists");
            &QUEUE[chunk.bytes.clone()]
        };
        assert_eq!(text_of("size"), "size() { return this.items.length; }");
        assert!(text_of("drain").starts_with("drain() {"));
    }

    #[test]
    fn comments_attach_only_without_a_blank_line_between() {
        let chunks = chunks(QUEUE, &TYPESCRIPT);
        let start_of = |name: &str| {
            let chunk = chunks
                .iter()
                .find(|chunk| chunk.name.as_deref() == Some(name))
                .expect("chunk exists");
            &QUEUE[chunk.bytes.clone()][..3]
        };
        assert_eq!(start_of("DEFAULT_LIMIT"), "/**");
        assert_eq!(start_of("handleDone"), "// ");
        // The header comment is followed by a blank line, so it stays apart.
        assert!(outline(&chunks).contains("lines - 1-1\n"));
    }

    #[test]
    fn components_and_handlers_in_tsx_are_chunks() {
        let expected = "\
type Props 3-3
function Button 5-9
class Canvas 11-21
method Canvas.handleWheel 14-16
method Canvas.render 18-20
imports - 1-1
lines - 23-23
";
        assert_eq!(outline(&chunks(CANVAS, &TSX)), expected);
    }

    #[test]
    fn a_syntax_error_costs_only_its_region() {
        let text = "function before() {}\n\nfunction broken( {\n  const x = ;\n\nclass After {\n  method() {}\n}\n";
        // The unclosed function swallows the rest of the file into one region,
        // which is still chunked by lines and embedded.
        assert_eq!(
            outline(&chunks(text, &TYPESCRIPT)),
            "function before 1-1\nlines - 3-8\n"
        );
    }
}
