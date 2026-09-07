use super::*;
use std::collections::HashMap;

fn import(c: &Context<'_>, n: Node<'_>) -> Option<Fact> {
    let mut alias = None;
    let (source, imported) = match n.kind() {
        "open_module" | "include_module" => (
            n.child_by_field_name("module")?,
            if n.kind() == "open_module" {
                "open"
            } else {
                "include"
            },
        ),
        "include_module_type" => {
            let t = n.child_by_field_name("module_type")?;
            (t.child_by_field_name("module").unwrap_or(t), "include")
        }
        "local_open_expression" => (named(n, "module_path")?, "open"),
        "module_definition" => {
            let binding = named(n, "module_binding")?;
            let body = binding
                .child_by_field_name("body")
                .filter(|n| n.kind() == "module_path")?;
            alias = named(binding, "module_name").map(|n| c.text(n).to_owned());
            (body, "module")
        }
        _ => return None,
    };
    if c.text(source).is_empty() {
        return None;
    }
    let owner = if n.kind() == "module_definition" && alias.as_ref().is_some_and(|s| !s.is_empty())
    {
        c.owner_where(n, |chunk| chunk.kind != "module" || chunk.name != alias)
    } else {
        c.owner(n)
    };
    let mut fact = c.import(c.text(source).into(), imported, n, owner);
    if let Kind::Import { local, .. } = &mut fact.kind {
        *local = alias;
    }
    Some(fact)
}
fn pattern(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    n.is_some_and(|n| {
        if matches!(n.kind(), "value_name" | "value_pattern")
            && n.named_child_count() == 0
            && c.text(n) != "_"
        {
            c.text(n) == name
        } else {
            children(n).into_iter().any(|n| pattern(c, Some(n), name))
        }
    })
}
fn recursive(n: Node<'_>) -> bool {
    n.children(&mut n.walk()).any(|n| n.kind() == "rec")
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    if n.kind() == "value_definition" {
        for binding in children(n)
            .into_iter()
            .filter(|n| n.kind() == "let_binding")
        {
            if !pattern(c, binding.child_by_field_name("pattern"), name) {
                continue;
            }
            let callable = named(binding, "parameter").is_some()
                || binding
                    .child_by_field_name("body")
                    .is_some_and(|n| n.kind() == "fun_expression");
            return Some(if callable {
                c.owner(n)
                    .filter(|t| t.kind == "function" && t.name.split(", ").any(|s| s == name))
                    .map(Resolved::target)
                    .unwrap_or(Resolved::LOCAL)
            } else {
                Resolved::LOCAL
            });
        }
    }
    if n.kind() == "external" && n.named_child(0).is_some_and(|n| c.text(n) == name) {
        return Some(
            c.owner(n)
                .filter(|t| t.kind == "function")
                .map(Resolved::target)
                .unwrap_or(Resolved::UNKNOWN),
        );
    }
    if n.kind() == "class_definition"
        && named(n, "class_binding")
            .and_then(|n| named(n, "class_name"))
            .is_some_and(|n| c.text(n) == name)
    {
        return Some(
            c.owner(n)
                .filter(|t| t.kind == "class")
                .map(Resolved::target)
                .unwrap_or(Resolved::UNKNOWN),
        );
    }
    if n.kind() == "module_definition"
        && import(c, n).is_some_and(
            |f| matches!(f.kind, Kind::Import { local: Some(local), .. } if local == name),
        )
    {
        return Some(Resolved::IMPORT);
    }
    None
}
fn lexical(c: &Context<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    let mut parent = call.parent();
    while let Some(n) = parent {
        if matches!(
            n.kind(),
            "let_binding" | "fun_expression" | "method_definition"
        ) && children(n)
            .into_iter()
            .any(|n| n.kind() == "parameter" && pattern(c, n.child_by_field_name("pattern"), name))
        {
            return Some(Resolved::LOCAL);
        }
        if n.kind() == "match_case" && pattern(c, n.child_by_field_name("pattern"), name) {
            return Some(Resolved::LOCAL);
        }
        if n.kind() == "for_expression"
            && n.child_by_field_name("name")
                .is_some_and(|n| c.text(n) == name)
        {
            let mut scope = call.parent();
            while let Some(s) = scope {
                if s.parent() == Some(n) {
                    break;
                }
                scope = s.parent();
            }
            if scope.is_some_and(|n| n.kind() == "do_clause") {
                return Some(Resolved::LOCAL);
            }
        }
        if n.kind() == "let_expression" {
            for d in children(n)
                .into_iter()
                .filter(|n| n.kind() == "value_definition")
            {
                if encloses(d, call) && !recursive(d) {
                    continue;
                }
                if let Some(b) = declaration(c, d, name) {
                    return Some(b);
                }
            }
        }
        if n.kind() == "let_module_expression"
            && let Some(b) = named(n, "module_definition").and_then(|n| declaration(c, n, name))
        {
            return Some(b);
        }
        parent = n.parent();
    }
    None
}
fn callee_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "method_invocation" => n
            .child_by_field_name("object")
            .and_then(|n| callee_root(c, n)),
        "value_path" | "module_path" | "constructor_path" | "class_path" => {
            c.text(n).split(['.', '#']).next()
        }
        "value_name" | "module_name" | "constructor_name" | "class_name" => Some(c.text(n)),
        _ => children(n).into_iter().find_map(|n| callee_root(c, n)),
    }
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let nodes = walk(root);
    let mut constructors: HashMap<String, Vec<ChunkRef>> = HashMap::new();
    for &d in nodes.iter().filter(|n| n.kind() == "type_definition") {
        let Some(target) = c.owner(d).filter(|t| t.kind == "type") else {
            continue;
        };
        for n in walk(d)
            .into_iter()
            .filter(|n| n.kind() == "constructor_declaration")
        {
            if let Some(name) = n
                .child_by_field_name("name")
                .or_else(|| named(n, "constructor_name"))
            {
                let entries = constructors.entry(c.text(name).into()).or_default();
                if !entries
                    .iter()
                    .any(|e| e.location.start_offset == target.location.start_offset)
                {
                    entries.push(target.clone());
                }
            }
        }
    }
    let resolve = |call, name: Option<&str>| {
        let Some(name) = name.filter(|s| !s.is_empty()) else {
            return Resolved::UNKNOWN;
        };
        if let Some(b) = lexical(c, call, name) {
            return b;
        }
        if let Some(targets) = constructors.get(name).filter(|t| !t.is_empty()) {
            return if targets.len() == 1 {
                Resolved::target(targets[0].clone())
            } else {
                Resolved::UNKNOWN
            };
        }
        let mut bindings = children(root)
            .into_iter()
            .filter(|n| {
                n.start_byte() <= call.start_byte()
                    && !(n.kind() == "value_definition" && encloses(*n, call) && !recursive(*n))
            })
            .filter_map(|n| declaration(c, n, name));
        match (bindings.next(), bindings.next()) {
            (Some(b), None) => b,
            _ => Resolved::UNKNOWN,
        }
    };
    let mut facts = Vec::new();
    for n in nodes {
        facts.extend(import(c, n));
        let callee = match n.kind() {
            "application_expression" => {
                if n.parent().is_some_and(|p| {
                    p.kind() == "application_expression"
                        && p.child_by_field_name("function") == Some(n)
                }) {
                    continue;
                }
                n.child_by_field_name("function")
            }
            "infix_expression" => {
                let Some(op) = n.child_by_field_name("operator") else {
                    continue;
                };
                facts.push(c.call(
                    c.text(op).into(),
                    n,
                    resolve(n, Some(c.text(op))),
                    c.owner(n),
                ));
                continue;
            }
            "module_application" => n.child_by_field_name("functor"),
            "new_expression" => named(n, "class_path"),
            _ => continue,
        };
        facts.push(c.call(
            c.text(callee.unwrap_or(n)).into(),
            n,
            resolve(n, callee.and_then(|n| callee_root(c, n))),
            c.owner(n),
        ));
    }
    facts
}
