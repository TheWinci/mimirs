use super::*;

fn string(context: &Context<'_>, node: Node<'_>) -> Option<String> {
    if node.kind() != "string" {
        return None;
    }
    let text = context.text(node);
    if text.len() >= 2
        && ((text.starts_with('"') && text.ends_with('"'))
            || (text.starts_with('\'') && text.ends_with('\'')))
    {
        return Some(text[1..text.len() - 1].into());
    }
    let rest = text.strip_prefix('[')?;
    let equals = rest.find('[')?;
    if !rest[..equals].bytes().all(|c| c == b'=') {
        return None;
    }
    text[equals + 2..]
        .strip_suffix(&format!("]{}]", "=".repeat(equals)))
        .map(str::to_owned)
}

fn loader(context: &Context<'_>, node: Node<'_>) -> Option<(String, &'static str)> {
    if node.kind() != "function_call" {
        return None;
    }
    let name = context.text(node.child_by_field_name("name")?);
    let imported = match name {
        "require" => "*",
        "dofile" => "dofile",
        "loadfile" => "loadfile",
        _ => return None,
    };
    let args = children(node.child_by_field_name("arguments")?);
    (args.len() == 1)
        .then(|| string(context, args[0]))
        .flatten()
        .map(|source| (source, imported))
}

fn assignment(node: Node<'_>) -> Option<Node<'_>> {
    if node.kind() == "variable_declaration" {
        named(node, "assignment_statement")
    } else {
        Some(node)
    }
}

fn assigned_names(context: &Context<'_>, node: Node<'_>) -> Vec<String> {
    assignment(node)
        .and_then(|n| named(n, "variable_list"))
        .map_or_else(Vec::new, |n| {
            children(n)
                .into_iter()
                .map(|n| context.text(n).into())
                .collect()
        })
}

fn assigned_value<'a>(context: &Context<'_>, node: Node<'a>, name: &str) -> Option<Node<'a>> {
    let index = assigned_names(context, node)
        .iter()
        .position(|n| n == name)?;
    assignment(node)
        .and_then(|n| named(n, "expression_list"))?
        .named_child(index as u32)
}

fn local(context: &Context<'_>, node: Node<'_>) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "assignment_statement" {
            let index = children(named(parent, "expression_list")?)
                .iter()
                .position(|n| *n == node)?;
            return assigned_names(context, parent).get(index).cloned();
        }
        if matches!(
            parent.kind(),
            "block" | "chunk" | "function_definition" | "function_declaration"
        ) {
            break;
        }
        current = parent.parent();
    }
    None
}

fn declaration(context: &Context<'_>, node: Node<'_>, name: &str) -> Option<Resolved> {
    if node.kind() == "function_declaration"
        && node
            .child_by_field_name("name")
            .is_some_and(|n| context.text(n) == name)
    {
        return Some(
            context
                .declared(node, name, &["function", "method"])
                .map_or(Resolved::LOCAL, Resolved::target),
        );
    }
    if matches!(node.kind(), "variable_declaration" | "assignment_statement")
        && assigned_names(context, node).iter().any(|n| n == name)
    {
        let value = assigned_value(context, node, name);
        if value.is_some_and(|value| loader(context, value).is_some_and(|(_, kind)| kind == "*")) {
            return Some(Resolved::IMPORT);
        }
        if value.is_some_and(|value| value.kind() == "function_definition")
            && let Some(target) = context.declared(node, name, &["function", "method"])
        {
            return Some(Resolved::target(target));
        }
        return Some(Resolved::LOCAL);
    }
    None
}

fn expression_root<'a>(context: &'a Context<'_>, node: Node<'_>) -> Option<&'a str> {
    match node.kind() {
        "identifier" => Some(context.text(node)),
        "dot_index_expression" | "method_index_expression" => node
            .child_by_field_name("table")
            .and_then(|n| expression_root(context, n)),
        "function_call" => node
            .child_by_field_name("name")
            .and_then(|n| expression_root(context, n)),
        "parenthesized_expression" => node
            .named_child(0)
            .and_then(|n| expression_root(context, n)),
        _ => None,
    }
}

