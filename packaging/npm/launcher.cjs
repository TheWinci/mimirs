#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const manifest = require('./package.json');
const platform = `${process.platform}-${process.arch}`;
const packageName = manifest.mimirsPlatforms[platform];

function fail(message) {
  console.error(`mimirs: ${message}`);
  process.exit(1);
}

if (!packageName) {
  fail(`Unsupported platform ${platform}. This release supports macOS Apple Silicon with ARM64 Node.js.`);
}
let executable;
try {
  executable = require.resolve(`${packageName}/bin/mimirs`);
} catch {
  fail(`Missing ${packageName}. Reinstall with optional dependencies enabled: npm install -g mimirs@${manifest.version} --include=optional`);
}
const child = spawn(executable, process.argv.slice(2), { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', error => fail(`Cannot start executable: ${error.message}`));
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
