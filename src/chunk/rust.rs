use tree_sitter::{Language, Node};

use super::symbols::{Rules, Symbol};

pub const RUST: Rules = Rules {
    grammar,
    symbol,
    is_import,
};

fn grammar() -> Language {
    tree_sitter_rust::LANGUAGE.into()
}

/// `use …`, `extern crate …`, and `mod name;` without a body.
fn is_import(node: Node, _text: &str) -> bool {
    match node.kind() {
        "use_declaration" | "extern_crate_declaration" => true,
        "mod_item" => node.child_by_field_name("body").is_none(),
        _ => false,
    }
}

/// Node kinds that are symbols, with the kind they get. Their name is the
/// `name` field and their body the `body` field.
const ITEMS: &[(&str, &str)] = &[
    ("function_item", "function"),
    ("function_signature_item", "function"),
    ("struct_item", "struct"),
    ("enum_item", "enum"),
    ("union_item", "union"),
    ("type_item", "type"),
    ("trait_item", "trait"),
    ("mod_item", "module"),
    ("const_item", "constant"),
    ("static_item", "static"),
    ("macro_definition", "macro"),
];

/// Kinds whose body holds symbols of their own.
const CONTAINERS: &[&str] = &["trait", "module", "impl"];

fn symbol<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    if node.kind() == "impl_item" {
        return Some(impl_block(node, text));
    }
    let &(_, kind) = ITEMS
        .iter()
        .find(|(node_kind, _)| *node_kind == node.kind())?;
    // A function inside an `impl` or a trait is a method.
    let in_impl_or_trait = node
        .parent()
        .and_then(|list| list.parent())
        .is_some_and(|owner| matches!(owner.kind(), "impl_item" | "trait_item"));
    let kind = if kind == "function" && in_impl_or_trait {
        "method"
    } else {
        kind
    };
    let body = node.child_by_field_name("body");
    Some(Symbol {
        kind,
        name: field_text(node, "name", text),
        body: body.map(|body| body.byte_range()),
        members: body.filter(|_| CONTAINERS.contains(&kind)),
    })
}

/// An `impl` block is named after its type, so `impl Display for Cache` is
/// `Cache` and its functions are `Cache.fmt`.
fn impl_block<'tree>(node: Node<'tree>, text: &str) -> Symbol<'tree> {
    let name = node
        .child_by_field_name("type")
        .and_then(first_type_identifier)
        .map(|type_name| text[type_name.byte_range()].to_string())
        .unwrap_or_default();
    let body = node.child_by_field_name("body");
    Symbol {
        kind: "impl",
        name,
        body: body.map(|body| body.byte_range()),
        members: body,
    }
}

/// The first type name inside `node`, such as `Cache` in `Cache<T>`.
fn first_type_identifier(node: Node) -> Option<Node> {
    if node.kind() == "type_identifier" {
        return Some(node);
    }
    let mut cursor = node.walk();
    let children: Vec<Node> = node.named_children(&mut cursor).collect();
    children.into_iter().find_map(first_type_identifier)
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

    const CACHE: &str = include_str!("samples/cache.rs");

    #[test]
    fn items_impl_blocks_and_their_functions_are_chunks() {
        let chunks = symbol_chunks(CACHE, &RUST)
            .expect("the grammar loads")
            .expect("the sample parses");
        check_invariants(CACHE, &chunks);
        let expected = "\
constant MAX_ENTRIES 8-9
struct Cache 11-14
impl Cache 16-25
method Cache.new 17-19
method Cache.get 21-24
impl Cache 27-31
method Cache.fmt 28-30
trait Store 33-35
method Store.load 34-34
macro entry 37-41
module tests 43-51
function tests.starts_empty 47-50
imports - 3-6
lines - 1-1
";
        assert_eq!(outline(&chunks), expected);
    }
}
