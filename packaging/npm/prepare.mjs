#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './command.mjs';
import { verifyPackages } from './verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const target = 'aarch64-apple-darwin';

// Prepare locally. Publication is a separate, manual step.
const scope = readScope();
const { crate, targetDirectory } = readCargoMetadata();
const binaryName = `${scope}/mimirs-darwin-arm64`;
const output = createOutputDirectory(targetDirectory, crate.version);

console.log('1. Build and check the Apple Silicon executable');
const executable = buildExecutable(targetDirectory, output);

console.log('2. Fill package templates and copy release files');
const platform = preparePackage('darwin-arm64', crate, output);
platform.manifest.name = binaryName;
writeManifest(platform);
copyExecutable(executable, join(platform.directory, 'bin/mimirs'));

const main = preparePackage('main', crate, output);
main.manifest.optionalDependencies = { [binaryName]: crate.version };
main.manifest.mimirsPlatforms = { 'darwin-arm64': binaryName };
writeManifest(main);
copyExecutable(join(here, 'launcher.cjs'), join(main.directory, 'launcher.cjs'));

console.log('3. Pack both npm tarballs');
const platformTar = pack(platform.directory);
const mainTar = pack(main.directory);

console.log('4. Verify an offline installation and launcher behavior');
verifyPackages(platformTar, mainTar, crate.version, binaryName);

console.log('5. Write checksums');
writeChecksums([platformTar, mainTar]);
console.log(`Packages verified: ${output}\nPublish the platform tarball first, then the main tarball. Nothing has been published.`);

function readScope() {
  const [flag, scope, ...extra] = process.argv.slice(2);
  if (flag !== '--scope' || !/^@[a-z0-9][a-z0-9._-]*$/.test(scope ?? '') || extra.length) {
    throw new Error('Usage: node packaging/npm/prepare.mjs --scope @YOUR-NPM-SCOPE');
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Build on macOS Apple Silicon with ARM64 Node.js.');
  }
  return scope;
}

function readCargoMetadata() {
  const metadata = JSON.parse(run('cargo', [
    'metadata', '--no-deps', '--format-version', '1', '--locked',
  ], { cwd: root }));
  const crate = metadata.packages.find(p => p.manifest_path === join(root, 'Cargo.toml'));
  return { crate, targetDirectory: metadata.target_directory };
}

function createOutputDirectory(targetDirectory, version) {
  mkdirSync(targetDirectory, { recursive: true });
  return mkdtempSync(join(targetDirectory, `npm-${version}-`));
}

function buildExecutable(targetDirectory, output) {
  run('cargo', ['build', '--release', '--locked', '--target', target], {
    cwd: root, stdio: 'inherit',
  });
  const executable = join(targetDirectory, target, 'release/mimirs');
  assert.equal(run('lipo', ['-archs', executable]).trim(), 'arm64');
  const linkage = run('otool', ['-L', executable]);
  for (const line of linkage.trim().split('\n').slice(1)) {
    const library = line.trim().split(' (')[0];
    assert.ok(
      library.startsWith('/usr/lib/') || library.startsWith('/System/Library/'),
      `Unbundled native library: ${library}`,
    );
  }
  writeFileSync(join(output, 'linkage.txt'), linkage);
  return executable;
}

function preparePackage(template, crate, output) {
  const manifest = JSON.parse(readFileSync(join(here, 'templates', `${template}.json`), 'utf8'));
  manifest.version = crate.version;
  manifest.description = crate.description;
  manifest.license = crate.license;
  manifest.repository.url = crate.repository;
  manifest.publishConfig.tag = crate.version.includes('-') ? 'alpha' : 'latest';

  const directory = join(output, template);
  mkdirSync(directory);
  copyFileSync(join(root, 'LICENSE'), join(directory, 'LICENSE'));
  copyFileSync(join(here, 'PACKAGE-README.md'), join(directory, 'README.md'));
  return { directory, manifest };
}

function writeManifest({ directory, manifest }) {
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function copyExecutable(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

function pack(directory) {
  const [result] = JSON.parse(run('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', output,
  ], { cwd: directory }));
  return join(output, result.filename);
}

function writeChecksums(tarballs) {
  const lines = tarballs.map(path => {
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    return `${hash}  ${basename(path)}`;
  });
  writeFileSync(join(output, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}
