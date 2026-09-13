import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './command.mjs';

export function verifyPackages(platformTar, mainTar, version, binaryName) {
  const sandbox = mkdtempSync(join(tmpdir(), 'mimirs-npm-'));
  const options = { cwd: sandbox, stdio: 'pipe' };
  try {
    writeFileSync(join(sandbox, 'package.json'), '{"private":true}\n');
    run('npm', [
      'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--package-lock=false', '--cache', join(sandbox, 'cache'),
      platformTar, mainTar,
    ], options);

    const installed = join(sandbox, 'node_modules/.bin/mimirs');
    assert.equal(run(installed, ['--version'], options).trim(), `mimirs ${version}`);
    assert.match(run(installed, ['--help'], options), /Usage:/);
    assert.throws(
      () => run(installed, ['--not-a-real-option'], options),
      error => error.status === 2,
      'Launcher must propagate a failing exit status',
    );

    const launcher = join(sandbox, 'node_modules/mimirs/launcher.cjs');
    const simulateWindows = 'Object.defineProperty(process, "platform", { value: "win32" }); require(process.argv[1]);';
    assert.throws(
      () => run(process.execPath, ['-e', simulateWindows, launcher], options),
      error => error.status === 1 && /Unsupported platform win32-arm64/.test(error.stderr),
      'Unsupported platforms must produce a clear error',
    );

    rmSync(join(sandbox, 'node_modules', binaryName), { recursive: true });
    assert.throws(
      () => run(installed, ['--version'], options),
      error => error.status === 1 && /--include=optional/.test(error.stderr),
      'Missing optional packages must produce reinstall instructions',
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
