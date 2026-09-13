# Mimirs

Local engineering context for coding agents, implemented in Rust.

This experimental release supports macOS Apple Silicon with ARM64 Node.js 18 or
newer. Git must be installed. Rust is not required. The executable is included in
a platform package on npm; installation does not download it from GitHub.

```sh
npm install -g mimirs@alpha
mimirs --help
```

From a Git project:

```sh
mimirs init
mimirs index
mimirs context "how does this project work?"
```

Initialization may download embedding model assets. Keep npm optional dependencies
enabled. Intel Node.js under Rosetta is not supported by this release.

Source and documentation: https://github.com/TheWinci/mimirs
