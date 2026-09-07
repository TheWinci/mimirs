use super::*;

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
            .filter(|(_, f)| f.language == "haskell")
        {
            for chunk in file.top.iter().filter(|c| c.kind == "module") {
                modules.entry(chunk.name.clone()).or_default().push(id);
            }
        }
        Self { modules }
    }
    pub fn has_root(&self, root: &str) -> bool {
        self.modules
            .keys()
            .any(|name| name == root || name.starts_with(&format!("{root}.")))
    }
    pub fn resolve_import(&self, project: &Project<'_>, source: &str) -> Option<usize> {
        let files = unique_files(
            project,
            self.modules.get(source).into_iter().flatten().copied(),
        );
        if files.len() == 1 {
            files.first().copied()
        } else {
            None
        }
    }
    fn member(&self, project: &Project<'_>, module: &str, name: &str) -> Option<Target> {
        let kind = if name.starts_with(|ch: char| ch.is_ascii_uppercase()) {
            "type"
        } else {
            "function"
        };
        unique(
            self.modules
                .get(module)
                .into_iter()
                .flatten()
                .flat_map(|&id| {
                    project.files[id]
                        .top
                        .iter()
                        .filter(move |c| c.kind == kind && c.name == name)
                        .cloned()
                        .map(move |chunk| Target { file: id, chunk })
                }),
        )
    }
    pub fn call(&self, project: &Project<'_>, file: usize, fact: Call<'_>) -> Option<Target> {
        if !matches!(fact.binding, Binding::Import | Binding::Unknown) {
            return None;
        }
        let parts: Vec<_> = fact.callee.split('.').filter(|s| !s.is_empty()).collect();
        let root = *parts.first()?;
        let mut candidates = Vec::new();
        for imported in &project.files[file].imports {
            if imported.local == Some(root) && imported.imported == Some("*") && parts.len() == 2 {
                candidates.extend(self.member(project, imported.source, parts[1]));
            } else if imported.local == Some(root)
                && imported.imported == Some(root)
                && parts.len() == 1
            {
                candidates.extend(self.member(project, imported.source, root));
            }
        }
        if parts.len() >= 2 {
            candidates.extend(self.member(
                project,
                &parts[..parts.len() - 1].join("."),
                parts[parts.len() - 1],
            ));
        }
        unique(candidates)
    }
}
