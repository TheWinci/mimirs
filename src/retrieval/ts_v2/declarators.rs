//! C declarators name the binding beneath pointer, array and function wrappers.
use super::text;
use tree_sitter::Node;

fn declarators(node: Node<'_>) -> Vec<Node<'_>> {
    node.children_by_field_name("declarator", &mut node.walk())
        .collect()
}

fn name<'a>(node: Node<'_>, source: &'a str) -> Option<&'a str> {
    if matches!(
        node.kind(),
        "identifier" | "type_identifier" | "field_identifier"
    ) {
        return Some(text(node, source));
    }
    node.child_by_field_name("declarator")
        .or_else(|| {
            (node.kind() == "parenthesized_declarator")
                .then(|| node.named_child(0))
                .flatten()
        })
        .and_then(|child| name(child, source))
}

fn is_function(mut node: Node<'_>) -> bool {
    let mut innermost = "";
    loop {
        if matches!(
            node.kind(),
            "function_declarator" | "pointer_declarator" | "array_declarator"
        ) {
            innermost = node.kind();
        }
        let next = if node.kind() == "parenthesized_declarator" {
            node.named_child(0)
        } else {
            node.child_by_field_name("declarator")
        };
        let Some(next) = next else {
            break;
        };
        node = next;
    }
    innermost == "function_declarator"
}

pub(super) fn declared_name(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "preproc_ifdef" => {
            let name = text(node.child_by_field_name("name")?, source);
            let negative = node
                .children(&mut node.walk())
                .any(|n| n.kind() == "#ifndef");
            return Some(format!(
                "{}defined({name})",
                if negative { "!" } else { "" }
            ));
        }
        "preproc_else" => return Some("else".into()),
        "preproc_call" => {
            let parts: Vec<_> = ["directive", "argument"]
                .iter()
                .filter_map(|field| node.child_by_field_name(field))
                .map(|n| text(n, source).trim())
                .filter(|s| !s.is_empty())
                .collect();
            return (!parts.is_empty()).then(|| parts.join(" "));
        }
        _ => {}
    }
    let names: Vec<_> = declarators(node)
        .into_iter()
        .filter_map(|n| name(n, source))
        .collect();
    (!names.is_empty()).then(|| names.join(", "))
}

pub(super) fn kind(node: Node<'_>, source: &str) -> &'static str {
    let bindings = declarators(node);
    if !bindings.is_empty() && bindings.iter().all(|&n| is_function(n)) {
        return "function";
    }
    if node
        .named_children(&mut node.walk())
        .any(|n| n.kind() == "type_qualifier" && text(n, source) == "const")
    {
        return "constant";
    }
    "variable"
}
