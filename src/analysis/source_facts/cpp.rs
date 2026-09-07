use super::*;

#[derive(PartialEq, Eq)]
enum Category {
    Definition,
    Prototype,
    Macro,
    Value,
    Type,
    Import,
}
struct Candidate {
    binding: Resolved,
    category: Category,
}
fn using_namespace(c: &Context<'_>, n: Node<'_>) -> bool {
    c.text(n)
        .strip_prefix("using")
        .filter(|s| s.starts_with(char::is_whitespace))
        .map(str::trim_start)
        .and_then(|s| s.strip_prefix("namespace"))
        .is_some_and(|s| {
            s.chars()
                .next()
                .is_none_or(|ch| !(ch.is_ascii_alphanumeric() || ch == '_'))
        })
}
fn import(c: &Context<'_>, n: Node<'_>) -> Option<Fact> {
    let alias_name = (n.kind() == "namespace_alias_definition")
        .then(|| n.child_by_field_name("name"))
        .flatten()
        .map(|n| c.text(n));
    let owner = c.owner_where(n, |chunk| {
        alias_name.is_none() || chunk.kind != "module" || chunk.name.as_deref() != alias_name
    });
    let (source, imported, local) = match n.kind() {
        "preproc_include" => {
            let source = c.text(n.child_by_field_name("path")?);
            if source.is_empty() {
                return None;
            }
            (source.to_owned(), None, None)
        }
        "namespace_alias_definition" => {
            let local = c.text(n.child_by_field_name("name")?);
            let source = c.text(children(n).into_iter().find(|n| c.text(*n) != local)?);
            if source.is_empty() || local.is_empty() {
                return None;
            }
            (source.into(), Some("*".into()), Some(local.into()))
        }
        "using_declaration" => {
            let target = c.text(children(n).last().copied()?);
            if target.is_empty() {
                return None;
            }
            if using_namespace(c, n) {
                (target.into(), Some("*".into()), None)
            } else {
                let mut parts: Vec<_> = target.split("::").collect();
                let imported = parts.pop()?.to_owned();
                (parts.join("::"), Some(imported.clone()), Some(imported))
            }
        }
        _ => return None,
    };
    Some(Fact {
        kind: Kind::Import {
            source,
            imported,
            local,
            type_only: false,
            is_static: false,
            global: false,
        },
        owner,
        location: Location::from_span(&c.lines.span(n.start_byte(), n.end_byte())),
    })
}
fn declarator_name<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    if matches!(
        n.kind(),
        "identifier"
            | "type_identifier"
            | "field_identifier"
            | "qualified_identifier"
            | "destructor_name"
            | "operator_name"
            | "template_function"
    ) {
        return Some(c.text(n));
    }
    if let Some(d) = n.child_by_field_name("declarator") {
        return declarator_name(c, d);
    }
    if matches!(
        n.kind(),
        "parenthesized_declarator" | "reference_declarator" | "abstract_reference_declarator"
    ) {
        return n.named_child(0).and_then(|n| declarator_name(c, n));
    }
    None
}
fn declarator_binds(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    n.is_some_and(|n| {
        if n.kind() == "structured_binding_declarator" {
            children(n)
                .into_iter()
                .any(|n| declarator_binds(c, Some(n), name))
        } else {
            declarator_name(c, n) == Some(name)
        }
    })
}
fn is_function(n: Node<'_>) -> bool {
    let mut current = Some(n);
    let mut last = "";
    while let Some(n) = current {
        if matches!(
            n.kind(),
            "function_declarator" | "pointer_declarator" | "array_declarator"
        ) {
            last = n.kind();
        }
        current = if matches!(
            n.kind(),
            "parenthesized_declarator" | "reference_declarator"
        ) {
            n.named_child(0)
        } else {
            n.child_by_field_name("declarator")
        };
    }
    last == "function_declarator"
}
fn direct(n: Node<'_>) -> Vec<Node<'_>> {
    if n.kind() == "function_definition" {
        n.child_by_field_name("declarator").into_iter().collect()
    } else {
        n.children_by_field_name("declarator", &mut n.walk())
            .collect()
    }
}
fn template(n: Node<'_>) -> Option<Node<'_>> {
    children(n)
        .into_iter()
        .find(|n| n.kind() != "template_parameter_list")
}
fn declared_name(c: &Context<'_>, n: Node<'_>) -> Option<String> {
    if n.kind() == "template_declaration" {
        let d = template(n)?;
        return d
            .child_by_field_name("name")
            .map(|n| c.text(n))
            .or_else(|| direct(d).into_iter().find_map(|n| declarator_name(c, n)))
            .map(str::to_owned);
    }
    if matches!(
        n.kind(),
        "namespace_definition" | "namespace_alias_definition"
    ) {
        return Some(
            n.child_by_field_name("name")
                .map(|n| c.text(n))
                .unwrap_or("(anonymous)")
                .into(),
        );
    }
    if matches!(
        n.kind(),
        "alias_declaration" | "preproc_def" | "preproc_function_def"
    ) {
        return n.child_by_field_name("name").map(|n| c.text(n).into());
    }
    let names: Vec<_> = direct(n)
        .into_iter()
        .filter_map(|n| declarator_name(c, n))
        .collect();
    if names.is_empty() {
        n.child_by_field_name("name").map(|n| c.text(n).into())
    } else {
        Some(names.join(", "))
    }
}
fn parameter(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    let parameters = if n.kind() == "lambda_expression" {
        n.child_by_field_name("declarator")
            .and_then(|n| n.child_by_field_name("parameters"))
    } else {
        let mut current = n.child_by_field_name("declarator");
        while let Some(n) = current {
            if n.kind() == "function_declarator" {
                break;
            }
            current = if n.kind() == "parenthesized_declarator" {
                n.named_child(0)
            } else {
                n.child_by_field_name("declarator")
                    .or_else(|| n.named_child(0))
            };
        }
        current.and_then(|n| n.child_by_field_name("parameters"))
    };
    parameters.is_some_and(|n| {
        children(n).into_iter().any(|n| {
            n.kind() == "parameter_declaration"
                && n.child_by_field_name("declarator")
                    .and_then(|n| declarator_name(c, n))
                    == Some(name)
        })
    })
}
fn type_node(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "class_specifier"
            | "struct_specifier"
            | "union_specifier"
            | "enum_specifier"
            | "alias_declaration"
            | "type_definition"
            | "namespace_definition"
    )
}
fn using_binding(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    if n.kind() == "namespace_alias_definition" {
        return n
            .child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name);
    }
    n.kind() == "using_declaration"
        && !using_namespace(c, n)
        && children(n)
            .last()
            .is_some_and(|n| c.text(*n).rsplit("::").next() == Some(name))
}
fn value(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Candidate> {
    let candidate = |category, kinds| Candidate {
        category,
        binding: c
            .declared(n, name, kinds)
            .map(Resolved::target)
            .unwrap_or(Resolved::LOCAL),
    };
    if matches!(n.kind(), "declaration" | "field_declaration") {
        let d = direct(n)
            .into_iter()
            .find(|n| declarator_binds(c, Some(*n), name))?;
        return Some(if is_function(d) {
            candidate(Category::Prototype, &["function", "method", "macro"])
        } else {
            candidate(Category::Value, &["function"])
        });
    }
    if n.kind() == "expression_statement" {
        let expression = n
            .named_child(0)
            .filter(|n| n.kind() == "assignment_expression")?;
        return expression
            .child_by_field_name("left")
            .is_some_and(|n| n.kind() == "identifier" && c.text(n) == name)
            .then_some(Candidate {
                category: Category::Value,
                binding: Resolved::LOCAL,
            });
    }
    if n.kind() == "function_definition"
        || (n.kind() == "template_declaration"
            && template(n).is_some_and(|n| n.kind() == "function_definition"))
    {
        return (declared_name(c, n).as_deref() == Some(name))
            .then(|| candidate(Category::Definition, &["function", "method", "macro"]));
    }
    if matches!(n.kind(), "preproc_def" | "preproc_function_def") {
        return n
            .child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name)
            .then(|| candidate(Category::Macro, &["function", "method", "macro"]));
    }
    if using_binding(c, n, name) {
        return Some(Candidate {
            category: Category::Import,
            binding: Resolved::IMPORT,
        });
    }
    if (type_node(n)
        || (n.kind() == "template_declaration"
            && template(n).is_some_and(|n| n.kind() != "function_definition")))
        && declared_name(c, n).as_deref() == Some(name)
    {
        return Some(candidate(
            Category::Type,
            &["class", "struct", "enum", "type", "module"],
        ));
    }
    None
}
fn expression_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "field_identifier" | "type_identifier" | "namespace_identifier" | "this" => {
            Some(c.text(n))
        }
        "qualified_identifier" => n
            .child_by_field_name("scope")
            .and_then(|n| expression_root(c, n)),
        "template_function" => n.child_by_field_name("name").map(|n| c.text(n)),
        "field_expression" | "pointer_expression" | "subscript_expression" => n
            .child_by_field_name("argument")
            .and_then(|n| expression_root(c, n)),
        "parenthesized_expression" => n.named_child(0).and_then(|n| expression_root(c, n)),
        _ => None,
    }
}
fn contains(n: Option<Node<'_>>, call: Node<'_>) -> bool {
    n.is_some_and(|n| encloses(n, call))
}
fn nested(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    std::iter::once(n)
        .chain(children(n))
        .find_map(|n| value(c, n, name))
        .map(|c| c.binding)
}
fn control(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    if n.kind() == "for_statement" {
        return n
            .child_by_field_name("initializer")
            .filter(|n| n.end_byte() <= call.start_byte())
            .and_then(|n| nested(c, n, name));
    }
    if n.kind() == "for_range_loop"
        && contains(n.child_by_field_name("body"), call)
        && declarator_binds(c, n.child_by_field_name("declarator"), name)
    {
        return Some(Resolved::LOCAL);
    }
    if matches!(
        n.kind(),
        "if_statement" | "switch_statement" | "while_statement"
    ) && let Some(condition) = n.child_by_field_name("condition")
    {
        for field in ["initializer", "value"] {
            if let Some(b) = condition
                .child_by_field_name(field)
                .filter(|n| n.end_byte() <= call.start_byte())
                .and_then(|n| nested(c, n, name))
            {
                return Some(b);
            }
        }
    }
    if n.kind() == "catch_clause"
        && contains(n.child_by_field_name("body"), call)
        && n.child_by_field_name("parameters").is_some_and(|n| {
            children(n)
                .into_iter()
                .any(|n| declarator_binds(c, n.child_by_field_name("declarator"), name))
        })
    {
        return Some(Resolved::LOCAL);
    }
    None
}
fn call_owner(c: &Context<'_>, call: Node<'_>) -> Option<ChunkRef> {
    let owner = c.owner(call)?;
    if owner.kind != "variable" {
        return Some(owner);
    }
    let mut parent = call.parent();
    while let Some(n) = parent {
        if matches!(n.kind(), "declaration" | "field_declaration") {
            return Some(owner);
        }
        if n.kind() == "function_definition" {
            break;
        }
        parent = n.parent();
    }
    c.owner_where(call, |chunk| {
        chunk.kind != owner.kind
            || chunk.name.as_deref() != Some(owner.name.as_str())
            || chunk.span.start != owner.location.start_offset
            || chunk.span.end != owner.location.end_offset
    })
}
fn visible(n: Node<'_>, call: Node<'_>) -> bool {
    if n.end_byte() <= call.start_byte() {
        return true;
    }
    if matches!(
        n.kind(),
        "function_definition" | "class_specifier" | "struct_specifier" | "union_specifier"
    ) {
        return contains(n.child_by_field_name("body"), call);
    }
    n.kind() == "template_declaration"
        && template(n).is_some_and(|n| {
            n.kind() == "function_definition" && contains(n.child_by_field_name("body"), call)
        })
}
fn active(c: &Context<'_>, scope: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    let mut candidates: Vec<Candidate> = Vec::new();
    for n in children(scope).into_iter().filter(|n| visible(*n, call)) {
        if n.kind() == "preproc_call"
            && n.child_by_field_name("directive")
                .is_some_and(|n| c.text(n) == "#undef")
            && n.child_by_field_name("argument")
                .is_some_and(|n| c.text(n).trim() == name)
        {
            candidates.retain(|c| c.category != Category::Macro);
            continue;
        }
        candidates.extend(value(c, n, name));
    }
    for category in [Category::Macro, Category::Value] {
        if let Some(c) = candidates.iter().rev().find(|c| c.category == category) {
            return Some(c.binding.clone());
        }
    }
    for category in [Category::Definition, Category::Prototype] {
        let mut matches = candidates.iter().filter(|c| c.category == category);
        match (matches.next(), matches.next()) {
            (Some(c), None) => return Some(c.binding.clone()),
            (Some(_), Some(_)) => return Some(Resolved::LOCAL),
            _ => {}
        }
    }
    candidates.pop().map(|c| c.binding)
}
fn member(c: &Context<'_>, body: Node<'_>, name: &str) -> Option<Resolved> {
    let candidates: Vec<_> = children(body)
        .into_iter()
        .filter_map(|n| value(c, n, name))
        .collect();
    let mut callables = candidates
        .iter()
        .filter(|c| matches!(c.category, Category::Definition | Category::Prototype));
    match (callables.next(), callables.next()) {
        (Some(c), None) => return Some(c.binding.clone()),
        (Some(_), Some(_)) => return Some(Resolved::LOCAL),
        _ => {}
    }
    candidates
        .into_iter()
        .find(|c| c.category == Category::Value)
        .map(|c| c.binding)
}
fn resolve(c: &Context<'_>, call: Node<'_>, name: &str, value_call: bool) -> Resolved {
    if value_call && name == "this" {
        return Resolved::LOCAL;
    }
    let mut parent = call.parent();
    while let Some(n) = parent {
        if let Some(b) = control(c, n, call, name) {
            return b;
        }
        if matches!(n.kind(), "function_definition" | "lambda_expression") && parameter(c, n, name)
        {
            return Resolved::LOCAL;
        }
        let binding = match n.kind() {
            "compound_statement" => children(n)
                .into_iter()
                .rev()
                .filter(|n| n.end_byte() <= call.start_byte())
                .find_map(|n| value(c, n, name))
                .map(|c| c.binding),
            "field_declaration_list" => member(c, n, name),
            "translation_unit" | "declaration_list" | "preproc_if" | "preproc_ifdef"
            | "preproc_elif" | "preproc_else" => active(c, n, call, name),
            _ => None,
        };
        if let Some(b) = binding {
            return b;
        }
        parent = if matches!(n.kind(), "preproc_else" | "preproc_elif") {
            n.parent().and_then(|n| n.parent()).or_else(|| n.parent())
        } else {
            n.parent()
        };
    }
    Resolved::UNKNOWN
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if matches!(
            n.kind(),
            "preproc_include" | "using_declaration" | "namespace_alias_definition"
        ) {
            facts.extend(import(c, n));
            continue;
        }
        if !matches!(n.kind(), "call_expression" | "new_expression") {
            continue;
        }
        let Some(callee) = n.child_by_field_name(if n.kind() == "call_expression" {
            "function"
        } else {
            "type"
        }) else {
            continue;
        };
        let text = c.text(callee);
        if text.is_empty() {
            continue;
        }
        let root = expression_root(c, callee).filter(|s| !s.is_empty());
        let binding = if n.kind() == "call_expression"
            && matches!(
                callee.kind(),
                "identifier" | "field_identifier" | "template_function"
            ) {
            let binding = resolve(c, n, text, false);
            if binding.binding == Binding::Unknown {
                root.filter(|name| *name != text)
                    .map(|name| resolve(c, n, name, false))
                    .unwrap_or(binding)
            } else {
                binding
            }
        } else {
            root.map(|name| resolve(c, n, name, true))
                .unwrap_or(Resolved::UNKNOWN)
        };
        facts.push(c.call(text.into(), n, binding, call_owner(c, n)));
    }
    facts
}
