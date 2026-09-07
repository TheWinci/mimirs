use super::*;

fn reference(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let value = if trimmed.len() >= 2
        && ((trimmed.starts_with('\'') && trimmed.ends_with('\''))
            || (trimmed.starts_with('"') && trimmed.ends_with('"')))
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    let value = value.trim();
    let lower = value.to_lowercase();
    let variable = lower.match_indices("var").any(|(index, _)| {
        let boundary = index == 0
            || !lower[..index]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_');
        boundary && lower[index + 3..].trim_start().starts_with('(')
    });
    (!value.is_empty()
        && !value.starts_with('#')
        && !variable
        && !["blob:", "data:", "javascript:"]
            .iter()
            .any(|p| lower.starts_with(p))
        && !["{{", "}}", "${", "#{"].iter().any(|p| value.contains(p)))
    .then(|| value.to_owned())
}

fn arguments<'a>(context: &Context<'_>, node: Node<'a>, names: &[&str]) -> Vec<Node<'a>> {
    if !children(node)
        .into_iter()
        .find(|n| n.kind() == "function_name")
        .is_some_and(|n| {
            names
                .iter()
                .any(|name| context.text(n).eq_ignore_ascii_case(name))
        })
    {
        return Vec::new();
    }
    children(node)
        .into_iter()
        .find(|n| n.kind() == "arguments")
        .map_or_else(Vec::new, children)
}

fn url<'a>(context: &Context<'_>, node: Node<'a>) -> Option<(String, Node<'a>)> {
    let args = arguments(context, node, &["url"]);
    if args.len() != 1 || !matches!(args[0].kind(), "plain_value" | "string_value") {
        return None;
    }
    reference(context.text(args[0])).map(|value| (value, args[0]))
}

pub(super) fn extract(context: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for node in walk(root) {
        if node.kind() == "import_statement" {
            let value = children(node)
                .into_iter()
                .find_map(|child| match child.kind() {
                    "string_value" => reference(context.text(child)).map(|value| (value, child)),
                    "call_expression" => url(context, child),
                    _ => None,
                });
            if let Some((value, evidence)) = value {
                facts.push(context.import(value, "stylesheet", evidence, context.owner(node)));
            }
        } else if node.kind() == "call_expression" {
            let mut ancestor = node.parent();
            let mut excluded = false;
            while let Some(node) = ancestor {
                excluded |= matches!(node.kind(), "import_statement" | "namespace_statement");
                ancestor = node.parent();
            }
            if excluded {
                continue;
            }
            if let Some((value, evidence)) = url(context, node) {
                facts.push(context.import(value, "asset:url", evidence, context.owner(node)));
            }
            for child in arguments(context, node, &["image-set", "-webkit-image-set"])
                .into_iter()
                .filter(|n| n.kind() == "string_value")
            {
                if let Some(value) = reference(context.text(child)) {
                    facts.push(context.import(
                        value,
                        "asset:image-set",
                        child,
                        context.owner(node),
                    ));
                }
            }
        }
    }
    facts
}
