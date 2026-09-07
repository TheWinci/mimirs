use super::*;

struct Entry<'a> {
    source: String,
    kind: &'static str,
    local: String,
    evidence: Node<'a>,
}
fn uses<'a>(c: &Context<'_>, n: Node<'a>) -> Vec<Entry<'a>> {
    let group = n.child_by_field_name("body");
    let prefix = if group.is_some() {
        named(n, "namespace_name").map(|n| c.text(n)).unwrap_or("")
    } else {
        ""
    };
    children(group.unwrap_or(n))
        .into_iter()
        .filter(|n| n.kind() == "namespace_use_clause")
        .filter_map(|clause| {
            let tokens: Vec<_> = n
                .children(&mut n.walk())
                .chain(clause.children(&mut clause.walk()))
                .collect();
            let kind = if tokens.iter().any(|n| n.kind() == "function") {
                "function"
            } else if tokens.iter().any(|n| n.kind() == "const") {
                "const"
            } else {
                "class"
            };
            let alias = clause.child_by_field_name("alias");
            let target = c.text(children(clause).into_iter().find(|n| Some(*n) != alias)?);
            if target.is_empty() {
                return None;
            }
            let source = if prefix.is_empty() {
                target.into()
            } else {
                format!("{prefix}\\{target}")
            };
            let local = alias
                .map(|n| c.text(n))
                .unwrap_or_else(|| source.rsplit('\\').next().unwrap_or(&source))
                .into();
            Some(Entry {
                source,
                kind,
                local,
                evidence: clause,
            })
        })
        .collect()
}
fn runtime(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "require_expression"
            | "require_once_expression"
            | "include_expression"
            | "include_once_expression"
    )
}
fn runtime_import(c: &Context<'_>, n: Node<'_>) -> Option<Fact> {
    let expression = n.named_child(0)?;
    let expression = if expression.kind() == "parenthesized_expression" {
        expression.named_child(0)?
    } else {
        expression
    };
    if !matches!(expression.kind(), "encapsed_string" | "string")
        || children(expression)
            .into_iter()
            .any(|n| n.kind() != "string_content")
    {
        return None;
    }
    let value = c.text(expression);
    let source = if value.len() >= 2 {
        &value[1..value.len() - 1]
    } else {
        ""
    };
    Some(c.import(
        source.into(),
        n.kind().strip_suffix("_expression").unwrap_or(n.kind()),
        n,
        c.owner(n),
    ))
}
fn variables(c: &Context<'_>, n: Option<Node<'_>>, name: &str, assigned: bool) -> bool {
    let Some(n) = n else { return false };
    if n.kind() == "variable_name" {
        return c.text(n) == name;
    }
    if assigned
        && !matches!(
            n.kind(),
            "list_literal" | "array_creation_expression" | "pair" | "by_ref"
        )
    {
        return false;
    }
    if !assigned
        && matches!(
            n.kind(),
            "simple_parameter" | "variadic_parameter" | "property_promotion_parameter"
        )
    {
        return n
            .child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name);
    }
    children(n)
        .into_iter()
        .any(|n| variables(c, Some(n), name, assigned))
}
fn type_node(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "class_declaration" | "interface_declaration" | "trait_declaration" | "enum_declaration"
    )
}
fn target(c: &Context<'_>, n: Node<'_>, name: &str, kinds: &[&str]) -> Resolved {
    c.declared(n, name.strip_prefix('$').unwrap_or(name), kinds)
        .map(Resolved::target)
        .unwrap_or(Resolved::LOCAL)
}
fn assignment(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    variables(c, n.child_by_field_name("left"), name, true)
        .then(|| target(c, n, name, &["function"]))
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    match n.kind() {
        "expression_statement" => {
            named(n, "assignment_expression").and_then(|n| assignment(c, n, name))
        }
        "assignment_expression" => assignment(c, n, name),
        "unset_statement" if variables(c, Some(n), name, false) => Some(Resolved::UNKNOWN),
        "function_definition" | "method_declaration"
            if n.child_by_field_name("name")
                .is_some_and(|n| c.text(n) == name) =>
        {
            Some(target(c, n, name, &["function", "method"]))
        }
        _ if type_node(n)
            && n.child_by_field_name("name")
                .is_some_and(|n| c.text(n) == name) =>
        {
            Some(target(c, n, name, &["class", "interface", "trait", "enum"]))
        }
        "namespace_use_declaration" => uses(c, n)
            .iter()
            .any(|e| e.local == name)
            .then_some(Resolved::IMPORT),
        _ => None,
    }
}
fn expression_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "variable_name" | "name" | "relative_name" => Some(c.text(n)),
        "qualified_name" => c.text(n).split('\\').next(),
        "member_access_expression" => n
            .child_by_field_name("object")
            .and_then(|n| expression_root(c, n)),
        "parenthesized_expression" => n.named_child(0).and_then(|n| expression_root(c, n)),
        _ => None,
    }
}
fn program_children<'a>(program: Node<'a>, call: Node<'_>) -> Vec<Node<'a>> {
    let mut parent = call.parent();
    while let Some(n) = parent {
        if n.kind() == "namespace_definition" && n.child_by_field_name("body").is_some() {
            return Vec::new();
        }
        parent = n.parent();
    }
    let namespaces: Vec<_> = children(program)
        .into_iter()
        .filter(|n| n.kind() == "namespace_definition" && n.child_by_field_name("body").is_none())
        .collect();
    let active = namespaces
        .iter()
        .rev()
        .find(|n| n.start_byte() <= call.start_byte());
    let start = active.map(|n| n.start_byte());
    let end = if let Some(start) = start {
        namespaces
            .iter()
            .find(|n| n.start_byte() > start)
            .map(|n| n.start_byte())
    } else {
        namespaces.first().map(|n| n.start_byte())
    }
    .unwrap_or(program.end_byte());
    children(program)
        .into_iter()
        .filter(|n| start.is_none_or(|start| n.start_byte() >= start) && n.start_byte() < end)
        .collect()
}
fn function_binding(
    c: &Context<'_>,
    body: Node<'_>,
    call: Node<'_>,
    name: &str,
) -> Option<Resolved> {
    let mut stack: Vec<_> = children(body).into_iter().rev().collect();
    let mut events = Vec::new();
    while let Some(n) = stack.pop() {
        if type_node(n)
            || matches!(
                n.kind(),
                "function_definition"
                    | "method_declaration"
                    | "arrow_function"
                    | "anonymous_function"
            )
        {
            continue;
        }
        let event = match n.kind() {
            "assignment_expression" => assignment(c, n, name).map(|b| (n.end_byte(), b)),
            "foreach_statement" => {
                let body = n.child_by_field_name("body");
                children(n)
                    .into_iter()
                    .filter(|child| Some(*child) != body && Some(*child) != n.named_child(0))
                    .any(|n| variables(c, Some(n), name, false))
                    .then(|| {
                        (
                            body.map(|n| n.start_byte()).unwrap_or(n.end_byte()),
                            Resolved::LOCAL,
                        )
                    })
            }
            "catch_clause" if variables(c, n.child_by_field_name("name"), name, false) => Some((
                n.child_by_field_name("body")
                    .map(|n| n.start_byte())
                    .unwrap_or(n.end_byte()),
                Resolved::LOCAL,
            )),
            "global_declaration" | "static_variable_declaration"
                if variables(c, Some(n), name, false) =>
            {
                Some((n.end_byte(), Resolved::LOCAL))
            }
            "unset_statement" if variables(c, Some(n), name, false) => {
                Some((n.end_byte(), Resolved::UNKNOWN))
            }
            _ => None,
        };
        events.extend(event);
        stack.extend(children(n).into_iter().rev());
    }
    events.sort_by_key(|(offset, _)| *offset);
    events
        .into_iter()
        .rfind(|(offset, _)| *offset <= call.start_byte())
        .map(|(_, b)| b)
}
fn resolve(c: &Context<'_>, call: Node<'_>, name: &str) -> Resolved {
    if matches!(name, "$this" | "self" | "static" | "parent") {
        return Resolved::LOCAL;
    }
    let mut parent = call.parent();
    while let Some(n) = parent {
        if matches!(
            n.kind(),
            "function_definition" | "method_declaration" | "arrow_function" | "anonymous_function"
        ) {
            if variables(c, n.child_by_field_name("parameters"), name, false) {
                return Resolved::LOCAL;
            }
            if n.kind() == "anonymous_function" {
                return if variables(c, named(n, "anonymous_function_use_clause"), name, false) {
                    Resolved::LOCAL
                } else {
                    Resolved::UNKNOWN
                };
            }
            if matches!(n.kind(), "function_definition" | "method_declaration")
                && let Some(b) = n
                    .child_by_field_name("body")
                    .and_then(|n| function_binding(c, n, call, name))
            {
                return b;
            }
        }
        if n.kind() == "compound_statement" {
            if let Some(b) = children(n)
                .into_iter()
                .rev()
                .filter(|n| n.end_byte() <= call.start_byte())
                .find_map(|n| declaration(c, n, name))
            {
                return b;
            }
        } else if matches!(
            n.kind(),
            "declaration_list" | "program" | "namespace_definition"
        ) {
            let nodes = if n.kind() == "program" {
                program_children(n, call)
            } else {
                children(n)
            };
            let mut candidates = nodes.into_iter().filter_map(|n| declaration(c, n, name));
            match (candidates.next(), candidates.next()) {
                (Some(b), None) => return b,
                (Some(_), Some(_)) => return Resolved::LOCAL,
                _ => {}
            }
        }
        parent = n.parent();
    }
    Resolved::UNKNOWN
}
fn call(c: &Context<'_>, n: Node<'_>) -> Option<Fact> {
    if n.child_by_field_name("arguments")
        .is_some_and(|n| named(n, "variadic_placeholder").is_some())
    {
        return None;
    }
    let (callee, root) = match n.kind() {
        "function_call_expression" => {
            let f = n.child_by_field_name("function")?;
            (c.text(f).to_owned(), expression_root(c, f))
        }
        "scoped_call_expression" => {
            let scope = n.child_by_field_name("scope")?;
            let name = n.child_by_field_name("name")?;
            (
                format!("{}::{}", c.text(scope), c.text(name)),
                expression_root(c, scope),
            )
        }
        "member_call_expression" | "nullsafe_member_call_expression" => {
            let object = n.child_by_field_name("object")?;
            let name = n.child_by_field_name("name")?;
            (
                format!(
                    "{}{}{}",
                    c.text(object),
                    if n.kind() == "nullsafe_member_call_expression" {
                        "?->"
                    } else {
                        "->"
                    },
                    c.text(name)
                ),
                expression_root(c, object),
            )
        }
        "object_creation_expression" => {
            let t = children(n)
                .into_iter()
                .find(|n| matches!(n.kind(), "name" | "qualified_name" | "relative_name"))?;
            (c.text(t).into(), expression_root(c, t))
        }
        _ if runtime(n) => (
            n.kind()
                .strip_suffix("_expression")
                .unwrap_or(n.kind())
                .into(),
            None,
        ),
        _ => return None,
    };
    if callee.is_empty() {
        return None;
    }
    Some(
        c.call(
            callee,
            n,
            root.filter(|s| !s.is_empty())
                .map(|name| resolve(c, n, name))
                .unwrap_or(Resolved::UNKNOWN),
            c.owner(n),
        ),
    )
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if n.kind() == "namespace_use_declaration" {
            for e in uses(c, n) {
                let mut fact = c.import(e.source, e.kind, e.evidence, c.owner(n));
                if let Kind::Import {
                    local,
                    type_only,
                    is_static,
                    ..
                } = &mut fact.kind
                {
                    *local = Some(e.local);
                    *type_only = e.kind == "const";
                    *is_static = e.kind == "function";
                }
                facts.push(fact);
            }
        } else if runtime(n) {
            facts.extend(runtime_import(c, n).or_else(|| call(c, n)));
        } else {
            facts.extend(call(c, n));
        }
    }
    facts
}
