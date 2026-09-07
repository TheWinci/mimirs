use super::*;

fn module_names(path: &str) -> Vec<String> {
    let ext = extension(path);
    if !matches!(ext, "py" | "pyi") {
        return Vec::new();
    }
    let mut parts: Vec<_> = path[..path.len() - ext.len() - 1].split('/').collect();
    if parts.last() == Some(&"__init__") {
        parts.pop();
    }
    let mut names = vec![parts.join(".")];
    if parts.first() == Some(&"src") && parts.len() > 1 {
        names.push(parts[1..].join("."));
    }
    names.retain(|name| !name.is_empty());
    names.dedup();
    names
}
fn import_names(file: &File<'_>, source: &str) -> Vec<String> {
    let level = source.bytes().take_while(|&b| b == b'.').count();
    if level == 0 {
        return vec![source.into()];
    }
    let suffix: Vec<_> = source[level..]
        .split('.')
        .filter(|s| !s.is_empty())
        .collect();
    let mut names = Vec::new();
    for name in module_names(&file.path) {
        let mut parts: Vec<_> = name.split('.').collect();
        if !matches!(
            file.path.rsplit('/').next(),
            Some("__init__.py" | "__init__.pyi")
        ) {
            parts.pop();
        }
        if level - 1 > parts.len() {
            continue;
        }
        parts.truncate(parts.len() - (level - 1));
        parts.extend(&suffix);
        let name = parts.join(".");
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}
pub(super) struct Index {
    modules: HashMap<String, Vec<usize>>,
}
impl Index {
    pub fn new(project: &Project<'_>) -> Self {
        let mut modules: HashMap<String, Vec<usize>> = HashMap::new();
        for (id, file) in project
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.language == "python")
        {
            for name in module_names(&file.path) {
                modules.entry(name).or_default().push(id);
            }
        }
        Self { modules }
    }
    pub fn has_root(&self, root: &str) -> bool {
        self.modules
            .keys()
            .any(|name| name == root || name.starts_with(&format!("{root}.")))
    }
    fn select(
        &self,
        project: &Project<'_>,
        names: impl IntoIterator<Item = String>,
    ) -> Option<usize> {
        let files = unique_files(
            project,
            names
                .into_iter()
                .flat_map(|name| self.modules.get(&name).into_iter().flatten().copied()),
        );
        let implementations: Vec<_> = files
            .iter()
            .copied()
            .filter(|&id| project.files[id].path.ends_with(".py"))
            .collect();
        if implementations.len() == 1 {
            implementations.first().copied()
        } else if implementations.len() > 1 {
            None
        } else if files.len() == 1 {
            files.first().copied()
        } else {
            None
        }
    }
    pub fn resolve_import(
        &self,
        project: &Project<'_>,
        file: usize,
        fact: Import<'_>,
    ) -> Option<usize> {
        let names = import_names(&project.files[file], fact.source);
        let base = self.select(project, names.clone());
        let Some(imported) = fact.imported.filter(|s| !s.is_empty() && *s != "*") else {
            return base;
        };
        if base.is_some_and(|id| project.files[id].top.iter().any(|c| c.name == imported)) {
            return base;
        }
        self.select(
            project,
            names.into_iter().map(|name| format!("{name}.{imported}")),
        )
        .or(base)
    }
    fn symbol(
        &self,
        project: &Project<'_>,
        file_id: usize,
        name: &str,
        visited: &HashSet<(usize, String)>,
    ) -> Option<Target> {
        let key = (file_id, name.to_owned());
        if visited.contains(&key) {
            return None;
        }
        let mut visited = visited.clone();
        visited.insert(key);
        let file = &project.files[file_id];
        let mut candidates: Vec<_> = file
            .top
            .iter()
            .filter(|c| c.name == name && (callable(c) || c.kind == "class"))
            .cloned()
            .map(|chunk| Target {
                file: file_id,
                chunk,
            })
            .collect();
        for &fact in &file.imports {
            if fact.fact.owner.is_some() || fact.type_only || fact.local != Some(name) {
                continue;
            }
            let Some(imported) = fact.imported.filter(|s| *s != "*") else {
                continue;
            };
            if let Some(target) = self.resolve_import(project, file_id, fact) {
                candidates.extend(self.symbol(project, target, imported, &visited));
            }
        }
        unique(candidates)
    }
    pub fn imported_target(
        &self,
        project: &Project<'_>,
        file_id: usize,
        callee: &str,
    ) -> Option<Target> {
        let parts: Vec<_> = callee.split('.').collect();
        let root = *parts.first().filter(|s| !s.is_empty())?;
        let mut candidates = Vec::new();
        for &fact in &project.files[file_id].imports {
            if fact.type_only || fact.local != Some(root) {
                continue;
            }
            let Some(target) = self.resolve_import(project, file_id, fact) else {
                continue;
            };
            if let Some(imported) = fact.imported.filter(|s| *s != "*") {
                let direct = self.symbol(project, target, imported, &HashSet::new());
                if parts.len() == 2 && direct.is_none() {
                    candidates.extend(self.symbol(project, target, parts[1], &HashSet::new()));
                }
                if parts.len() == 1 {
                    candidates.extend(direct);
                }
                continue;
            }
            let source: Vec<_> = fact
                .source
                .trim_start_matches('.')
                .split('.')
                .filter(|s| !s.is_empty())
                .collect();
            let prefix = if !fact.source.starts_with('.') && source.first().copied() == fact.local {
                source
            } else {
                vec![root]
            };
            if parts.len() == prefix.len() + 1 && parts.starts_with(&prefix) {
                candidates.extend(self.symbol(
                    project,
                    target,
                    parts[parts.len() - 1],
                    &HashSet::new(),
                ));
            }
        }
        unique(candidates)
    }
}