fn scoped(context: &Context<'_>, scope: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    children(scope)
        .into_iter()
        .filter(|n| n.end_byte() <= call.start_byte())
        .filter_map(|n| declaration(context, n, name))
        .next_back()
}

fn recursive(context: &Context<'_>, function: Node<'_>, name: &str) -> Option<Resolved> {
    let mut current = function.parent();
    while let Some(node) = current {
        match node.kind() {
            "block" | "chunk" => return None,
            "field" => {
                return node
                    .child_by_field_name("name")
                    .filter(|n| context.text(*n) == name)
                    .map(|_| {
                        context
                            .declared(node, name, &["function", "method"])
                            .map_or(Resolved::LOCAL, Resolved::target)
                    });
            }
            "assignment_statement" => return declaration(context, node, name),
            _ => current = node.parent(),
        }
    }
    None
}

fn resolve(context: &Context<'_>, call: Node<'_>, callee: &str, root: Option<&str>) -> Resolved {
    let mut current = call.parent();
    while let Some(scope) = current {
        let name = root.unwrap_or(callee);
        let body = scope
            .child_by_field_name("body")
            .or_else(|| named(scope, "block"));
        if scope.kind() == "for_statement" && body.is_some_and(|n| encloses(n, call)) {
            let clause = scope
                .child_by_field_name("clause")
                .or_else(|| named(scope, "for_numeric_clause"))
                .or_else(|| named(scope, "for_generic_clause"));
            if let Some(clause) = clause {
                if clause.kind() == "for_numeric_clause"
                    && clause
                        .child_by_field_name("name")
                        .is_some_and(|n| context.text(n) == name)
                {
                    return Resolved::LOCAL;
                }
                if clause.kind() == "for_generic_clause"
                    && named(clause, "variable_list").is_some_and(|n| {
                        n.children_by_field_name("name", &mut n.walk())
                            .any(|n| context.text(n) == name)
                    })
                {
                    return Resolved::LOCAL;
                }
            }
        }
        if scope.kind() == "repeat_statement"
            && scope
                .child_by_field_name("condition")
                .is_some_and(|n| encloses(n, call))
            && let Some(binding) = body.and_then(|body| scoped(context, body, call, name))
        {
            return binding;
        }
        if matches!(scope.kind(), "function_declaration" | "function_definition") {
            if scope.kind() == "function_declaration"
                && scope
                    .child_by_field_name("name")
                    .is_some_and(|n| context.text(n) == callee)
                && let Some(target) = context.declared(scope, callee, &["function", "method"])
            {
                return Resolved::target(target);
            }
            if scope.child_by_field_name("parameters").is_some_and(|n| {
                n.children_by_field_name("name", &mut n.walk())
                    .any(|n| Some(context.text(n)) == root)
            }) {
                return Resolved::LOCAL;
            }
            if scope.kind() == "function_declaration"
                && root == Some("self")
                && scope
                    .child_by_field_name("name")
                    .is_some_and(|n| n.kind() == "method_index_expression")
            {
                return Resolved::LOCAL;
            }
            if scope.kind() == "function_definition"
                && let Some(binding) = recursive(context, scope, callee)
            {
                return binding;
            }
        }
        if matches!(scope.kind(), "block" | "chunk") {
            if let Some(binding) = scoped(context, scope, call, callee) {
                return binding;
            }
            if let Some(binding) = root.and_then(|root| scoped(context, scope, call, root)) {
                return binding;
            }
        }
        current = scope.parent();
    }
    Resolved::UNKNOWN
}

pub(super) fn extract(context: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for node in walk(root)
        .into_iter()
        .filter(|n| n.kind() == "function_call")
    {
        let Some(name) = node.child_by_field_name("name") else {
            continue;
        };
        let callee = context.text(name);
        if let Some((source, imported)) = loader(context, node)
            && resolve(context, node, callee, Some(callee)).binding == Binding::Unknown
        {
            let mut fact = context.import(source, imported, node, context.owner(node));
            if let Kind::Import { local: binding, .. } = &mut fact.kind {
                *binding = local(context, node);
            }
            facts.push(fact);
        } else {
            facts.push(context.call(
                callee.into(),
                node,
                resolve(context, node, callee, expression_root(context, name)),
                context.owner(node),
            ));
        }
    }
    facts
}
