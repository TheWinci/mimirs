use super::*;

fn builtin<'a>(context: &'a Context<'_>, node: Node<'_>) -> Option<&'a str> {
    named(node, "builtin_identifier").map(|n| context.text(n))
}
fn arguments(node: Node<'_>) -> Vec<Node<'_>> {
    named(node, "arguments").map_or_else(Vec::new, children)
}
fn string(context: &Context<'_>, node: Node<'_>) -> Option<String> {
    (node.kind() == "string").then(|| {
        context
            .text(node)
            .get(1..context.text(node).len().saturating_sub(1))
            .unwrap_or("")
            .to_owned()
    })
}
fn name<'a>(context: &'a Context<'_>, node: Node<'_>) -> Option<&'a str> {
    named(node, "identifier").map(|n| context.text(n))
}

fn declaration(context: &Context<'_>, node: Node<'_>, binding: &str) -> Option<Resolved> {
    if node.kind() == "function_declaration"
        && node
            .child_by_field_name("name")
            .is_some_and(|n| context.text(n) == binding)
    {
        return Some(
            context
                .declared(node, binding, &["function", "method"])
                .map_or(Resolved::LOCAL, Resolved::target),
        );
    }
    if node.kind() == "variable_declaration" && name(context, node) == Some(binding) {
        let imported = children(node)
            .into_iter()
            .filter(|n| n.kind() == "builtin_function")
            .any(|n| {
                builtin(context, n) == Some("@cImport")
                    || (builtin(context, n) == Some("@import")
                        && arguments(n)
                            .first()
                            .is_some_and(|&arg| string(context, arg).is_some()))
            });
        return Some(if imported {
            Resolved::IMPORT
        } else {
            Resolved::LOCAL
        });
    }
    None
}

fn expression_root<'a>(context: &'a Context<'_>, node: Node<'_>) -> Option<&'a str> {
    match node.kind() {
        "identifier" => Some(context.text(node)),
        "field_expression" => node
            .child_by_field_name("object")
            .and_then(|n| expression_root(context, n)),
        "call_expression" => node
            .child_by_field_name("function")
            .and_then(|n| expression_root(context, n)),
        "parenthesized_expression" => node
            .named_child(0)
            .and_then(|n| expression_root(context, n)),
        _ => None,
    }
}

fn resolve(context: &Context<'_>, call: Node<'_>, name: &str) -> Resolved {
    let mut parent = call.parent();
    while let Some(scope) = parent {
        let region = match scope.kind() {
            "if_statement" | "while_statement" | "for_statement" => {
                scope.child_by_field_name("body")
            }
            "else_clause" => scope.child_by_field_name("alternative"),
            "switch_case" | "catch_expression" => children(scope).last().copied(),
            _ => None,
        };
        if region.is_some_and(|n| encloses(n, call))
            && named(scope, "payload").is_some_and(|payload| {
                children(payload)
                    .into_iter()
                    .any(|n| n.kind() == "identifier" && context.text(n) == name)
            })
        {
            return Resolved::LOCAL;
        }
        if scope.kind() == "function_declaration"
            && named(scope, "parameters").is_some_and(|parameters| {
                children(parameters)
                    .into_iter()
                    .filter(|n| n.kind() == "parameter")
                    .any(|n| {
                        n.child_by_field_name("name")
                            .is_some_and(|n| context.text(n) == name)
                    })
            })
        {
            return Resolved::LOCAL;
        }
        if matches!(scope.kind(), "block" | "source_file") {
            let binding = children(scope)
                .into_iter()
                .filter(|n| {
                    n.end_byte() <= call.start_byte()
                        || (n.kind() == "function_declaration"
                            && n.child_by_field_name("body")
                                .is_some_and(|body| encloses(body, call)))
                })
                .filter_map(|n| declaration(context, n, name))
                .next_back();
            if let Some(binding) = binding {
                return binding;
            }
        }
        parent = scope.parent();
    }
    Resolved::UNKNOWN
}

pub(super) fn extract(context: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for node in walk(root)
        .into_iter()
        .filter(|n| matches!(n.kind(), "call_expression" | "builtin_function"))
    {
        let built = builtin(context, node);
        let args = arguments(node);
        if matches!(built, Some("@import" | "@cInclude" | "@embedFile"))
            && args.len() == 1
            && let Some(source) = string(context, args[0])
        {
            let imported = match built {
                Some("@cInclude") => "c-header",
                Some("@embedFile") => "resource",
                _ => "*",
            };
            let mut fact = context.import(source, imported, node, context.owner(node));
            let mut current = node.parent();
            while let Some(parent) = current {
                if parent.kind() == "source_file" {
                    break;
                }
                if parent.kind() == "variable_declaration" {
                    if let Kind::Import { local, .. } = &mut fact.kind {
                        *local = name(context, parent).map(str::to_owned);
                    }
                    break;
                }
                current = parent.parent();
            }
            facts.push(fact);
            continue;
        }
        if built == Some("@cImport") && context.text(node).contains("@cInclude") {
            continue;
        }
        let (callee, root) = if node.kind() == "call_expression" {
            let Some(function) = node.child_by_field_name("function") else {
                continue;
            };
            (context.text(function), expression_root(context, function))
        } else {
            let Some(callee) = built else {
                continue;
            };
            (callee, Some(callee))
        };
        let binding = root
            .filter(|name| !name.starts_with('@'))
            .map_or(Resolved::UNKNOWN, |name| resolve(context, node, name));
        facts.push(context.call(callee.into(), node, binding, context.owner(node)));
    }
    facts
}
