use super::{Entity, Fact};
use tree_sitter::Node;

pub(super) fn extract(nodes: &[Node<'_>], source: &str, entities: &[Entity]) -> Vec<Fact> {
    let mut output = Vec::new();
    for &node in nodes {
        match node.kind() {
            "use_declaration" => {
                let mut declaration = Fact::new("import", node, source, entities);
                visibility(&mut declaration, node, source);
                declaration.add("argument", node.child_by_field_name("argument"), source);
                output.push(declaration);
                if let Some(argument) = node.child_by_field_name("argument") {
                    let mut stack = vec![(argument, Vec::new())];
                    while let Some((member, mut prefixes)) = stack.pop() {
                        match member.kind() {
                            "scoped_use_list" => {
                                if let Some(path) = member.child_by_field_name("path") {
                                    prefixes.push(path);
                                }
                                if let Some(list) = member.child_by_field_name("list") {
                                    stack.push((list, prefixes));
                                }
                            }
                            "use_list" => {
                                let mut cursor = member.walk();
                                let children: Vec<_> = member
                                    .named_children(&mut cursor)
                                    .filter(|n| {
                                        !matches!(n.kind(), "line_comment" | "block_comment")
                                    })
                                    .collect();
                                stack.extend(
                                    children.into_iter().rev().map(|n| (n, prefixes.clone())),
                                );
                            }
                            _ => {
                                let mut fact = Fact::new("import_member", member, source, entities);
                                fact.add("declaration", Some(node), source);
                                for prefix in prefixes {
                                    fact.add("prefix", Some(prefix), source);
                                }
                                if member.kind() == "use_as_clause" {
                                    fact.add("path", member.child_by_field_name("path"), source);
                                    fact.add("alias", member.child_by_field_name("alias"), source);
                                } else {
                                    fact.add(
                                        if member.kind() == "use_wildcard" {
                                            "glob"
                                        } else {
                                            "path"
                                        },
                                        Some(member),
                                        source,
                                    );
                                }
                                output.push(fact);
                            }
                        }
                    }
                }
            }
            "extern_crate_declaration" => {
                let mut fact = Fact::new("extern_crate", node, source, entities);
                visibility(&mut fact, node, source);
                fact.add("name", node.child_by_field_name("name"), source);
                fact.add("alias", node.child_by_field_name("alias"), source);
                output.push(fact);
            }
            "mod_item" => {
                let mut fact = Fact::new(
                    if node.child_by_field_name("body").is_some() {
                        "module_inline"
                    } else {
                        "module_external"
                    },
                    node,
                    source,
                    entities,
                );
                visibility(&mut fact, node, source);
                fact.add("name", node.child_by_field_name("name"), source);
                output.push(fact);
            }
            _ => {}
        }
    }
    output
}

fn visibility(fact: &mut Fact, node: Node<'_>, source: &str) {
    let mut cursor = node.walk();
    fact.add(
        "visibility",
        node.named_children(&mut cursor)
            .find(|n| n.kind() == "visibility_modifier"),
        source,
    );
}
