use super::*;

pub(super) struct Index {
    libraries: HashMap<String, Vec<usize>>,
}
impl Index {
    pub fn new(project: &Project<'_>) -> Self {
        let mut libraries: HashMap<String, Vec<usize>> = HashMap::new();
        for (id, file) in project.files.iter().enumerate().filter(|(_, f)| {
            f.language == "dart" && !f.imports.iter().any(|i| i.imported == Some("part of"))
        }) {
            for chunk in file.top.iter().filter(|c| c.kind == "module") {
                libraries.entry(chunk.name.clone()).or_default().push(id);
            }
        }
        Self { libraries }
    }
    pub fn uri(project: &Project<'_>, file: &File<'_>, source: &str) -> Option<usize> {
        if scheme(source) {
            return None;
        }
        project
            .file(&join(dirname(&file.path), source))
            .filter(|&id| project.files[id].language == "dart")
    }
    pub fn import(
        &self,
        project: &Project<'_>,
        file: &File<'_>,
        fact: Import<'_>,
    ) -> Option<usize> {
        if fact.imported == Some("part of")
            && !fact.source.contains('/')
            && !fact.source.ends_with(".dart")
        {
            let files = unique_files(
                project,
                self.libraries
                    .get(fact.source)
                    .into_iter()
                    .flatten()
                    .copied(),
            );
            return (files.len() == 1).then(|| files[0]);
        }
        Self::uri(project, file, fact.source)
    }
    pub fn local(&self, source: &str) -> bool {
        (!scheme(source) && source.contains(['/', '.']))
            || self.libraries.keys().any(|name| {
                let root = source.split('.').next().unwrap_or("");
                name == root || name.starts_with(&format!("{root}."))
            })
    }
    pub fn call(&self, project: &Project<'_>, file_id: usize, fact: Call<'_>) -> Option<Target> {
        if !matches!(fact.binding, Binding::Unknown | Binding::Import)
            || fact.callee.contains("?.")
            || fact.callee.contains("..")
        {
            return None;
        }
        let callee = fact.callee.replace("()", "");
        let parts: Vec<_> = callee.split('.').filter(|s| !s.is_empty()).collect();
        let root = *parts.first()?;
        let file = &project.files[file_id];
        unique(file.imports.iter().filter_map(|&imported| {
            let target = self.import(project, file, imported)?;
            if matches!(imported.imported, Some("part" | "part of")) {
                return None;
            }
            let name = if imported.local == Some(root)
                && matches!(imported.imported, Some("*" | "conditional"))
                && parts.len() >= 2
            {
                parts[1]
            } else if imported.local == Some(root)
                && imported.imported == Some(root)
                && parts.len() == 1
            {
                root
            } else {
                return None;
            };
            unique(
                project.files[target]
                    .top
                    .iter()
                    .filter(|c| matches!(c.kind.as_str(), "function" | "class") && c.name == name)
                    .cloned()
                    .map(|chunk| Target {
                        file: target,
                        chunk,
                    }),
            )
        }))
    }
}
