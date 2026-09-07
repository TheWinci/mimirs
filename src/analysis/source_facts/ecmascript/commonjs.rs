use super::*;

fn function(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "function_declaration"
            | "function_expression"
            | "generator_function_declaration"
            | "generator_function"
            | "arrow_function"
            | "method_definition"
    )
}
fn literal(c: &Context<'_>, n: Node<'_>) -> Option<String> {
    (n.kind() == "string" && c.text(n).len() >= 2).then(|| c.text(n)[1..c.text(n).len() - 1].into())
}
fn declaration_binds(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    match n.kind() {
        "export_statement" => children(n)
            .into_iter()
            .any(|n| declaration_binds(c, n, name)),
        "import_statement" => import_binds(c, n, name, true),
        "function_declaration" | "generator_function_declaration" | "class_declaration" => n
            .child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name),
        "lexical_declaration" | "variable_declaration" | "using_declaration" => {
            walk(n).into_iter().any(|n| {
                n.kind() == "variable_declarator"
                    && binding(c, n.child_by_field_name("name"), name, true)
            })
        }
        _ => false,
    }
}
fn scope_walk(n: Node<'_>) -> Vec<Node<'_>> {
    let body = if n.kind() == "program" {
        Some(n)
    } else {
        n.child_by_field_name("body")
    };
    let mut stack: Vec<_> = body
        .map(children)
        .unwrap_or_default()
        .into_iter()
        .rev()
        .collect();
    let mut result = Vec::new();
    while let Some(n) = stack.pop() {
        if function(n) || n.kind() == "class_declaration" {
            continue;
        }
        result.push(n);
        stack.extend(children(n).into_iter().rev());
    }
    result
}
fn hoisted(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    scope_walk(n).into_iter().any(|n| {
        n.kind() == "variable_declaration"
            && walk(n).into_iter().any(|n| {
                n.kind() == "variable_declarator"
                    && binding(c, n.child_by_field_name("name"), name, true)
            })
    })
}
fn scope_binds(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    if function(n)
        && ((n.kind() != "method_definition"
            && n.child_by_field_name("name")
                .is_some_and(|n| c.text(n) == name))
            || binding(c, n.child_by_field_name("parameters"), name, true)
            || hoisted(c, n, name))
    {
        return true;
    }
    if n.kind() == "catch_clause" && binding(c, n.child_by_field_name("parameter"), name, true) {
        return true;
    }
    if matches!(n.kind(), "for_statement" | "for_in_statement")
        && n.child_by_field_name("initializer")
            .or_else(|| n.child_by_field_name("left"))
            .is_some_and(|n| declaration_binds(c, n, name))
    {
        return true;
    }
    matches!(n.kind(), "program" | "statement_block")
        && (children(n)
            .into_iter()
            .any(|n| declaration_binds(c, n, name))
            || (n.kind() == "program" && hoisted(c, n, name)))
}
fn available(c: &Context<'_>, node: Node<'_>, name: &str) -> bool {
    let mut parent = Some(node);
    while let Some(n) = parent {
        if scope_binds(c, n, name) {
            return false;
        }
        if (n.kind() == "program" || function(n))
            && scope_walk(n).into_iter().any(|n| {
                n.start_byte() < node.start_byte()
                    && n.kind() == "assignment_expression"
                    && n.child_by_field_name("left")
                        .is_some_and(|n| n.kind() == "identifier" && c.text(n) == name)
            })
        {
            return false;
        }
        parent = n.parent();
    }
    true
}
pub(super) fn require_source(c: &Context<'_>, n: Node<'_>) -> Option<String> {
    if n.kind() != "call_expression"
        || !n
            .child_by_field_name("function")
            .is_some_and(|n| n.kind() == "identifier" && c.text(n) == "require")
        || !available(c, n, "require")
    {
        return None;
    }
    let args = n.child_by_field_name("arguments")?;
    if args.named_child_count() != 1 {
        return None;
    }
    literal(c, args.named_child(0)?)
}
fn member(n: Node<'_>) -> bool {
    matches!(n.kind(), "member_expression" | "subscript_expression")
}
fn property(c: &Context<'_>, n: Node<'_>) -> Option<String> {
    if matches!(
        n.kind(),
        "property_identifier"
            | "shorthand_property_identifier"
            | "shorthand_property_identifier_pattern"
    ) {
        return Some(c.text(n).into());
    }
    if n.kind() == "computed_property_name" && n.named_child_count() == 1 {
        return literal(c, n.named_child(0)?);
    }
    literal(c, n)
}
fn selected(c: &Context<'_>, n: Node<'_>) -> Option<String> {
    n.child_by_field_name(if n.kind() == "member_expression" {
        "property"
    } else {
        "index"
    })
    .and_then(|n| property(c, n))
}
pub(super) fn require_binding(c: &Context<'_>, n: Node<'_>) -> Option<(String, String)> {
    if let Some(source) = require_source(c, n) {
        return Some((source, "*".into()));
    }
    if !member(n) {
        return None;
    }
    Some((
        require_source(c, n.child_by_field_name("object")?)?,
        selected(c, n)?,
    ))
}
fn import_bindings<'a>(c: &Context<'_>, n: Node<'a>) -> Vec<(String, String, Node<'a>)> {
    match n.kind() {
        "identifier" => vec![("*".into(), c.text(n).into(), n)],
        "shorthand_property_identifier_pattern" => vec![(c.text(n).into(), c.text(n).into(), n)],
        "pair_pattern" => {
            let (Some(key), Some(value)) =
                (n.child_by_field_name("key"), n.child_by_field_name("value"))
            else {
                return Vec::new();
            };
            import_bindings(c, value)
                .into_iter()
                .map(|(_, local, _)| (c.text(key).into(), local, n))
                .collect()
        }
        "assignment_pattern" => n
            .child_by_field_name("left")
            .map(|n| import_bindings(c, n))
            .unwrap_or_default(),
        _ => children(n)
            .into_iter()
            .flat_map(|n| import_bindings(c, n))
            .collect(),
    }
}
fn require_facts(c: &Context<'_>, n: Node<'_>, source: &str) -> Vec<Fact> {
    let selected = n
        .parent()
        .filter(|p| member(*p) && p.child_by_field_name("object") == Some(n))
        .and_then(|p| selected(c, p).map(|name| (p, name)));
    let expression = selected.as_ref().map(|(n, _)| *n).unwrap_or(n);
    let pattern = expression
        .parent()
        .filter(|p| {
            p.kind() == "variable_declarator" && p.child_by_field_name("value") == Some(expression)
        })
        .and_then(|p| p.child_by_field_name("name"));
    let bindings = if let (Some((_, imported)), Some(p)) =
        (&selected, pattern.filter(|n| n.kind() == "identifier"))
    {
        vec![(imported.clone(), c.text(p).into(), p)]
    } else {
        pattern.map(|n| import_bindings(c, n)).unwrap_or_default()
    };
    if bindings.is_empty() {
        return vec![import(c, source, None, None, false, n, c.owner(n))];
    }
    bindings
        .into_iter()
        .map(|(imported, local, evidence)| {
            import(
                c,
                source,
                Some(imported),
                Some(local),
                false,
                evidence,
                c.owner(n),
            )
        })
        .collect()
}
fn module_exports(c: &Context<'_>, n: Node<'_>) -> bool {
    member(n)
        && n.child_by_field_name("object")
            .is_some_and(|n| n.kind() == "identifier" && c.text(n) == "module")
        && selected(c, n).as_deref() == Some("exports")
}
fn export_value(c: &Context<'_>, node: Option<Node<'_>>) -> (Option<String>, Option<String>) {
    let Some(n) = node else { return (None, None) };
    if n.kind() == "identifier" {
        return (Some(c.text(n).into()), None);
    }
    if n.kind() == "assignment_expression" {
        return export_value(c, n.child_by_field_name("right"));
    }
    if let Some(source) = require_source(c, n) {
        return (Some("default".into()), Some(source));
    }
    if member(n)
        && let Some((source, imported)) = require_binding(c, n)
    {
        return (Some(imported), Some(source));
    }
    (None, None)
}
fn export_facts(c: &Context<'_>, n: Node<'_>) -> Vec<Fact> {
    if n.kind() != "assignment_expression" {
        return Vec::new();
    }
    let Some(left) = n.child_by_field_name("left") else {
        return Vec::new();
    };
    let right = n.child_by_field_name("right");
    let make = |evidence, exported, (local, source)| {
        export(c, evidence, exported, local, source, false, c.owner(n))
    };
    if module_exports(c, left) {
        if !available(c, n, "module") {
            return Vec::new();
        }
        if let Some(object) = right.filter(|n| n.kind() == "object") {
            return children(object)
                .into_iter()
                .filter_map(|n| match n.kind() {
                    "shorthand_property_identifier" => {
                        Some(make(n, c.text(n).into(), (Some(c.text(n).into()), None)))
                    }
                    "pair" => {
                        let exported = property(c, n.child_by_field_name("key")?)?;
                        (!exported.is_empty()).then(|| {
                            make(n, exported, export_value(c, n.child_by_field_name("value")))
                        })
                    }
                    "method_definition" => {
                        let name = n.child_by_field_name("name")?;
                        let exported = property(c, name)?;
                        (!exported.is_empty()).then(|| make(name, exported, (None, None)))
                    }
                    _ => None,
                })
                .collect();
        }
        let value = export_value(c, right);
        let mut result = Vec::new();
        if value.1.is_some() && value.0.as_deref() == Some("default") {
            result.push(make(left, "*".into(), (None, value.1.clone())));
        }
        result.push(make(left, "default".into(), value));
        return result;
    }
    if !member(left) {
        return Vec::new();
    }
    let Some(exported) = selected(c, left).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let Some(object) = left.child_by_field_name("object") else {
        return Vec::new();
    };
    if (object.kind() == "identifier" && c.text(object) == "exports" && available(c, n, "exports"))
        || (module_exports(c, object) && available(c, n, "module"))
    {
        return vec![make(left, exported, export_value(c, right))];
    }
    Vec::new()
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if let Some(source) = require_source(c, n) {
            facts.extend(require_facts(c, n, &source));
        }
        facts.extend(export_facts(c, n));
    }
    facts
}
