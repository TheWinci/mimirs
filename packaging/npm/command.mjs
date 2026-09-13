import { execFileSync } from 'node:child_process';

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 600_000,
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
}
