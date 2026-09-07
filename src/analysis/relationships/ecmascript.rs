use super::*;

pub(super) fn resolve_import(project: &Project<'_>, from: &str, source: &str) -> Option<usize> {
    if !source.starts_with('.') {
        return None;
    }
    let base = join(dirname(from), source);
    let ext = extension(&base);
    let mut candidates = vec![base.clone()];
    let alternate: &[&str] = match ext {
        "js" => &["ts"],
        "jsx" => &["tsx", "ts"],
        "mjs" => &["mts", "ts"],
        "cjs" => &["cts", "ts"],
        _ => &[],
    };
    for ext in alternate {
        candidates.push(format!(
            "{}.{ext}",
            base.rsplit_once('.').map(|(path, _)| path).unwrap_or(&base)
        ));
    }
    if ext.is_empty()
        && !base
            .rsplit('/')
            .next()
            .is_some_and(|name| name.contains('.') && !name.ends_with('.'))
    {
        let js = ["js", "mjs", "cjs", "jsx"];
        let ts = ["ts", "mts", "cts", "tsx", "d.ts"];
        let extensions: Vec<_> = if matches!(extension(from), "js" | "mjs" | "cjs") {
            js.iter().chain(ts.iter()).collect()
        } else {
            ts.iter().chain(js.iter()).collect()
        };
        candidates.extend(extensions.iter().map(|ext| format!("{base}.{ext}")));
        candidates.extend(extensions.iter().map(|ext| format!("{base}/index.{ext}")));
    }
    candidates
        .into_iter()
        .find_map(|path| project.file(&normalized(&path)))
}
fn exported(
    project: &Project<'_>,
    file_id: usize,
    name: &str,
    visited: &HashSet<(usize, String)>,
) -> Option<Target> {
    let key = (file_id, name.into());
    if visited.contains(&key) {
        return None;
    }
    let mut visited = visited.clone();
    visited.insert(key);
    let file = &project.files[file_id];
    let mut candidates = Vec::new();
    for fact in &file.exports {
        if fact.fact.owner.is_some() || fact.type_only {
            continue;
        }
        if let Some(source) = fact.source {
            let star = fact.exported == "*" && name != "default";
            if fact.exported != name && !star {
                continue;
            }
            let Some(target) = resolve_import(project, &file.path, source) else {
                continue;
            };
            candidates.extend(exported(
                project,
                target,
                if star {
                    name
                } else {
                    fact.local.unwrap_or(name)
                },
                &visited,
            ));
        } else if fact.exported == name
            && let Some(local) = fact.local
        {
            candidates.extend(
                file.top
                    .iter()
                    .filter(|chunk| chunk.name == local && callable(chunk))
                    .cloned()
                    .map(|chunk| Target {
                        file: file_id,
                        chunk,
                    }),
            );
        }
    }
    unique(candidates)
}
fn identifier(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}
pub(super) fn imported_target(
    project: &Project<'_>,
    file_id: usize,
    callee: &str,
) -> Option<Target> {
    let file = &project.files[file_id];
    if let Some(fact) = file
        .imports
        .iter()
        .find(|f| !f.type_only && f.local == Some(callee) && f.imported.is_some_and(|s| s != "*"))
        && let Some(target) = resolve_import(project, &file.path, fact.source)
            .and_then(|id| exported(project, id, fact.imported.unwrap_or(""), &HashSet::new()))
    {
        return Some(target);
    }
    let (root, member) = callee.split_once('.')?;
    if !identifier(root) || !identifier(member) {
        return None;
    }
    let fact = file
        .imports
        .iter()
        .find(|f| !f.type_only && f.imported == Some("*") && f.local == Some(root))?;
    exported(
        project,
        resolve_import(project, &file.path, fact.source)?,
        member,
        &HashSet::new(),
    )
}
