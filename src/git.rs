//! Read-only Git execution. Configured executable helpers are never part of observations.
use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeSet,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn base(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "submodule.recurse=false",
            "-c",
            "diff.ignoreSubmodules=all",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env_remove("GIT_EXTERNAL_DIFF");
    command
}
pub(crate) fn command(root: &Path) -> Result<Command> {
    let config = base(root)
        .args([
            "config",
            "--null",
            "--name-only",
            "--get-regexp",
            r"^filter\..*\.(clean|smudge|process|required)$",
        ])
        .output()?;
    ensure!(
        matches!(config.status.code(), Some(0 | 1)),
        "cannot inspect Git helper configuration"
    );
    let mut command = base(root);
    let drivers = std::str::from_utf8(&config.stdout)?
        .split('\0')
        .filter_map(|key| key.rsplit_once('.').map(|(driver, _)| driver))
        .collect::<BTreeSet<_>>();
    for driver in drivers {
        for field in ["clean", "smudge", "process"] {
            command.arg("-c").arg(format!("{driver}.{field}="));
        }
        command.arg("-c").arg(format!("{driver}.required=false"));
    }
    Ok(command)
}

/// Filtered paths and uninspected submodule worktrees make cleanliness unknown.
/// Callers may still read raw/history bytes, but must not authorize clean-only writes.
pub(crate) fn cleanliness_blockers(root: &Path) -> Result<Vec<String>> {
    let files = command(root)?
        .args(["ls-files", "-z", "--stage"])
        .output()?;
    ensure!(
        files.status.success(),
        "cannot enumerate tracked files for safe Git observation"
    );
    let mut blocked = BTreeSet::new();
    let mut paths = Vec::new();
    for entry in files.stdout.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let split = entry
            .iter()
            .position(|b| *b == b'\t')
            .context("invalid tracked Git entry")?;
        let path = &entry[split + 1..];
        if entry.starts_with(b"160000 ") {
            blocked.insert(String::from_utf8(path.to_vec())?);
        }
        paths.extend_from_slice(path);
        paths.push(0);
    }
    let mut attrs = command(root)?
        .args(["check-attr", "-z", "--stdin", "filter"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut input = attrs
        .stdin
        .take()
        .context("Git attribute input unavailable")?;
    // Attribute output grows with input; drain it concurrently through wait_with_output.
    let writer = std::thread::spawn(move || input.write_all(&paths));
    let attrs = attrs.wait_with_output()?;
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("Git attribute input interrupted"))??;
    ensure!(
        attrs.status.success(),
        "cannot inspect tracked Git filter attributes"
    );
    for fields in attrs
        .stdout
        .split(|b| *b == 0)
        .collect::<Vec<_>>()
        .chunks_exact(3)
    {
        if !matches!(fields[2], b"unspecified" | b"unset") {
            blocked.insert(String::from_utf8(fields[0].to_vec())?);
        }
    }
    Ok(blocked.into_iter().collect())
}
