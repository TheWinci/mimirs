use super::*;

pub(super) struct Package {
    pub directory: String,
    name: String,
    files: Vec<usize>,
}
pub(super) struct Index {
    packages: HashMap<String, Vec<Package>>,
}
fn package_name<'a>(file: &'a File<'_>) -> Option<&'a str> {
    let names: HashSet<_> = file
        .top
        .iter()
        .filter(|c| c.kind == "package")
        .map(|c| c.name.as_str())
        .collect();
    if names.len() == 1 {
        names.into_iter().next()
    } else {
        None
    }
}
fn identifier(name: &str) -> bool {
    name.starts_with(|c: char| c.is_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_alphanumeric() || c == '_')
}
impl Index {
    pub fn new(project: &Project<'_>) -> Self {
        let mut groups: HashMap<(String, String), Package> = HashMap::new();
        for (id, file) in project
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.language == "go")
        {
            let Some(name) = package_name(file).filter(|s| !s.is_empty()) else {
                continue;
            };
            let directory = dirname(&file.path);
            groups
                .entry((directory.into(), name.into()))
                .or_insert_with(|| Package {
                    directory: directory.into(),
                    name: name.into(),
                    files: Vec::new(),
                })
                .files
                .push(id);
        }
        let mut packages: HashMap<String, Vec<Package>> = HashMap::new();
        for package in groups.into_values() {
            packages
                .entry(package.directory.clone())
                .or_default()
                .push(package);
        }
        Self { packages }
    }
    pub fn resolve_import(
        &self,
        project: &Project<'_>,
        file: usize,
        fact: Import<'_>,
        options: &Options,
    ) -> Option<&Package> {
        let directory = if fact.source.starts_with('.') {
            join(dirname(&project.files[file].path), fact.source)
        } else {
            let module = options.go_module_path.as_ref().filter(|s| !s.is_empty())?;
            if fact.source == module {
                ".".into()
            } else {
                normalized(fact.source.strip_prefix(&format!("{module}/"))?)
            }
        };
        let packages = self.packages.get(&directory)?;
        if packages.len() == 1 {
            return packages.first();
        }
        let mut production = packages.iter().filter(|p| !p.name.ends_with("_test"));
        match (production.next(), production.next()) {
            (Some(p), None) => Some(p),
            _ => None,
        }
    }
    fn target(
        &self,
        project: &Project<'_>,
        package: &Package,
        name: &str,
        exported: bool,
    ) -> Option<Target> {
        if exported && !name.starts_with(char::is_uppercase) {
            return None;
        }
        unique(package.files.iter().flat_map(|&id| {
            project.files[id]
                .top
                .iter()
                .filter(move |c| {
                    c.name == name
                        && matches!(
                            c.kind.as_str(),
                            "function" | "type" | "struct" | "interface"
                        )
                })
                .cloned()
                .map(move |chunk| Target { file: id, chunk })
        }))
    }
    pub fn imported_target(
        &self,
        project: &Project<'_>,
        file: usize,
        callee: &str,
        options: &Options,
    ) -> Option<Target> {
        let qualified = callee
            .split_once('.')
            .filter(|(root, member)| identifier(root) && identifier(member));
        let mut candidates = Vec::new();
        for &fact in &project.files[file].imports {
            if fact.local == Some("_") {
                continue;
            }
            let Some(package) = self.resolve_import(project, file, fact, options) else {
                continue;
            };
            if let Some((root, member)) = qualified {
                if fact.local.unwrap_or(&package.name) == root {
                    candidates.extend(self.target(project, package, member, true));
                }
            } else if fact.local == Some(".") && identifier(callee) {
                candidates.extend(self.target(project, package, callee, true));
            }
        }
        unique(candidates)
    }
    pub fn same_package(&self, project: &Project<'_>, file: usize, callee: &str) -> Option<Target> {
        if !identifier(callee) {
            return None;
        }
        let file = &project.files[file];
        let name = package_name(file)?;
        let package = self
            .packages
            .get(dirname(&file.path))?
            .iter()
            .find(|p| p.name == name)?;
        self.target(project, package, callee, false)
    }
}
