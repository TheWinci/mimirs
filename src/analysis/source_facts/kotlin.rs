use super::*;

fn import_entry(c: &Context<'_>, n: Node<'_>) -> Option<(String, String, Option<String>)> {
    let path = named(n, "qualified_identifier")?;
    let mut parts: Vec<_> = children(path)
        .into_iter()
        .filter(|n| n.kind() == "identifier")
        .map(|n| c.text(n))
        .collect();
    if n.children(&mut n.walk()).any(|n| n.kind() == "*") {
        return Some((parts.join("."), "*".into(), None));
    }
    let imported = parts.pop()?;
    let local = named(n, "identifier")
        .map(|n| c.text(n))
        .unwrap_or(imported);
    Some((parts.join("."), imported.into(), Some(local.into())))
}
fn identifiers(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    let Some(n) = n else { return false };
    match n.kind() {
        "identifier" => c.text(n) == name,
        "parameter" | "class_parameter" | "variable_declaration" => {
            named(n, "identifier").is_some_and(|n| c.text(n) == name)
        }
        "function_value_parameters"
        | "class_parameters"
        | "lambda_parameters"
        | "multi_variable_declaration" => children(n)
            .into_iter()
            .any(|n| identifiers(c, Some(n), name)),
        _ => false,
    }
}
fn variable(n: Node<'_>) -> Option<Node<'_>> {
    children(n).into_iter().find(|n| {
        matches!(
            n.kind(),
            "variable_declaration" | "multi_variable_declaration"
        )
    })
}
fn type_node(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "class_declaration" | "object_declaration" | "companion_object" | "type_alias"
    )
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    let kinds: &[&str] = if n.kind() == "property_declaration" && identifiers(c, variable(n), name)
    {
        &["function"]
    } else if n.kind() == "function_declaration"
        && n.child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name)
    {
        &["function", "method"]
    } else if type_node(n)
        && n.child_by_field_name("name")
            .map(|n| c.text(n))
            .or_else(|| (n.kind() == "companion_object").then_some("(companion)"))
            == Some(name)
    {
        &[
            "class",
            "interface",
            "enum",
            "record",
            "annotation_type",
            "type",
        ]
    } else {
        return (n.kind() == "import"
            && import_entry(c, n).is_some_and(|(_, _, local)| local.as_deref() == Some(name)))
        .then_some(Resolved::IMPORT);
    };
    Some(
        c.declared(n, name, kinds)
            .map(Resolved::target)
            .unwrap_or(Resolved::LOCAL),
    )
}
fn callee_node(n: Node<'_>) -> Option<Node<'_>> {
    children(n).into_iter().find(|n| {
        !matches!(
            n.kind(),
            "value_arguments" | "type_arguments" | "annotated_lambda"
        )
    })
}
fn expression_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "this_expression" | "super_expression" => Some(c.text(n)),
        "navigation_expression" | "parenthesized_expression" => {
            n.named_child(0).and_then(|n| expression_root(c, n))
        }
        "call_expression" => callee_node(n).and_then(|n| expression_root(c, n)),
        "user_type" => named(n, "identifier").map(|n| c.text(n)),
        _ => None,
    }
}
fn contains(n: Option<Node<'_>>, call: Node<'_>) -> bool {
    n.is_some_and(|n| encloses(n, call))
}
fn control(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> bool {
    match n.kind() {
        "for_statement" => {
            identifiers(c, variable(n), name) && contains(children(n).last().copied(), call)
        }
        "catch_block" => {
            named(n, "identifier").is_some_and(|n| c.text(n) == name)
                && contains(named(n, "block"), call)
        }
        "when_expression" => {
            identifiers(
                c,
                named(n, "when_subject").and_then(|n| named(n, "variable_declaration")),
                name,
            ) && children(n)
                .into_iter()
                .any(|n| n.kind() == "when_entry" && encloses(n, call))
        }
        _ => false,
    }
}
fn scope(
    c: &Context<'_>,
    n: Node<'_>,
    call: Node<'_>,
    name: &str,
    future: bool,
) -> Option<Resolved> {
    let mut candidates = children(n)
        .into_iter()
        .filter(|n| {
            future
                || type_node(*n)
                || n.kind() == "function_declaration"
                || n.end_byte() <= call.start_byte()
        })
        .filter_map(|n| declaration(c, n, name));
    match (candidates.next(), candidates.next()) {
        (Some(b), None) => Some(b),
        (Some(_), Some(_)) => Some(Resolved::LOCAL),
        _ => None,
    }
}
fn resolve(c: &Context<'_>, call: Node<'_>, name: &str) -> Resolved {
    if matches!(name, "this" | "super") {
        return Resolved::LOCAL;
    }
    let mut parent = call.parent();
    while let Some(n) = parent {
        if control(c, n, call, name) {
            return Resolved::LOCAL;
        }
        let parameter = match n.kind() {
            "function_declaration" | "secondary_constructor" | "anonymous_function" => {
                identifiers(c, named(n, "function_value_parameters"), name)
            }
            "lambda_literal" => identifiers(c, named(n, "lambda_parameters"), name),
            "setter" => named(n, "identifier").map(|n| c.text(n)).unwrap_or("value") == name,
            "class_declaration" => identifiers(
                c,
                named(n, "primary_constructor").and_then(|n| named(n, "class_parameters")),
                name,
            ),
            _ => false,
        };
        if parameter {
            return Resolved::LOCAL;
        }
        if matches!(
            n.kind(),
            "block" | "lambda_literal" | "source_file" | "class_body" | "enum_class_body"
        ) && let Some(b) = scope(
            c,
            n,
            call,
            name,
            matches!(n.kind(), "class_body" | "enum_class_body"),
        ) {
            return b;
        }
        parent = n.parent();
    }
    Resolved::UNKNOWN
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if n.kind() == "import" {
            if let Some((source, imported, alias)) = import_entry(c, n) {
                let mut fact = c.import(source, &imported, n, c.owner(n));
                if let Kind::Import { local, .. } = &mut fact.kind {
                    *local = alias;
                }
                facts.push(fact);
            }
            continue;
        }
        if !matches!(
            n.kind(),
            "call_expression" | "constructor_invocation" | "constructor_delegation_call"
        ) {
            continue;
        }
        if n.kind() == "call_expression"
            && callee_node(n).is_some_and(|n| n.kind() == "call_expression")
        {
            continue;
        }
        let mut parent = n.parent();
        let mut annotation = false;
        while let Some(n) = parent {
            if n.kind() == "annotation" {
                annotation = true;
                break;
            }
            parent = n.parent();
        }
        if annotation {
            continue;
        }
        let (callee, name) = match n.kind() {
            "call_expression" => {
                let Some(callee) = callee_node(n) else {
                    continue;
                };
                let text = named(n, "type_arguments")
                    .map(|args| &c.source[n.start_byte()..args.end_byte()])
                    .unwrap_or_else(|| c.text(callee));
                (text, expression_root(c, callee))
            }
            "constructor_invocation" => {
                let Some(t) = named(n, "user_type") else {
                    continue;
                };
                (c.text(t), expression_root(c, t))
            }
            _ => {
                let Some(t) = n
                    .children(&mut n.walk())
                    .find(|n| matches!(n.kind(), "this" | "super"))
                else {
                    continue;
                };
                (c.text(t), Some(c.text(t)))
            }
        };
        facts.push(
            c.call(
                callee.into(),
                n,
                name.map(|name| resolve(c, n, name))
                    .unwrap_or(Resolved::UNKNOWN),
                c.owner(n),
            ),
        );
    }
    facts
}
