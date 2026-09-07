use super::*;
use std::collections::HashSet;

fn using(c: &Context<'_>, n: Node<'_>) -> Option<(String, Option<String>, bool, bool)> {
    let local = n.child_by_field_name("name");
    let source = c.text(children(n).into_iter().rfind(|n| Some(*n) != local)?);
    if source.is_empty() {
        return None;
    }
    Some((
        source.into(),
        local.map(|n| c.text(n).into()),
        n.children(&mut n.walk()).any(|n| n.kind() == "static"),
        n.children(&mut n.walk()).any(|n| n.kind() == "global"),
    ))
}
fn parameter(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    n.is_some_and(|n| match n.kind() {
        "implicit_parameter" => c.text(n) == name,
        "parameter" => n
            .child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name),
        "parameter_list" => children(n).into_iter().any(|n| parameter(c, Some(n), name)),
        _ => false,
    })
}
fn binding_names(c: &Context<'_>, n: Option<Node<'_>>) -> Vec<String> {
    let Some(n) = n else { return Vec::new() };
    if n.kind() == "identifier" {
        return vec![c.text(n).into()];
    }
    if n.kind() == "tuple_pattern" {
        return children(n)
            .into_iter()
            .flat_map(|n| binding_names(c, Some(n)))
            .collect();
    }
    let names: Vec<_> = n
        .children_by_field_name("name", &mut n.walk())
        .flat_map(|n| binding_names(c, Some(n)))
        .collect();
    if !names.is_empty() {
        return names;
    }
    if n.kind() == "variable_declarator" {
        return binding_names(c, named(n, "tuple_pattern"));
    }
    Vec::new()
}
fn binds(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    binding_names(c, n).iter().any(|s| s == name)
}
fn type_node(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "class_declaration"
            | "interface_declaration"
            | "struct_declaration"
            | "record_declaration"
            | "enum_declaration"
            | "delegate_declaration"
    )
}
fn callable(n: Node<'_>) -> bool {
    matches!(n.kind(), "method_declaration" | "local_function_statement")
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    if matches!(
        n.kind(),
        "local_declaration_statement"
            | "variable_declaration"
            | "field_declaration"
            | "event_field_declaration"
    ) {
        let d = if n.kind() == "variable_declaration" {
            n
        } else {
            named(n, "variable_declaration")?
        };
        let variable = children(d)
            .into_iter()
            .find(|n| n.kind() == "variable_declarator" && binds(c, Some(*n), name))?;
        return Some(
            c.declared(variable, name, &["function"])
                .map(Resolved::target)
                .unwrap_or(Resolved::LOCAL),
        );
    }
    if (callable(n) || type_node(n))
        && n.child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name)
    {
        return Some(
            c.declared(
                n,
                name,
                if callable(n) {
                    &["function", "method"]
                } else {
                    &["class", "interface", "struct", "record", "enum", "delegate"]
                },
            )
            .map(Resolved::target)
            .unwrap_or(Resolved::LOCAL),
        );
    }
    if n.kind() == "using_directive"
        && using(c, n).is_some_and(|(_, local, _, _)| local.as_deref() == Some(name))
    {
        return Some(Resolved::IMPORT);
    }
    (n.kind() == "extern_alias_directive"
        && n.child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name))
    .then_some(Resolved::LOCAL)
}
fn expression_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "this" | "base" => Some(c.text(n)),
        "generic_name" => n
            .child_by_field_name("name")
            .or_else(|| n.named_child(0))
            .map(|n| c.text(n)),
        "conditional_access_expression" => n
            .child_by_field_name("condition")
            .or_else(|| n.named_child(0))
            .and_then(|n| expression_root(c, n)),
        "member_access_expression"
        | "postfix_unary_expression"
        | "element_access_expression"
        | "parenthesized_expression"
        | "alias_qualified_name"
        | "qualified_name" => n.named_child(0).and_then(|n| expression_root(c, n)),
        _ => None,
    }
}
fn contains(n: Option<Node<'_>>, call: Node<'_>) -> bool {
    n.is_some_and(|n| encloses(n, call))
}
fn descendant_binds(c: &Context<'_>, n: Option<Node<'_>>, kind: &str, name: &str) -> bool {
    n.is_some_and(|n| {
        walk(n)
            .into_iter()
            .skip(1)
            .any(|n| n.kind() == kind && binds(c, Some(n), name))
    })
}
fn query_name<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    if n.kind() == "from_clause" {
        n.child_by_field_name("name").map(|n| c.text(n))
    } else if matches!(n.kind(), "join_clause" | "join_into_clause" | "let_clause") {
        named(n, "identifier").map(|n| c.text(n))
    } else {
        None
    }
}
fn query_binding(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> bool {
    let mut active = HashSet::new();
    for child in children(n) {
        if child.kind() == "identifier" {
            if child.end_byte() <= call.start_byte() {
                active.clear();
                active.insert(c.text(child));
            }
            continue;
        }
        if encloses(child, call) {
            if child.kind() == "join_clause" {
                let into = named(child, "join_into_clause");
                let right = children(child).into_iter().rfind(|n| Some(*n) != into);
                if query_name(c, child) == Some(name) && contains(right, call) {
                    return true;
                }
            }
            return active.contains(name);
        }
        if child.end_byte() > call.start_byte() {
            break;
        }
        let binding = if child.kind() == "join_clause" {
            query_name(c, named(child, "join_into_clause").unwrap_or(child))
        } else {
            query_name(c, child)
        };
        if let Some(binding) = binding.filter(|s| !s.is_empty()) {
            active.insert(binding);
        }
    }
    active.contains(name)
}
fn control(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    if n.kind() == "for_statement"
        && let Some(b) = n
            .child_by_field_name("initializer")
            .filter(|n| n.end_byte() <= call.start_byte())
            .and_then(|n| declaration(c, n, name))
    {
        return Some(b);
    }
    if matches!(n.kind(), "using_statement" | "fixed_statement")
        && contains(n.child_by_field_name("body"), call)
        && let Some(b) = named(n, "variable_declaration").and_then(|n| declaration(c, n, name))
    {
        return Some(b);
    }
    let bound = match n.kind() {
        "foreach_statement" => {
            contains(n.child_by_field_name("body"), call)
                && binds(c, n.child_by_field_name("left"), name)
        }
        "catch_clause" => {
            binds(c, named(n, "catch_declaration"), name)
                && (contains(named(n, "catch_filter_clause"), call)
                    || contains(n.child_by_field_name("body"), call))
        }
        "if_statement" | "while_statement" => {
            (descendant_binds(
                c,
                n.child_by_field_name("condition"),
                "declaration_pattern",
                name,
            ) || descendant_binds(
                c,
                n.child_by_field_name("condition"),
                "declaration_expression",
                name,
            )) && contains(
                n.child_by_field_name(if n.kind() == "if_statement" {
                    "consequence"
                } else {
                    "body"
                }),
                call,
            )
        }
        "switch_section" => descendant_binds(c, Some(n), "declaration_pattern", name),
        "query_expression" => query_binding(c, n, call, name),
        _ => false,
    };
    bound.then_some(Resolved::LOCAL)
}
fn resolve(c: &Context<'_>, call: Node<'_>, name: &str) -> Resolved {
    if matches!(name, "this" | "base") {
        return Resolved::LOCAL;
    }
    let mut parent = call.parent();
    while let Some(n) = parent {
        if let Some(b) = control(c, n, call, name) {
            return b;
        }
        if matches!(
            n.kind(),
            "method_declaration"
                | "constructor_declaration"
                | "local_function_statement"
                | "operator_declaration"
                | "conversion_operator_declaration"
                | "lambda_expression"
        ) && parameter(
            c,
            n.child_by_field_name("parameters").or_else(|| {
                children(n)
                    .into_iter()
                    .find(|n| matches!(n.kind(), "parameter_list" | "implicit_parameter"))
            }),
            name,
        ) {
            return Resolved::LOCAL;
        }
        if type_node(n) && parameter(c, named(n, "parameter_list"), name) {
            return Resolved::LOCAL;
        }
        if matches!(
            n.kind(),
            "block"
                | "declaration_list"
                | "enum_member_declaration_list"
                | "compilation_unit"
                | "namespace_declaration"
                | "file_scoped_namespace_declaration"
        ) {
            let mut candidates = Vec::new();
            for child in children(n) {
                if !(callable(child) || type_node(child)) && child.end_byte() > call.start_byte() {
                    continue;
                }
                candidates.extend(declaration(c, child, name));
                if child.end_byte() <= call.start_byte()
                    && descendant_binds(c, Some(child), "declaration_expression", name)
                {
                    candidates.push(Resolved::LOCAL);
                }
            }
            if candidates.len() == 1 {
                return candidates.remove(0);
            }
            if candidates.len() > 1 {
                return Resolved::LOCAL;
            }
        }
        parent = n.parent();
    }
    Resolved::UNKNOWN
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if n.kind() == "using_directive" {
            if let Some((source, local, is_static, global)) = using(c, n) {
                let owner = c.owner_where(n, |chunk| {
                    local.is_none() || chunk.kind != "import" || chunk.name != local
                });
                let mut fact = c.import(source, "*", n, owner);
                if let Kind::Import {
                    local: alias,
                    is_static: static_flag,
                    global: global_flag,
                    ..
                } = &mut fact.kind
                {
                    *alias = local;
                    *static_flag = is_static;
                    *global_flag = global;
                }
                facts.push(fact);
            }
            continue;
        }
        let (callee, binding) = match n.kind() {
            "invocation_expression" | "object_creation_expression" => {
                let Some(callee) = n
                    .child_by_field_name(if n.kind() == "invocation_expression" {
                        "function"
                    } else {
                        "type"
                    })
                    .or_else(|| n.named_child(0))
                else {
                    continue;
                };
                (
                    c.text(callee),
                    expression_root(c, callee)
                        .filter(|s| !s.is_empty())
                        .map(|name| resolve(c, n, name))
                        .unwrap_or(Resolved::UNKNOWN),
                )
            }
            "implicit_object_creation_expression" => {
                let t = n
                    .parent()
                    .and_then(|n| n.parent())
                    .filter(|n| n.kind() == "variable_declaration")
                    .and_then(|n| n.child_by_field_name("type"));
                (
                    t.map(|n| c.text(n)).unwrap_or("new"),
                    t.and_then(|n| expression_root(c, n))
                        .filter(|s| !s.is_empty())
                        .map(|name| resolve(c, n, name))
                        .unwrap_or(Resolved::UNKNOWN),
                )
            }
            "constructor_initializer" => {
                let Some(callee) = n
                    .children(&mut n.walk())
                    .find(|n| matches!(n.kind(), "this" | "base"))
                else {
                    continue;
                };
                (c.text(callee), Resolved::LOCAL)
            }
            _ => continue,
        };
        if !callee.is_empty() {
            facts.push(c.call(callee.into(), n, binding, c.owner(n)));
        }
    }
    facts
}
