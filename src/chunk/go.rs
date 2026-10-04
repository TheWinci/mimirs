use tree_sitter::{Language, Node};

use super::symbols::{Rules, Symbol};

pub const GO: Rules = Rules {
    grammar,
    symbol,
    is_import,
};

fn grammar() -> Language {
    tree_sitter_go::LANGUAGE.into()
}

fn is_import(node: Node, _text: &str) -> bool {
    node.kind() == "import_declaration"
}

fn symbol<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    match node.kind() {
        "function_declaration" => Some(Symbol {
            kind: "function",
            name: field_text(node, "name", text),
            body: node
                .child_by_field_name("body")
                .map(|body| body.byte_range()),
            members: None,
        }),
        "method_declaration" => Some(method(node, text)),
        "type_declaration" => type_declaration(node, text),
        "type_spec" | "type_alias" => Some(type_spec(node, text)),
        // A `const ( … )` or `var ( … )` block is one symbol named by its first
        // name; a single `const X = 1` is its own.
        "const_declaration" => Some(value_block(node, "constant", text)),
        "var_declaration" => Some(value_block(node, "variable", text)),
        _ => None,
    }
}

/// Go writes methods outside their type, so a method's own name includes its
/// receiver type: `func (c *Cache) Get` is `Cache.Get`.
fn method<'tree>(node: Node<'tree>, text: &str) -> Symbol<'tree> {
    let method_name = field_text(node, "name", text);
    let receiver_type = node
        .child_by_field_name("receiver")
        .and_then(first_type_identifier)
        .map(|type_name| text[type_name.byte_range()].to_string());
    let name = match receiver_type {
        Some(type_name) => format!("{type_name}.{method_name}"),
        None => method_name,
    };
    Symbol {
        kind: "method",
        name,
        body: node
            .child_by_field_name("body")
            .map(|body| body.byte_range()),
        members: None,
    }
}

/// The first type name inside `node`, such as `Cache` in `(c *Cache)`.
fn first_type_identifier(node: Node) -> Option<Node> {
    if node.kind() == "type_identifier" {
        return Some(node);
    }
    let mut cursor = node.walk();
    let children: Vec<Node> = node.named_children(&mut cursor).collect();
    children.into_iter().find_map(first_type_identifier)
}

/// `type Cache struct {…}` is the type itself; `type ( A …; B … )` is an
/// unnamed group whose types are its children.
fn type_declaration<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    let mut cursor = node.walk();
    let specs: Vec<Node> = node
        .named_children(&mut cursor)
        .filter(|child| matches!(child.kind(), "type_spec" | "type_alias"))
        .collect();
    if let [single] = specs.as_slice() {
        let spec = type_spec(*single, text);
        return Some(Symbol {
            members: None,
            ..spec
        });
    }
    Some(Symbol {
        kind: "types",
        name: String::new(),
        body: None,
        members: Some(node),
    })
}

/// A struct's fields and an interface's methods are part of its own text; in
/// a group they are left out of the group's text.
fn type_spec<'tree>(node: Node<'tree>, text: &str) -> Symbol<'tree> {
    let type_node = node.child_by_field_name("type");
    let kind = match type_node.map(|type_node| type_node.kind()) {
        Some("struct_type") => "struct",
        Some("interface_type") => "interface",
        _ => "type",
    };
    let body = type_node
        .filter(|_| kind != "type")
        .and_then(|type_node| type_node.named_child(0))
        .map(|fields| fields.byte_range());
    Symbol {
        kind,
        name: field_text(node, "name", text),
        body,
        members: None,
    }
}

fn value_block<'tree>(node: Node<'tree>, kind: &'static str, text: &str) -> Symbol<'tree> {
    let mut cursor = node.walk();
    let first_spec = node
        .named_children(&mut cursor)
        .find(|child| matches!(child.kind(), "const_spec" | "var_spec" | "var_spec_list"));
    let name = first_spec
        .and_then(|spec| {
            if spec.kind() == "var_spec_list" {
                spec.named_child(0)
            } else {
                Some(spec)
            }
        })
        .map(|spec| field_text(spec, "name", text))
        .unwrap_or_default();
    Symbol {
        kind,
        name,
        body: None,
        members: None,
    }
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

    const CACHE: &str = include_str!("samples/cache.go");

    fn chunks() -> Vec<crate::chunk::Chunk> {
        let chunks = symbol_chunks(CACHE, &GO)
            .expect("the grammar loads")
            .expect("the sample parses");
        check_invariants(CACHE, &chunks);
        chunks
    }

    #[test]
    fn declarations_and_methods_are_chunks() {
        let expected = "\
constant DefaultTTL 9-10
constant MaxEntries 12-15
variable hits 17-20
types - 22-25
type Key 23-23
type Value 24-24
struct Cache 27-31
interface Store 33-35
function NewCache 37-40
method Cache.Get 42-48
method Cache.Len 50-50
imports - 4-7
lines - 1-2
";
        assert_eq!(outline(&chunks()), expected);
    }

    #[test]
    fn a_method_is_named_by_its_receiver_type_without_a_parent() {
        let chunks = chunks();
        let get = chunks
            .iter()
            .find(|chunk| chunk.name.as_deref() == Some("Cache.Get"))
            .expect("Cache.Get is a chunk");
        assert_eq!(get.parent, None);
    }

    #[test]
    fn a_type_group_outline_lists_its_types() {
        let chunks = chunks();
        let group = chunks
            .iter()
            .position(|chunk| chunk.kind == "types")
            .expect("the group is a chunk");
        assert_eq!(
            crate::chunk::own_text(CACHE, &chunks, group),
            "type (\n\tKey   string\n\tValue []byte\n)"
        );
    }
}
