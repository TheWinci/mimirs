use super::*;
mod commonjs;

fn string(c: &Context<'_>, node: Option<Node<'_>>) -> Option<String> {
    let text = c.text(node?);
    Some(
        text.strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .or_else(|| text.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
            .unwrap_or(text)
            .into(),
    )
}
fn binding(c: &Context<'_>, node: Option<Node<'_>>, name: &str, common: bool) -> bool {
    let Some(n) = node else { return false };
    match n.kind() {
        "identifier" | "shorthand_property_identifier_pattern" => c.text(n) == name,
        "pair_pattern" => binding(c, n.child_by_field_name("value"), name, common),
        "assignment_pattern" => binding(c, n.child_by_field_name("left"), name, common),
        "required_parameter" | "optional_parameter" if common => binding(
            c,
            n.child_by_field_name("pattern")
                .or_else(|| n.named_child(0)),
            name,
            common,
        ),
        _ => children(n)
            .into_iter()
            .any(|n| binding(c, Some(n), name, common)),
    }
}
fn import_binds(c: &Context<'_>, n: Node<'_>, name: &str, ts: bool) -> bool {
    if ts && let Some(clause) = named(n, "import_require_clause") {
        return children(clause)
            .into_iter()
            .any(|n| n.kind() == "identifier" && c.text(n) == name);
    }
    let Some(clause) = named(n, "import_clause") else {
        return false;
    };
    children(clause)
        .into_iter()
        .any(|n| n.kind() == "identifier" && c.text(n) == name)
        || walk(clause).into_iter().any(|n| match n.kind() {
            "namespace_import" => children(n)
                .into_iter()
                .any(|n| n.kind() == "identifier" && c.text(n) == name),
            "import_specifier" => n
                .child_by_field_name("alias")
                .or_else(|| n.child_by_field_name("name"))
                .is_some_and(|n| c.text(n) == name),
            _ => false,
        })
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str, ts: bool) -> Option<Resolved> {
    match n.kind() {
        "export_statement" => children(n)
            .into_iter()
            .find_map(|n| declaration(c, n, name, ts)),
        "import_statement" => import_binds(c, n, name, ts).then_some(Resolved::IMPORT),
        "function_declaration" | "generator_function_declaration" => n
            .child_by_field_name("name")
            .filter(|n| c.text(*n) == name)
            .map(|_| {
                c.declared(n, name, &["function", "method"])
                    .map(Resolved::target)
                    .unwrap_or(Resolved::LOCAL)
            }),
        "lexical_declaration" | "variable_declaration" | "using_declaration"
            if ts || n.kind() != "using_declaration" =>
        {
            let d = walk(n).into_iter().find(|n| {
                n.kind() == "variable_declarator"
                    && binding(c, n.child_by_field_name("name"), name, false)
            })?;
            if d.child_by_field_name("value")
                .is_some_and(|n| commonjs::require_binding(c, n).is_some())
            {
                Some(Resolved::IMPORT)
            } else {
                Some(
                    c.declared(d, name, &["function", "method"])
                        .map(Resolved::target)
                        .unwrap_or(Resolved::LOCAL),
                )
            }
        }
        "class_declaration" | "enum_declaration" | "internal_module"
            if ts || n.kind() == "class_declaration" =>
        {
            n.child_by_field_name("name")
                .is_some_and(|n| c.text(n) == name)
                .then_some(Resolved::LOCAL)
        }
        _ => None,
    }
}
fn callee_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    if n.kind() == "identifier" {
        Some(c.text(n))
    } else if matches!(n.kind(), "member_expression" | "subscript_expression") {
        n.child_by_field_name("object")
            .and_then(|n| callee_root(c, n))
    } else {
        None
    }
}
fn resolve(c: &Context<'_>, call: Node<'_>, callee: Node<'_>, ts: bool) -> Resolved {
    let Some(name) = callee_root(c, callee) else {
        return Resolved::UNKNOWN;
    };
    let mut parent = call.parent();
    while let Some(n) = parent {
        if matches!(
            n.kind(),
            "function_declaration"
                | "function_expression"
                | "arrow_function"
                | "method_definition"
                | "generator_function_declaration"
        ) && n.child_by_field_name("parameters").is_some_and(|n| {
            children(n).into_iter().any(|n| {
                binding(
                    c,
                    Some(if ts {
                        n.child_by_field_name("pattern").unwrap_or(n)
                    } else {
                        n
                    }),
                    name,
                    false,
                )
            })
        }) {
            return Resolved::LOCAL;
        }
        if n.kind() == "catch_clause" && binding(c, n.child_by_field_name("parameter"), name, false)
        {
            return Resolved::LOCAL;
        }
        if matches!(n.kind(), "program" | "statement_block")
            && let Some(b) = children(n)
                .into_iter()
                .find_map(|n| declaration(c, n, name, ts))
        {
            return b;
        }
        parent = n.parent();
    }
    Resolved::UNKNOWN
}
fn keyword<'a>(text: &'a str, word: &str) -> Option<&'a str> {
    text.strip_prefix(word).filter(|rest| {
        rest.chars()
            .next()
            .is_none_or(|ch| !(ch.is_ascii_alphanumeric() || ch == '_'))
    })
}
fn after_statement<'a>(text: &'a str, statement: &str) -> Option<&'a str> {
    text.strip_prefix(statement)
        .filter(|s| s.starts_with(char::is_whitespace))
        .map(str::trim_start)
}
fn import(
    c: &Context<'_>,
    source: &str,
    imported: Option<String>,
    local: Option<String>,
    only: bool,
    n: Node<'_>,
    owner: Option<ChunkRef>,
) -> Fact {
    Fact {
        kind: Kind::Import {
            source: source.into(),
            imported,
            local,
            type_only: only,
            is_static: false,
            global: false,
        },
        owner,
        location: Location::from_span(&c.lines.span(n.start_byte(), n.end_byte())),
    }
}
fn imports(c: &Context<'_>, n: Node<'_>, ts: bool) -> Vec<Fact> {
    let require = if ts {
        named(n, "import_require_clause")
    } else {
        None
    };
    let Some(source) = string(
        c,
        n.child_by_field_name("source")
            .or_else(|| require.and_then(|n| n.child_by_field_name("source"))),
    ) else {
        return Vec::new();
    };
    if let Some(require) = require {
        return vec![import(
            c,
            &source,
            Some("*".into()),
            named(require, "identifier").map(|n| c.text(n).into()),
            false,
            require,
            c.owner(n),
        )];
    }
    let Some(clause) = named(n, "import_clause") else {
        return vec![import(c, &source, None, None, false, n, None)];
    };
    let only =
        ts && after_statement(c.text(n), "import").is_some_and(|s| keyword(s, "type").is_some());
    let mut facts = Vec::new();
    if let Some(default) = named(clause, "identifier") {
        facts.push(import(
            c,
            &source,
            Some("default".into()),
            Some(c.text(default).into()),
            only,
            default,
            c.owner(n),
        ));
    }
    if let Some(namespace) = named(clause, "namespace_import") {
        facts.push(import(
            c,
            &source,
            Some("*".into()),
            named(namespace, "identifier").map(|n| c.text(n).into()),
            only,
            namespace,
            c.owner(n),
        ));
    }
    if let Some(list) = named(clause, "named_imports") {
        for spec in children(list)
            .into_iter()
            .filter(|n| n.kind() == "import_specifier")
        {
            let imported = spec
                .child_by_field_name("name")
                .map(|n| c.text(n).to_owned());
            let local = spec
                .child_by_field_name("alias")
                .map(|n| c.text(n).into())
                .or_else(|| imported.clone());
            facts.push(import(
                c,
                &source,
                imported,
                local,
                only || (ts && keyword(c.text(spec).trim(), "type").is_some()),
                spec,
                c.owner(n),
            ));
        }
    }
    facts
}
fn declared_names(c: &Context<'_>, n: Node<'_>) -> Vec<String> {
    for child in children(n) {
        if matches!(child.kind(), "string" | "export_clause") {
            continue;
        }
        if let Some(name) = child.child_by_field_name("name") {
            return vec![c.text(name).into()];
        }
        if matches!(child.kind(), "lexical_declaration" | "variable_declaration") {
            return walk(child)
                .into_iter()
                .filter(|n| n.kind() == "variable_declarator")
                .filter_map(|n| n.child_by_field_name("name"))
                .filter(|n| n.kind() == "identifier")
                .map(|n| c.text(n).into())
                .collect();
        }
    }
    Vec::new()
}
fn export(
    c: &Context<'_>,
    n: Node<'_>,
    exported: String,
    local: Option<String>,
    source: Option<String>,
    only: bool,
    owner: Option<ChunkRef>,
) -> Fact {
    Fact {
        kind: Kind::Export {
            exported,
            local,
            source,
            type_only: only,
        },
        owner,
        location: Location::from_span(&c.lines.span(n.start_byte(), n.end_byte())),
    }
}
fn exports(c: &Context<'_>, n: Node<'_>, ts: bool) -> Vec<Fact> {
    let source = string(c, n.child_by_field_name("source"));
    if ts
        && c.text(n)
            .strip_prefix("export")
            .is_some_and(|s| s.trim_start().starts_with('='))
    {
        return vec![export(
            c,
            n,
            "default".into(),
            named(n, "identifier").map(|n| c.text(n).into()),
            None,
            false,
            c.owner_where(n, |chunk| chunk.kind == "module"),
        )];
    }
    let names = declared_names(c, n);
    let owner = if ts {
        c.owner_where(n, |chunk| {
            chunk.kind == "module" && chunk.name.as_ref() != names.first()
        })
    } else {
        None
    };
    let only =
        ts && after_statement(c.text(n), "export").is_some_and(|s| keyword(s, "type").is_some());
    if let Some(clause) = named(n, "export_clause") {
        return children(clause)
            .into_iter()
            .filter(|n| n.kind() == "export_specifier")
            .map(|spec| {
                let local = spec
                    .child_by_field_name("name")
                    .map(|n| c.text(n).to_owned());
                let exported = spec
                    .child_by_field_name("alias")
                    .map(|n| c.text(n).into())
                    .or_else(|| local.clone())
                    .unwrap_or_else(|| "default".into());
                export(
                    c,
                    spec,
                    exported,
                    local,
                    source.clone(),
                    only || (ts && keyword(c.text(spec).trim(), "type").is_some()),
                    owner.clone(),
                )
            })
            .collect();
    }
    if !ts
        && let Some(namespace) = named(n, "namespace_export")
        && let Some(name) = named(namespace, "identifier")
    {
        return vec![export(
            c,
            namespace,
            c.text(name).into(),
            Some("*".into()),
            source,
            false,
            None,
        )];
    }
    if after_statement(c.text(n), "export").is_some_and(|s| s.starts_with('*')) {
        return vec![export(c, n, "*".into(), None, source, only, owner)];
    }
    if after_statement(c.text(n), "export").is_some_and(|s| keyword(s, "default").is_some()) {
        return vec![export(
            c,
            n,
            "default".into(),
            names.first().cloned(),
            source,
            false,
            owner,
        )];
    }
    names
        .into_iter()
        .map(|name| {
            export(
                c,
                n,
                name.clone(),
                Some(name),
                source.clone(),
                only,
                owner.clone(),
            )
        })
        .collect()
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>, ts: bool) -> Vec<Fact> {
    let mut facts = commonjs::extract(c, root);
    for n in walk(root) {
        match n.kind() {
            "import_statement" => facts.extend(imports(c, n, ts)),
            "export_statement" => facts.extend(exports(c, n, ts)),
            "call_expression" if commonjs::require_source(c, n).is_none() => {
                if let Some(callee) = n.child_by_field_name("function") {
                    facts.push(c.call(
                        c.text(callee).into(),
                        n,
                        resolve(c, n, callee, ts),
                        c.owner(n),
                    ));
                }
            }
            _ => {}
        }
    }
    facts.sort_by_key(|f| {
        (
            f.location.start_offset,
            f.location.end_offset,
            kind_order(&f.kind),
        )
    });
    if !ts {
        return facts;
    }
    let mut collapsed: Vec<Fact> = Vec::new();
    for fact in facts {
        if let Some(previous) = collapsed.last_mut()
            && matches!(fact.kind, Kind::Export { .. })
            && fact.kind == previous.kind
            && fact.owner.as_ref().map(|o| (&o.kind, &o.name))
                == previous.owner.as_ref().map(|o| (&o.kind, &o.name))
        {
            previous.location.end_offset =
                previous.location.end_offset.max(fact.location.end_offset);
            previous.location.end_line = previous.location.end_line.max(fact.location.end_line);
            continue;
        }
        collapsed.push(fact);
    }
    collapsed
}
