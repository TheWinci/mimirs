//! Temporary switches for the ranking plan's experiments. `MIMIRS_PROBES`
//! lists the probes to turn on, separated by commas. The plan's last slice
//! removes this module.

use anyhow::{Result, bail};

use crate::keywords;

/// Every probe name `MIMIRS_PROBES` accepts.
const KNOWN_PROBES: [&str; 6] = [
    "path-file",
    "path-plain",
    "path-terms",
    "doc-references",
    "vector-weight",
    "unique-symbol",
];

/// The probes turned on for this run.
pub struct Probes {
    names: Vec<String>,
}

/// How a window starts with its file's path.
#[derive(Clone, Copy)]
pub enum PathPrefix {
    /// `File: src/search/hybrid.ts` (TS v2's format).
    File,
    /// `src/search/hybrid.ts`.
    Plain,
    /// `src search hybrid ts`: the keyword index's terms.
    Terms,
}

impl Probes {
    /// Read `MIMIRS_PROBES`; an unknown name is an error, so a typo cannot make
    /// a benchmark run measure nothing.
    pub fn from_env() -> Result<Self> {
        let value = std::env::var("MIMIRS_PROBES").unwrap_or_default();
        Self::parse(&value)
    }

    fn parse(value: &str) -> Result<Self> {
        let mut names: Vec<String> = Vec::new();
        for name in value
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            if !KNOWN_PROBES.contains(&name) {
                bail!("Unknown probe `{name}` in MIMIRS_PROBES");
            }
            names.push(name.to_string());
        }
        let path_formats = names
            .iter()
            .filter(|name| name.starts_with("path-"))
            .count();
        if path_formats > 1 {
            bail!("MIMIRS_PROBES turns on more than one path format");
        }
        Ok(Self { names })
    }

    fn has(&self, name: &str) -> bool {
        self.names.iter().any(|known| known == name)
    }

    /// S4: files named by found docs join the source list.
    pub fn doc_references(&self) -> bool {
        self.has("doc-references")
    }

    /// S5: the vector list weighs 0.6 instead of 0.5.
    pub fn vector_weight(&self) -> bool {
        self.has("vector-weight")
    }

    /// S6: a found chunk that alone defines a code identifier in the query
    /// scores ×1.3.
    pub fn unique_symbol(&self) -> bool {
        self.has("unique-symbol")
    }

    pub fn path_prefix(&self) -> Option<PathPrefix> {
        if self.has("path-file") {
            Some(PathPrefix::File)
        } else if self.has("path-plain") {
            Some(PathPrefix::Plain)
        } else if self.has("path-terms") {
            Some(PathPrefix::Terms)
        } else {
            None
        }
    }
}

impl PathPrefix {
    /// The line put in front of each of `path`'s windows.
    pub fn line(self, path: &str) -> String {
        match self {
            PathPrefix::File => format!("File: {path}\n"),
            PathPrefix::Plain => format!("{path}\n"),
            PathPrefix::Terms => format!("{}\n", keywords::terms(path).join(" ")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_read_from_a_comma_list() -> Result<()> {
        let probes = Probes::parse(" path-terms ,")?;
        assert!(matches!(probes.path_prefix(), Some(PathPrefix::Terms)));
        assert!(Probes::parse("")?.path_prefix().is_none());
        Ok(())
    }

    #[test]
    fn unknown_names_and_two_path_formats_are_errors() {
        assert!(Probes::parse("path-terms,typo").is_err());
        assert!(Probes::parse("path-file,path-plain").is_err());
    }

    #[test]
    fn each_format_writes_its_line() {
        let path = "src/search/hybrid.ts";
        assert_eq!(PathPrefix::File.line(path), "File: src/search/hybrid.ts\n");
        assert_eq!(PathPrefix::Plain.line(path), "src/search/hybrid.ts\n");
        assert_eq!(PathPrefix::Terms.line(path), "src search hybrid ts\n");
    }
}
