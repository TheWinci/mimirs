use super::*;

fn variable<'a>(context: &'a Context<'_>, node: Node<'_>) -> Option<&'a str> {
    if node.kind() == "variable_name" {
        return Some(context.text(node));
    }
    node.child_by_field_name("name")
        .or_else(|| {
            children(node)
                .into_iter()
                .find(|n| n.kind() == "variable_name")
        })
        .map(|n| context.text(n))
}

fn declaration(
    context: &Context<'_>,
    node: Node<'_>,
    name: &str,
    variables: bool,
) -> Option<Resolved> {
    if node.kind() == "function_definition"
        && node
            .child_by_field_name("name")
            .is_some_and(|n| context.text(n) == name)
    {
        return Some(
            context
                .declared(node, name, &["function"])
                .map_or(Resolved::LOCAL, Resolved::target),
        );
    }
    if variables
        && ((node.kind() == "variable_assignment" && variable(context, node) == Some(name))
            || (node.kind() == "declaration_command"
                && children(node).into_iter().any(|n| {
                    matches!(n.kind(), "variable_assignment" | "variable_name")
                        && variable(context, n) == Some(name)
                })))
    {
        return Some(Resolved::LOCAL);
    }
    None
}

fn body(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("body")
        .or_else(|| children(node).into_iter().find(|n| n.kind() == "do_group"))
}

fn loop_variable(context: &Context<'_>, node: Node<'_>, name: &str) -> bool {
    node.kind() == "for_statement"
        && node
            .child_by_field_name("variable")
            .is_some_and(|n| context.text(n) == name)
}

fn recursive_variable(context: &Context<'_>, scope: Node<'_>, call: Node<'_>, name: &str) -> bool {
    let mut stack = children(scope);
    while let Some(node) = stack.pop() {
        if matches!(
            node.kind(),
            "function_definition"
                | "subshell"
                | "command_substitution"
                | "process_substitution"
                | "pipeline"
        ) {
            continue;
        }
        if node.end_byte() <= call.start_byte() {
            if node.kind() == "variable_assignment"
                && node
                    .parent()
                    .is_none_or(|p| !matches!(p.kind(), "command" | "declaration_command"))
                && variable(context, node) == Some(name)
            {
                return true;
            }
            if node.kind() == "declaration_command"
                && declaration(context, node, name, true).is_some()
            {
                return true;
            }
        }
        if loop_variable(context, node, name)
            && body(node).map_or(node.end_byte(), |n| n.start_byte()) <= call.start_byte()
        {
            return true;
        }
        stack.extend(children(node));
    }
    false
}

fn resolve(context: &Context<'_>, call: Node<'_>, name: &str, variables: bool) -> Resolved {
    let mut current = call.parent();
    while let Some(scope) = current {
        if variables
            && loop_variable(context, scope, name)
            && body(scope).is_some_and(|body| encloses(body, call))
        {
            return Resolved::LOCAL;
        }
        if scope.kind() == "function_definition"
            && scope
                .child_by_field_name("name")
                .is_some_and(|n| context.text(n) == name)
            && let Some(target) = context.declared(scope, name, &["function"])
        {
            return Resolved::target(target);
        }
        if matches!(
            scope.kind(),
            "program"
                | "compound_statement"
                | "do_group"
                | "subshell"
                | "command_substitution"
                | "if_statement"
        ) {
            let binding = children(scope)
                .into_iter()
                .filter(|n| n.end_byte() <= call.start_byte())
                .filter_map(|child| {
                    if variables && loop_variable(context, child, name) {
                        Some(Resolved::LOCAL)
                    } else {
                        declaration(context, child, name, variables)
                    }
                })
                .next_back();
            if let Some(binding) = binding {
                return binding;
            }
            if variables && recursive_variable(context, scope, call, name) {
                return Resolved::LOCAL;
            }
        }
        current = scope.parent();
    }
    Resolved::UNKNOWN
}

fn literal(context: &Context<'_>, node: Node<'_>) -> Option<String> {
    let value = context.text(node);
    match node.kind() {
        "word" if node.named_child_count() == 0 => Some(value.into()),
        "raw_string" => value
            .get(1..value.len().saturating_sub(1))
            .map(str::to_owned),
        "string" if children(node).iter().all(|n| n.kind() == "string_content") => value
            .get(1..value.len().saturating_sub(1))
            .map(str::to_owned),
        _ => None,
    }
}

pub(super) fn extract(context: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for node in walk(root).into_iter().filter(|n| n.kind() == "command") {
        let Some(name) = node.child_by_field_name("name") else {
            continue;
        };
        let callee = context.text(name);
        if matches!(callee, "source" | ".")
            && resolve(context, node, callee, false).binding == Binding::Unknown
            && let Some(source) = children(node)
                .into_iter()
                .find(|child| *child != name && child.kind() != "variable_assignment")
                .and_then(|n| literal(context, n))
        {
            facts.push(context.import(source, callee, node, context.owner(node)));
            continue;
        }
        let expanded = walk(name).into_iter().find(|n| n.kind() == "variable_name");
        let root = expanded.map(|n| context.text(n)).or_else(|| {
            (name.named_child_count() == 1
                && name.named_child(0).is_some_and(|n| n.kind() == "word"))
            .then_some(callee)
        });
        let binding = root.map_or(Resolved::UNKNOWN, |root| {
            resolve(context, node, root, expanded.is_some())
        });
        facts.push(context.call(callee.into(), node, binding, context.owner(node)));
    }
    facts
}
