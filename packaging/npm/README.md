# Prepare an npm release

Run from the repository root on macOS Apple Silicon. Install Rust, Apple's command
line build tools, Git, and ARM64 Node.js 18+ with npm. Docker is not needed.

```sh
node packaging/npm/prepare.mjs --scope @YOUR-NPM-SCOPE
```

Use an npm scope you own. This creates `mimirs` and
`@YOUR-NPM-SCOPE/mimirs-darwin-arm64`, both versioned from Cargo.toml. The launcher
pins its optional binary dependency to that exact version. Future platforms can
add entries to the generated dependency and platform maps.

## Where to edit packaging

- `templates/main.json` defines the launcher package.
- `templates/darwin-arm64.json` defines the Apple Silicon binary package.
- `prepare.mjs` lists the build, template, pack, verify and checksum steps at the top.
- `verify.mjs` contains the installation and launcher checks.

Edit the JSON templates to change package contents, supported platforms, or Node
requirements. Preparation replaces only the version, description, license,
repository URL and release tag from Cargo metadata, then sets the scoped binary
name and the launcher's matching dependency and platform entry. Placeholder
values in the templates are never published directly. No template engine is used.

The command builds with locked Cargo dependencies, checks the executable's ARM64
architecture and system-library linkage, and creates two tarballs under a unique
`target/npm-VERSION-*` directory. It installs both tarballs offline in a temporary
npm project, checks version/help, error exit status and the missing-package error,
and writes SHA256SUMS. It never publishes. Generated packages and binaries stay
outside Git and the Cargo source package.

These checks run on the build Mac. Before a release, also install the tarballs on
a clean supported Mac and exercise `init`, `index`, and `context` against a small
Git repository. This checks model setup and inference, which help/version do not.
Record the macOS version tested. This workflow does not sign with a Developer ID
or notarize the executable.

## Publish manually

Review the generated manifests, package contents and checksums. Verify ownership
of `mimirs` and the chosen scope, and ensure this version is unused on npm. Publish
from a clean, reviewed source version. Substitute the actual output paths below:

```sh
npm publish /absolute/path/to/platform-package.tgz --access public --tag alpha
npm publish /absolute/path/to/main-package.tgz --access public --tag alpha
```

Publish the platform package first. If only the second publication fails, retry
that package after checking registry state; do not overwrite a published version.
Use `alpha` for this prerelease to preserve the existing `latest` release.
After publication, test `npx mimirs@VERSION --version` and a real indexing run.
The offline local test supplies both tarballs explicitly; the registry test also
checks optional dependency discovery. Cargo publication remains a separate step.
