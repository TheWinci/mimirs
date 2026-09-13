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
        "identifier"
            | "type_identifier"
            | "field_identifier"
            | "qualified_identifier"
            | "destructor_name"
            | "operator_name"
            | "template_function"
    ) {
        return Some(text(node, source));
    }
    node.child_by_field_name("declarator")
        .or_else(|| {
            (matches!(
                node.kind(),
                "parenthesized_declarator"
                    | "reference_declarator"
                    | "abstract_reference_declarator"
            ))
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
        "namespace_definition" => {
            return Some(
                node.child_by_field_name("name")
                    .map_or("(anonymous)", |n| text(n, source))
                    .into(),
            );
        }
        "template_declaration" => {
            let declaration = template(node)?;
            return declaration
                .child_by_field_name("name")
                .map(|n| text(n, source).into())
                .or_else(|| {
                    declarators(declaration)
                        .into_iter()
                        .find_map(|n| name(n, source).map(str::to_owned))
                });
        }
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

pub(super) fn kind(node: Node<'_>, source: &str, cpp: bool) -> &'static str {
    let bindings = declarators(node);
    if !bindings.is_empty() && bindings.iter().all(|&n| is_function(n)) {
        return if cpp && node.kind() == "field_declaration" {
            "method"
        } else {
            "function"
        };
    }
    if cpp && node.kind() == "field_declaration" {
        return "field";
    }
    if node.named_children(&mut node.walk()).any(|n| {
        n.kind() == "type_qualifier"
            && (text(n, source) == "const"
                || (cpp && matches!(text(n, source), "constexpr" | "consteval" | "constinit")))
    }) {
        return "constant";
    }
    "variable"
}

pub(super) fn template(node: Node<'_>) -> Option<Node<'_>> {
    node.named_children(&mut node.walk())
        .find(|n| n.kind() != "template_parameter_list")
}

pub(super) fn template_kind(node: Node<'_>) -> &'static str {
    match template(node).map(|n| n.kind()) {
        Some("class_specifier") => "class",
        Some("struct_specifier" | "union_specifier") => "struct",
        Some("enum_specifier") => "enum",
        Some("function_definition") => "function",
        _ => "type",
    }
}

pub(super) fn qualified_method(node: Node<'_>, source: &str) -> bool {
    let qualified = declarators(node).into_iter().find_map(|mut n| {
        loop {
            if n.kind() == "qualified_identifier" {
                return Some(n);
            }
            n = if n.kind() == "parenthesized_declarator" {
                n.named_child(0)?
            } else {
                n.child_by_field_name("declarator")?
            };
        }
    });
    let Some(scope) = qualified
        .and_then(|n| n.child_by_field_name("scope"))
        .map(|n| text(n, source).rsplit("::").next().unwrap())
    else {
        return false;
    };
    let mut root = node;
    while let Some(parent) = root.parent() {
        root = parent;
    }
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        if matches!(n.kind(), "class_specifier" | "struct_specifier")
            && n.child_by_field_name("name")
                .is_some_and(|n| text(n, source) == scope)
        {
            return true;
        }
        stack.extend(n.named_children(&mut n.walk()));
    }
    false
}
