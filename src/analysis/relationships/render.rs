use super::*;

fn quoted(source: &str) -> String {
    if (source.starts_with('"') && source.ends_with('"'))
        || (source.starts_with('<') && source.ends_with('>'))
    {
        source.into()
    } else {
        format!("\"{source}\"")
    }
}
fn lines(facts: &[Fact]) -> String {
    let start = facts
        .iter()
        .map(|f| f.location.start_line)
        .min()
        .unwrap_or(0);
    let end = facts.iter().map(|f| f.location.end_line).max().unwrap_or(0);
    if start == end {
        start.to_string()
    } else {
        format!("{start}–{end}")
    }
}
fn owner(chunk: Option<&ChunkRef>) -> String {
    chunk
        .map(|c| format!("{} {}", c.kind, c.name))
        .unwrap_or_else(|| "module".into())
}
pub fn render(project: &str, result: &Relationships) -> String {
    let mut labels = Vec::new();
    for r in &result.imports {
        labels.push(format!(
            "import {} -> {}{} via {} [{}]",
            r.from_path,
            if r.target_kind == "package" {
                "package "
            } else {
                ""
            },
            r.to_path,
            quoted(&r.source),
            lines(&r.facts)
        ));
    }
    for r in &result.re_exports {
        labels.push(format!(
            "re-export {} -> {} via \"{}\" [{}]",
            r.from_path,
            r.to_path,
            r.source,
            lines(&r.facts)
        ));
    }
    for r in &result.calls {
        if let Kind::Call { callee, .. } = &r.fact.kind {
            labels.push(format!(
                "call {}:{} -> {}:{} {} via {} [{}]",
                r.from_path,
                owner(r.from.as_ref()),
                r.to_path,
                r.to.kind,
                r.to.name,
                callee,
                r.fact.location.start_line
            ));
        }
    }
    for r in &result.unresolved_imports {
        if let Kind::Import { source, .. } = &r.fact.kind {
            labels.push(format!(
                "unresolved import {} -> {} [{}]",
                r.path,
                quoted(source),
                r.fact.location.start_line
            ));
        }
    }
    for r in &result.unresolved_re_exports {
        if let Kind::Export {
            source: Some(source),
            ..
        } = &r.fact.kind
        {
            labels.push(format!(
                "unresolved re-export {} -> \"{}\" [{}]",
                r.path, source, r.fact.location.start_line
            ));
        }
    }
    for r in &result.unresolved_calls {
        if let Kind::Call { callee, .. } = &r.fact.kind {
            labels.push(format!(
                "unresolved call {}:{} -> {} [{}]",
                r.path,
                owner(r.fact.owner.as_ref()),
                callee,
                r.fact.location.start_line
            ));
        }
    }
    if labels.is_empty() {
        labels.push("(no relationships)".into());
    }
    let mut output = project.to_owned();
    for (id, label) in labels.iter().enumerate() {
        output.push_str(&format!(
            "\n{} {label}",
            if id + 1 == labels.len() {
                "└──"
            } else {
                "├──"
            }
        ));
    }
    output
}
