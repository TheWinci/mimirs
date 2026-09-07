use super::*;

pub(super) fn resolve_import(
    project: &Project<'_>,
    file: &File<'_>,
    fact: Import<'_>,
) -> Option<usize> {
    if !matches!(fact.imported, Some("require" | "require_relative")) {
        return None;
    }
    let suffixes = if extension(fact.source).is_empty() {
        vec![fact.source.into(), format!("{}.rb", fact.source)]
    } else {
        vec![fact.source.to_owned()]
    };
    let bases = if fact.imported == Some("require_relative") {
        vec![dirname(&file.path)]
    } else {
        vec![".", "lib"]
    };
    let candidates = unique_files(
        project,
        bases
            .into_iter()
            .flat_map(|base| {
                suffixes
                    .iter()
                    .filter_map(move |suffix| project.file(&join(base, suffix)))
            })
            .filter(|&id| project.files[id].language == "ruby"),
    );
    if candidates.len() == 1 {
        candidates.first().copied()
    } else {
        None
    }
}
pub(super) struct Index {
    constants: HashMap<String, Vec<(usize, usize)>>,
}
impl Index {
    pub fn new(project: &Project<'_>) -> Self {
        let mut constants: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
        for (file_id, file) in project
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.language == "ruby")
        {
            let mut prefixes: Vec<Option<Vec<String>>> =
                vec![None; file.analysis.source_chunks.len()];
            for (id, chunk) in file.analysis.source_chunks.iter().enumerate() {
                let prefix = match chunk.parent {
                    None => Some(Vec::new()),
                    Some(parent) => prefixes[parent].clone(),
                };
                let Some(prefix) = prefix else { continue };
                let Some(name) = &chunk.name else { continue };
                if !matches!(chunk.kind.as_str(), "class" | "module")
                    || (chunk.kind == "class" && name == "singleton self")
                {
                    continue;
                }
                let mut names = if name.contains("::") {
                    Vec::new()
                } else {
                    prefix
                };
                names.extend(name.split("::").map(str::to_owned));
                constants
                    .entry(names.join("::"))
                    .or_default()
                    .push((file_id, id));
                prefixes[id] = Some(names);
            }
        }
        Self { constants }
    }
    pub fn call(&self, project: &Project<'_>, file_id: usize, fact: Call<'_>) -> Option<Target> {
        if fact.binding != Binding::Unknown || !fact.callee.contains(['.', ':']) {
            return None;
        }
        let callee = fact.callee.replace("&.", ".").replace("::", ".");
        let mut parts: Vec<_> = callee.split('.').filter(|s| !s.is_empty()).collect();
        if parts.len() < 2 {
            return None;
        }
        let method = parts.pop()?;
        let name = parts.join("::");
        let file = &project.files[file_id];
        let required: HashSet<_> = file
            .imports
            .iter()
            .filter_map(|&fact| resolve_import(project, file, fact))
            .map(|id| project.files[id].path.as_str())
            .collect();
        let eligible = self
            .constants
            .iter()
            .filter(|(constant, _)| {
                if name.contains("::") {
                    **constant == name
                } else {
                    constant.rsplit("::").next() == Some(name.as_str())
                }
            })
            .flat_map(|(_, entries)| entries)
            .filter(|&&(id, _)| required.contains(project.files[id].path.as_str()));
        let mut targets = Vec::new();
        for &(id, chunk_id) in eligible {
            let file = &project.files[id];
            let chunks = &file.analysis.source_chunks;
            if method == "new" {
                if let Some(chunk) = chunk_ref(&chunks[chunk_id]) {
                    targets.push(Target { file: id, chunk });
                }
                continue;
            }
            let mut stack: Vec<_> = chunks
                .iter()
                .enumerate()
                .filter(|(_, c)| c.parent == Some(chunk_id))
                .map(|(id, _)| (id, false))
                .collect();
            while let Some((chunk_id, singleton)) = stack.pop() {
                let chunk = &chunks[chunk_id];
                let next = singleton
                    || (chunk.kind == "class" && chunk.name.as_deref() == Some("singleton self"));
                let direct = file.analysis.source.text[chunk.span.start..chunk.span.end]
                    .trim_start()
                    .starts_with(&format!("def self.{method}"));
                if chunk.kind == "method"
                    && chunk.name.as_deref() == Some(method)
                    && (singleton || direct)
                    && let Some(chunk) = chunk_ref(chunk)
                {
                    targets.push(Target { file: id, chunk });
                }
                if next || !matches!(chunk.kind.as_str(), "class" | "module") {
                    stack.extend(
                        chunks
                            .iter()
                            .enumerate()
                            .filter(|(_, c)| c.parent == Some(chunk_id))
                            .map(|(id, _)| (id, next)),
                    );
                }
            }
        }
        unique(targets)
    }
}
