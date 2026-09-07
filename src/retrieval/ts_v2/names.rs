//! Computed declaration names that cannot be expressed by one query capture.
use super::text;
use tree_sitter::Node;

pub(super) fn bash_kind(node: Node<'_>, source: &str) -> &'static str {
    if let Some(parent) = node.parent().filter(|n| n.kind() == "declaration_command") {
        let words: Vec<_> = text(parent, source).split_whitespace().collect();
        if words.first() == Some(&"readonly")
            || (matches!(words.first(), Some(&"declare" | &"local" | &"typeset"))
                && words.iter().any(|s| {
                    s.strip_prefix('-').is_some_and(|flags| {
                        flags.bytes().all(|b| b.is_ascii_alphabetic()) && flags.contains('r')
                    })
                }))
        {
            return "constant";
        }
    }
    "variable"
}

pub(super) fn elixir(
    node: Node<'_>,
    source: &str,
    context: Option<&str>,
    captured: Option<&str>,
) -> Option<String> {
    if context == Some("defimpl") {
        let args = node
            .named_children(&mut node.walk())
            .find(|n| n.kind() == "arguments");
        let protocol = args
            .and_then(|n| {
                n.named_children(&mut n.walk())
                    .find(|n| n.kind() == "alias")
            })
            .map(|n| text(n, source));
        let keywords = args.and_then(|n| {
            n.named_children(&mut n.walk())
                .find(|n| n.kind() == "keywords")
        });
        let implementation = keywords
            .and_then(|n| {
                n.named_children(&mut n.walk())
                    .flat_map(|n| n.named_children(&mut n.walk()).collect::<Vec<_>>())
                    .find(|n| n.kind() == "alias")
            })
            .map(|n| text(n, source));
        return match (protocol, implementation) {
            (Some(p), Some(i)) => Some(format!("{p} for {i}")),
            _ => protocol.or(captured).map(str::to_owned),
        };
    }
    if context == Some("defstruct") {
        let mut current = node.parent();
        while let Some(node) = current {
            if node.kind() == "call"
                && node
                    .child_by_field_name("target")
                    .is_some_and(|n| text(n, source) == "defmodule")
            {
                let module = node
                    .named_children(&mut node.walk())
                    .find(|n| n.kind() == "arguments")
                    .and_then(|n| {
                        n.named_children(&mut n.walk())
                            .find(|n| n.kind() == "alias")
                    });
                return Some(
                    module
                        .map_or("struct", |n| text(n, source).rsplit('.').next().unwrap())
                        .into(),
                );
            }
            current = node.parent();
        }
        return Some("struct".into());
    }
    if matches!(context, Some("callback" | "macrocallback")) {
        return captured.map(|s| s.split('(').next().unwrap().into());
    }
    captured.map(str::to_owned)
}

pub(super) fn zig_kind(node: Node<'_>, source: &str) -> &'static str {
    for (syntax, kind) in [
        ("struct_declaration", "struct"),
        ("enum_declaration", "enum"),
        ("union_declaration", "struct"),
        ("opaque_declaration", "type"),
        ("error_set_declaration", "type"),
    ] {
        if node
            .named_children(&mut node.walk())
            .any(|n| n.kind() == syntax)
        {
            return kind;
        }
    }
    if text(node, source)
        .trim_start()
        .strip_prefix("const")
        .is_some_and(|s| {
            s.chars()
                .next()
                .is_none_or(|c| !c.is_alphanumeric() && c != '_')
        })
    {
        "constant"
    } else {
        "variable"
    }
}

fn lua_assignment(node: Node<'_>) -> Option<Node<'_>> {
    if node.kind() == "variable_declaration" {
        node.named_children(&mut node.walk())
            .find(|n| n.kind() == "assignment_statement")
    } else {
        Some(node)
    }
}

pub(super) fn unquote(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

pub(super) fn lua(node: Node<'_>, source: &str) -> Option<String> {
    if node.kind() == "field" {
        return node
            .child_by_field_name("name")
            .map(|n| unquote(text(n, source)).into());
    }
    let assignment = lua_assignment(node).unwrap_or(node);
    let variables = assignment
        .named_children(&mut assignment.walk())
        .find(|n| n.kind() == "variable_list")?;
    let names: Vec<_> = variables
        .named_children(&mut variables.walk())
        .map(|n| text(n, source))
        .collect();
    (!names.is_empty()).then(|| names.join(", "))
}

pub(super) fn lua_function(node: Node<'_>) -> bool {
    if node.kind() == "field" {
        return node
            .child_by_field_name("value")
            .is_some_and(|n| n.kind() == "function_definition");
    }
    lua_assignment(node)
        .and_then(|n| {
            n.named_children(&mut n.walk())
                .find(|n| n.kind() == "expression_list")
        })
        .and_then(|n| n.named_child(0))
        .is_some_and(|n| n.kind() == "function_definition")
}

pub(super) fn word(source: &str, target: &str) -> bool {
    source
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|s| s == target)
}

pub(super) fn kotlin_class_kind(node: Node<'_>, source: &str) -> &'static str {
    let modifiers = node
        .named_children(&mut node.walk())
        .find(|n| n.kind() == "modifiers")
        .map_or("", |n| text(n, source));
    if word(modifiers, "interface")
        || node
            .children(&mut node.walk())
            .any(|n| n.kind() == "interface")
    {
        return "interface";
    }
    if word(modifiers, "enum") {
        return "enum";
    }
    if word(modifiers, "annotation") {
        return "annotation_type";
    }
    if word(modifiers, "data") || word(modifiers, "value") {
        return "record";
    }
    "class"
}

pub(super) fn scala_parameter_is_field(node: Node<'_>, source: &str) -> bool {
    if word(text(node, source), "val") || word(text(node, source), "var") {
        return true;
    }
    node.parent().and_then(|p| p.parent()).is_some_and(|p| {
        p.kind() == "full_enum_case"
            || (p.kind() == "class_definition"
                && p.children(&mut p.walk()).any(|n| n.kind() == "case"))
    })
}

pub(super) fn scala(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "given_definition" => Some(
            node.child_by_field_name("name")
                .or_else(|| node.child_by_field_name("return_type"))
                .map_or("(anonymous given)", |n| text(n, source))
                .into(),
        ),
        "extension_definition" => {
            let ty = node
                .child_by_field_name("parameters")
                .and_then(|p| {
                    p.named_children(&mut p.walk())
                        .find(|n| n.kind() == "parameter")
                })
                .and_then(|n| n.child_by_field_name("type"));
            Some(ty.map_or_else(
                || "extensions".into(),
                |n| format!("{} extensions", text(n, source)),
            ))
        }
        _ => None,
    }
}

pub(super) fn php(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "namespace_definition" => Some(
            node.child_by_field_name("name")
                .map_or("(global)", |n| text(n, source))
                .into(),
        ),
        "property_declaration" | "const_declaration" => {
            let property = node.kind() == "property_declaration";
            let names: Vec<_> = node
                .named_children(&mut node.walk())
                .filter(|n| {
                    n.kind()
                        == if property {
                            "property_element"
                        } else {
                            "const_element"
                        }
                })
                .filter_map(|n| {
                    if property {
                        n.child_by_field_name("name")
                    } else {
                        n.named_child(0)
                    }
                })
                .map(|n| text(n, source).strip_prefix('$').unwrap_or(text(n, source)))
                .collect();
            (!names.is_empty()).then(|| names.join(", "))
        }
        "property_promotion_parameter" | "assignment_expression" => node
            .child_by_field_name(if node.kind() == "assignment_expression" {
                "left"
            } else {
                "name"
            })
            .map(|n| {
                text(n, source)
                    .strip_prefix('$')
                    .unwrap_or(text(n, source))
                    .into()
            }),
        _ => None,
    }
}

pub(super) fn csharp(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "field_declaration" | "event_field_declaration" => {
            let declaration = node
                .named_children(&mut node.walk())
                .find(|n| n.kind() == "variable_declaration")?;
            let names: Vec<_> = declaration
                .named_children(&mut declaration.walk())
                .filter(|n| n.kind() == "variable_declarator")
                .filter_map(|n| n.child_by_field_name("name"))
                .map(|n| text(n, source))
                .collect();
            (!names.is_empty()).then(|| names.join(", "))
        }
        "indexer_declaration" => Some("this".into()),
        "operator_declaration" => Some(
            node.children(&mut node.walk())
                .find(|n| n.kind() == "operator")
                .and_then(|n| n.next_sibling())
                .map_or_else(
                    || "operator".into(),
                    |n| format!("operator {}", text(n, source)),
                ),
        ),
        "conversion_operator_declaration" => {
            let style = node
                .children(&mut node.walk())
                .find(|n| matches!(n.kind(), "implicit" | "explicit"));
            let ty = node.child_by_field_name("type").or_else(|| {
                node.named_children(&mut node.walk())
                    .find(|n| n.kind() != "modifier")
            });
            Some(format!(
                "{} operator {}",
                style.map_or("conversion", |n| text(n, source)),
                ty.map_or("?", |n| text(n, source))
            ))
        }
        _ => None,
    }
}
