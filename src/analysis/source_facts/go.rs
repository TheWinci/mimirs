use super::*;

fn contains(node: Option<Node<'_>>, call: Node<'_>) -> bool {
    node.is_some_and(|n| encloses(n, call))
}
fn assigned(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    n.is_some_and(|n| match n.kind() {
        "identifier" => c.text(n) == name,
        "expression_list" => children(n).into_iter().any(|n| assigned(c, Some(n), name)),
        _ => false,
    })
}
fn parameters(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    let Some(n) = n else { return false };
    match n.kind() {
        "parameter_list" => children(n)
            .into_iter()
            .any(|n| parameters(c, Some(n), name)),
        "parameter_declaration" | "variadic_parameter_declaration" => {
            children(n).into_iter().any(|child| {
                child.kind() == "identifier"
                    && c.text(child) == name
                    && n.child_by_field_name("type")
                        .is_none_or(|t| child.end_byte() <= t.start_byte())
            })
        }
        _ => false,
    }
}
fn named_field(c: &Context<'_>, n: Node<'_>, field: &str, name: &str) -> bool {
    n.children_by_field_name(field, &mut n.walk())
        .any(|n| c.text(n) == name)
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    let target = |node, kinds| {
        Some(
            c.declared(node, name, kinds)
                .map(Resolved::target)
                .unwrap_or(Resolved::LOCAL),
        )
    };
    match n.kind() {
        "import_declaration" => walk(n)
            .into_iter()
            .filter(|n| n.kind() == "import_spec")
            .any(|n| {
                n.child_by_field_name("name")
                    .is_some_and(|n| n.kind() == "package_identifier" && c.text(n) == name)
            })
            .then_some(Resolved::IMPORT),
        "function_declaration" => {
            if named_field(c, n, "name", name) {
                target(n, &["function"])
            } else {
                None
            }
        }
        "type_declaration" => walk(n)
            .into_iter()
            .find(|n| n.kind() == "type_spec" && named_field(c, *n, "name", name))
            .and_then(|n| target(n, &["type", "struct", "interface"])),
        "short_var_declaration" => {
            if assigned(c, n.child_by_field_name("left"), name) {
                target(n, &["function"])
            } else {
                None
            }
        }
        "assignment_statement" => {
            assigned(c, n.child_by_field_name("left"), name).then_some(Resolved::LOCAL)
        }
        "var_declaration" | "const_declaration" => {
            let kind = if n.kind() == "var_declaration" {
                "var_spec"
            } else {
                "const_spec"
            };
            walk(n)
                .into_iter()
                .find(|n| n.kind() == kind && named_field(c, *n, "name", name))
                .and_then(|n| target(n, &["function"]))
        }
        _ => None,
    }
}
fn initializer(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    n.child_by_field_name("initializer")
        .filter(|n| !encloses(*n, call))
        .and_then(|n| declaration(c, n, name))
}
fn control(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    match n.kind() {
        "if_statement" | "for_clause" | "expression_switch_statement" => {
            initializer(c, n, call, name)
        }
        "for_statement" if contains(n.child_by_field_name("body"), call) => {
            let clause = children(n)
                .into_iter()
                .find(|n| matches!(n.kind(), "for_clause" | "range_clause"))?;
            if clause.kind() == "for_clause" {
                initializer(c, clause, call, name)
            } else {
                assigned(c, clause.child_by_field_name("left"), name).then_some(Resolved::LOCAL)
            }
        }
        "type_switch_statement" => {
            if let Some(b) = initializer(c, n, call, name) {
                return Some(b);
            }
            let case = children(n)
                .into_iter()
                .find(|n| matches!(n.kind(), "type_case" | "default_case") && encloses(*n, call))?;
            (children(case)
                .into_iter()
                .any(|n| n.kind() == "statement_list" && encloses(n, call))
                && assigned(c, n.child_by_field_name("alias"), name))
            .then_some(Resolved::LOCAL)
        }
        "communication_case" => {
            let communication = n.child_by_field_name("communication")?;
            (contains(named(n, "statement_list"), call)
                && communication.kind() == "receive_statement"
                && assigned(c, communication.child_by_field_name("left"), name))
            .then_some(Resolved::LOCAL)
        }
        _ => None,
    }
}
fn callee_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "type_identifier" => Some(c.text(n)),
        "selector_expression" => n
            .child_by_field_name("operand")
            .and_then(|n| callee_root(c, n)),
        "index_expression" | "parenthesized_expression" | "unary_expression" => {
            n.named_child(0).and_then(|n| callee_root(c, n))
        }
        "generic_type" => n
            .child_by_field_name("type")
            .and_then(|n| callee_root(c, n)),
        _ => None,
    }
}
fn resolve(c: &Context<'_>, call: Node<'_>, callee: Node<'_>) -> Resolved {
    let Some(name) = callee_root(c, callee) else {
        return Resolved::UNKNOWN;
    };
    let mut current = call.parent();
    while let Some(n) = current {
        if let Some(b) = control(c, n, call, name) {
            return b;
        }
        if n.kind() == "statement_list"
            && let Some(b) = children(n)
                .into_iter()
                .take_while(|n| n.end_byte() <= call.start_byte())
                .filter_map(|n| declaration(c, n, name))
                .last()
        {
            return b;
        }
        if matches!(
            n.kind(),
            "function_declaration" | "method_declaration" | "func_literal"
        ) {
            if ["receiver", "parameters", "result"]
                .iter()
                .any(|field| parameters(c, n.child_by_field_name(field), name))
            {
                return Resolved::LOCAL;
            }
            if n.child_by_field_name("type_parameters").is_some_and(|n| {
                walk(n).into_iter().any(|n| {
                    n.kind() == "type_parameter_declaration"
                        && n.children_by_field_name("name", &mut n.walk())
                            .any(|n| n.kind() == "identifier" && c.text(n) == name)
                })
            }) {
                return Resolved::LOCAL;
            }
            if n.kind() == "method_declaration"
                && n.child_by_field_name("receiver").is_some_and(|n| {
                    walk(n)
                        .into_iter()
                        .filter(|n| n.kind() == "type_arguments")
                        .any(|n| {
                            walk(n)
                                .into_iter()
                                .any(|n| n.kind() == "type_identifier" && c.text(n) == name)
                        })
                })
            {
                return Resolved::LOCAL;
            }
        }
        if n.kind() == "source_file"
            && let Some(b) = children(n)
                .into_iter()
                .find_map(|n| declaration(c, n, name))
        {
            return b;
        }
        current = n.parent();
    }
    Resolved::UNKNOWN
}
fn receiver_type<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "type_identifier" => Some(c.text(n)),
        "generic_type" => n
            .child_by_field_name("type")
            .and_then(|n| receiver_type(c, n)),
        "pointer_type" | "parenthesized_type" => n.named_child(0).and_then(|n| receiver_type(c, n)),
        _ => None,
    }
}
fn refine(c: &Context<'_>, root: Node<'_>, callee: Node<'_>, binding: Resolved) -> Resolved {
    if callee.kind() != "selector_expression"
        || !binding
            .target
            .as_ref()
            .is_some_and(|t| matches!(t.kind.as_str(), "type" | "struct" | "interface"))
    {
        return binding;
    }
    let Some(name) = callee_root(c, callee) else {
        return Resolved::LOCAL;
    };
    let Some(member) = callee.child_by_field_name("field").map(|n| c.text(n)) else {
        return Resolved::LOCAL;
    };
    let mut targets = children(root)
        .into_iter()
        .filter(|n| n.kind() == "method_declaration" && named_field(c, *n, "name", member))
        .filter(|n| {
            n.child_by_field_name("receiver")
                .and_then(|n| {
                    walk(n)
                        .into_iter()
                        .find(|n| n.kind() == "parameter_declaration")
                })
                .and_then(|n| n.child_by_field_name("type"))
                .and_then(|n| receiver_type(c, n))
                == Some(name)
        })
        .filter_map(|n| c.declared(n, member, &["method"]));
    match (targets.next(), targets.next()) {
        (Some(target), None) => Resolved::target(target),
        _ => Resolved::LOCAL,
    }
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if n.kind() == "import_declaration" {
            for spec in walk(n).into_iter().filter(|n| n.kind() == "import_spec") {
                let Some(path) = spec.child_by_field_name("path").map(|n| c.text(n)) else {
                    continue;
                };
                let Some(source) = path
                    .strip_prefix('"')
                    .and_then(|s| s.strip_suffix('"'))
                    .or_else(|| path.strip_prefix('`').and_then(|s| s.strip_suffix('`')))
                else {
                    continue;
                };
                let alias = spec.child_by_field_name("name");
                let mut fact = c.import(source.into(), "*", spec, c.owner(n));
                if let Kind::Import {
                    imported, local, ..
                } = &mut fact.kind
                {
                    if alias.is_some_and(|n| n.kind() == "blank_identifier") {
                        *imported = None;
                    }
                    *local = alias.map(|n| c.text(n).into());
                }
                facts.push(fact);
            }
        } else if matches!(n.kind(), "call_expression" | "type_conversion_expression")
            && let Some(callee) = n.child_by_field_name(if n.kind() == "call_expression" {
                "function"
            } else {
                "type"
            })
        {
            facts.push(c.call(
                c.text(callee).into(),
                n,
                refine(c, root, callee, resolve(c, n, callee)),
                c.owner(n),
            ));
        }
    }
    facts
}
