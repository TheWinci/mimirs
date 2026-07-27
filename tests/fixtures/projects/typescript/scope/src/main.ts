import { run } from "./worker";

function outer(): void {
  function helper(): void {}

  function nested(): void {
    helper();
  }

  nested();
}

function unrelated(): void {
  function helper(): void {}

  helper();
}

export function execute(run: () => void): void {
  run();
  outer();
  unrelated();
}
